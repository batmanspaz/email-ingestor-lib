/**
 * gmail.js — GmailClient for email ingestors (ESM, OAuth2 refresh-token based)
 *
 * Two ways to construct:
 *   1. GmailClient.fromTokenFile(account, entity) — reads token file + client credentials from
 *      ~/claude/shared/config/credentials/{account}.json and conductor_paul_client.json
 *   2. new GmailClient({ account, refreshToken, clientId, clientSecret, entity }) — explicit
 */

import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import os from 'os';

const CRED_DIR = path.join(os.homedir(), 'claude/shared/config/credentials');
const CLIENT_FILE = path.join(CRED_DIR, 'conductor_paul_client.json');

/**
 * Retry a Gmail API call with exponential backoff on 429 / 5xx / network errors.
 * Non-retryable errors (401, 403, 404) bubble up immediately.
 */
async function withRetry(fn, label = 'gmail') {
  const MAX_ATTEMPTS = 4;
  let attempt = 0;
  let lastErr;
  while (attempt < MAX_ATTEMPTS) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const code = err.code || err.response?.status;
      const retryable = code === 429 || code === 500 || code === 502 || code === 503 || code === 504
        || /ECONN|ETIMEDOUT|ENOTFOUND|socket hang up/i.test(err.message || '');
      if (!retryable) throw err;
      attempt++;
      if (attempt >= MAX_ATTEMPTS) break;
      const backoffMs = Math.min(30000, 500 * Math.pow(2, attempt)) + Math.floor(Math.random() * 250);
      console.warn(`  [${label}] retryable error ${code || err.message} — attempt ${attempt}/${MAX_ATTEMPTS}, backing off ${backoffMs}ms`);
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
  throw lastErr;
}

/** Hard cap on ids enumerated per getHistory() call — runaway-cost guard on an
 *  inbox surge. Hitting it is not lossy so long as the caller honours
 *  `truncated`; it just means the window drains over several runs. */
const MAX_HISTORY_IDS_PER_CALL = 500;

export class GmailClient {
  /**
   * @param {object} config
   * @param {string} config.account       — email address
   * @param {string} config.refreshToken  — Gmail OAuth2 refresh token
   * @param {string} config.clientId      — OAuth2 client ID
   * @param {string} config.clientSecret  — OAuth2 client secret
   * @param {string} [config.entity]      — entity name for logging
   */
  constructor(config) {
    if (!config?.account) throw new Error('GmailClient: account required');
    if (!config?.refreshToken) throw new Error('GmailClient: refreshToken required');
    if (!config?.clientId) throw new Error('GmailClient: clientId required');
    if (!config?.clientSecret) throw new Error('GmailClient: clientSecret required');

    this.account = config.account;
    this.entity = config.entity || 'Unknown';

    this._oauth2 = new google.auth.OAuth2(config.clientId, config.clientSecret);
    this._oauth2.setCredentials({ refresh_token: config.refreshToken });
    this._gmail = google.gmail({ version: 'v1', auth: this._oauth2 });
  }

  /**
   * Create a GmailClient from on-disk token + client credential files.
   * Reads ~/claude/shared/config/credentials/{account}.json for refresh_token
   * and conductor_paul_client.json for client_id/client_secret.
   *
   * @param {string} account — email address (e.g. paulallensteinberg@gmail.com)
   * @param {string} [entity] — entity name for logging
   * @returns {GmailClient}
   */
  static fromTokenFile(account, entity) {
    // Load client credentials
    if (!fs.existsSync(CLIENT_FILE)) {
      throw new Error(`OAuth client file not found: ${CLIENT_FILE}`);
    }
    const clientCreds = JSON.parse(fs.readFileSync(CLIENT_FILE, 'utf8'));
    const clientId = clientCreds.installed?.client_id || clientCreds.client_id;
    const clientSecret = clientCreds.installed?.client_secret || clientCreds.client_secret;

    if (!clientId || !clientSecret) {
      throw new Error(`Invalid client credentials in ${CLIENT_FILE}`);
    }

    // Load account token file
    const tokenFile = path.join(CRED_DIR, `${account}.json`);
    if (!fs.existsSync(tokenFile)) {
      throw new Error(`Token file not found: ${tokenFile} — run OAuth flow for ${account}`);
    }
    const tokenData = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    const refreshToken = tokenData.refresh_token;

    if (!refreshToken) {
      throw new Error(`No refresh_token in ${tokenFile} — re-run OAuth flow for ${account}`);
    }

    return new GmailClient({ account, refreshToken, clientId, clientSecret, entity });
  }

  /** Extract a header value from a Gmail message */
  static getHeader(message, name) {
    const h = message.payload?.headers?.find(
      h => h.name.toLowerCase() === name.toLowerCase()
    );
    return h?.value || '';
  }

  /** Get current historyId without fetching messages */
  async getCurrentHistoryId() {
    const res = await withRetry(() => this._gmail.users.getProfile({ userId: 'me' }), `${this.account}:getProfile`);
    return res.data.historyId;
  }

  /**
   * Get message IDs added since startHistoryId.
   * Returns null if history expired (caller should reset).
   *
   * @returns {Promise<null|{ids:string[], truncated:boolean,
   *   historyIdById:Record<string,string>, lastEnumeratedHistoryId:string|null}>}
   *
   * `truncated` is the contract that matters. Before 2026-08-23 this returned a
   * bare array, so a caller could not tell 500-of-500 from 500-of-5000 — poll()
   * read a fully-drained window as "caught up" and advanced its cursor past
   * messages that had never been listed. 44 real losses on personal. A caller
   * cannot be written correctly against a value that cannot express the failure.
   */
  async getHistory(startHistoryId) {
    const ids = [];
    const historyIdById = {};
    let lastEnumeratedHistoryId = null;
    let truncated = false;
    let unattributableRecord = false;
    let pageToken = null;

    try {
      do {
        // No labelId filter (2026-08-04): history.list's labelId reflects
        // CURRENT labels, so triage-archived mail silently vanished from the
        // window before ever being enveloped. poll.js screens SENT/DRAFT/
        // SPAM/TRASH per message instead.
        const res = await withRetry(() => this._gmail.users.history.list({
          userId: 'me',
          startHistoryId,
          historyTypes: ['messageAdded'],
          maxResults: 500,
          pageToken: pageToken || undefined,
        }), `${this.account}:history.list`);
        for (const record of res.data.history || []) {
          // record.id is the record's historyId. It was previously discarded,
          // which is precisely why the caller could not build a safe cursor.
          //
          // A record with NO id cannot be attributed, and emitting its messages
          // anyway would hand the caller ids it can never place: poll() would
          // refuse to advance, on this run and every run after, and quarantine
          // could not rescue it because those messages are not failing — just
          // unplaceable. So end the window here instead. Everything before this
          // record is still enumerated and drainable, and the caller sees
          // ordinary truncation, which it already knows how to make progress
          // through, rather than a silent permanent wedge.
          if (!record.id) {
            truncated = true;
            unattributableRecord = true;
            break;
          }
          lastEnumeratedHistoryId = String(record.id);
          for (const item of record.messagesAdded || []) {
            if (item.message?.id) {
              ids.push(item.message.id);
              historyIdById[item.message.id] = String(record.id);
            }
          }
        }
        if (unattributableRecord) {
          console.warn(
            `[gmail] history.list returned a record with no id for ${this.account} —` +
            ` window ended early at ${lastEnumeratedHistoryId ?? 'the start'} to keep every` +
            ` returned id attributable to a record.`,
          );
          break;
        }
        pageToken = res.data.nextPageToken || null;
        // Hard cap: runaway-cost guard on an inbox surge. "Truncated" means we
        // stopped early AND more was waiting — 500-of-500 with no next page is a
        // COMPLETE window. Conflating the two is what hid the 2026-08-23 loss;
        // the full account of it lives in poll.js's nextCursor().
        if (ids.length >= MAX_HISTORY_IDS_PER_CALL && pageToken) {
          truncated = true;
          console.warn(
            `[gmail] history.list hit ${MAX_HISTORY_IDS_PER_CALL}-message cap for ${this.account}` +
            ` — window TRUNCATED; caller must not advance its cursor past the last handled message`,
          );
          break;
        }
      } while (pageToken);
    } catch (err) {
      if (err.code === 404 || err.message?.includes('404')) {
        return null;
      }
      throw err;
    }

    return { ids, truncated, historyIdById, lastEnumeratedHistoryId };
  }

  /** Fetch a single full message by ID */
  async fetchMessage(id) {
    const res = await withRetry(() => this._gmail.users.messages.get({
      userId: 'me',
      id,
      format: 'full',
    }), `${this.account}:messages.get(full)`);
    return res.data;
  }

  /** Fetch message metadata only (lighter) */
  async fetchMetadata(id) {
    const res = await withRetry(() => this._gmail.users.messages.get({
      userId: 'me',
      id,
      format: 'metadata',
      metadataHeaders: ['Subject', 'From', 'Date', 'To', 'Message-ID'],
    }), `${this.account}:messages.get(metadata)`);
    return res.data;
  }

  /** Fetch attachment bytes as Buffer */
  async fetchAttachment(messageId, attachmentId) {
    const res = await this._gmail.users.messages.attachments.get({
      userId: 'me',
      messageId,
      id: attachmentId,
    });
    const b64 = res.data.data.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(b64, 'base64');
  }

  /** Mark a message as read */
  async markRead(id) {
    await this._gmail.users.messages.modify({
      userId: 'me',
      id,
      requestBody: { removeLabelIds: ['UNREAD'] },
    });
    return { ok: true, id };
  }

  /** Add labels to a message */
  async addLabels(id, labelIds) {
    await this._gmail.users.messages.modify({
      userId: 'me',
      id,
      requestBody: { addLabelIds: labelIds },
    });
    return { ok: true, id };
  }

  /** Remove labels from a message */
  async removeLabels(id, labelIds) {
    await this._gmail.users.messages.modify({
      userId: 'me',
      id,
      requestBody: { removeLabelIds: labelIds },
    });
    return { ok: true, id };
  }

  /** Archive a message (remove INBOX label) */
  async archive(id) {
    return this.removeLabels(id, ['INBOX']);
  }

  /** Label and archive a message */
  async labelAndArchive(id, labelIds) {
    await this._gmail.users.messages.modify({
      userId: 'me',
      id,
      requestBody: { addLabelIds: labelIds, removeLabelIds: ['INBOX', 'UNREAD'] },
    });
    return { ok: true, id };
  }

  /** List all labels */
  async listLabels() {
    const res = await this._gmail.users.labels.list({ userId: 'me' });
    return res.data.labels || [];
  }

  /** Find a label by name, return its ID */
  async findLabelId(name) {
    const labels = await this.listLabels();
    const label = labels.find(l => l.name === name);
    return label?.id || null;
  }

  /** Forward a message to another address */
  async forwardEmail(messageId, toAddress) {
    const original = await this.fetchMessage(messageId);
    const subject = GmailClient.getHeader(original, 'Subject');
    const from = GmailClient.getHeader(original, 'From');

    const boundary = `boundary_${Date.now()}`;
    const rawOriginal = await this._gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'raw',
    });

    const emailLines = [
      `From: ${this.account}`,
      `To: ${toAddress}`,
      `Subject: Fwd: ${subject}`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      `---------- Forwarded message ----------`,
      `From: ${from}`,
      `Subject: ${subject}`,
      '',
      original.snippet || '',
      '',
      `--${boundary}`,
      'Content-Type: message/rfc822',
      'Content-Disposition: attachment; filename="forwarded.eml"',
      '',
      Buffer.from(rawOriginal.data.raw, 'base64').toString('utf-8'),
      `--${boundary}--`,
    ];

    const raw = Buffer.from(emailLines.join('\r\n'))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const res = await this._gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw },
    });

    return { ok: true, id: res.data.id, forwarded_to: toAddress };
  }

  /**
   * Create a Gmail draft, optionally as a reply to an existing message.
   *
   * @param {object} opts
   * @param {string|string[]} opts.to          — recipient(s)
   * @param {string}          opts.subject     — subject line
   * @param {string}          opts.body        — plain-text body
   * @param {string}          [opts.cc]        — cc address(es)
   * @param {string}          [opts.threadId]  — Gmail thread ID (to thread the draft)
   * @param {string}          [opts.inReplyTo] — Message-ID header of the email being replied to
   * @param {string}          [opts.references] — References header chain
   * @returns {{ ok: boolean, draftId: string, threadId: string }}
   */
  async createDraft({ to, subject, body, cc, threadId, inReplyTo, references }) {
    const toStr = Array.isArray(to) ? to.join(', ') : to;
    const lines = [
      `From: ${this.account}`,
      `To: ${toStr}`,
      cc ? `Cc: ${Array.isArray(cc) ? cc.join(', ') : cc}` : null,
      `Subject: ${subject}`,
      inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
      references ? `References: ${references}` : null,
      'Content-Type: text/plain; charset="UTF-8"',
      'MIME-Version: 1.0',
      '',
      body,
    ].filter(Boolean);

    const raw = Buffer.from(lines.join('\r\n'))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const requestBody = { message: { raw } };
    if (threadId) requestBody.message.threadId = threadId;

    const res = await withRetry(() => this._gmail.users.drafts.create({
      userId: 'me',
      requestBody,
    }), `${this.account}:drafts.create`);

    return {
      ok: true,
      draftId: res.data.id,
      threadId: res.data.message?.threadId || threadId,
    };
  }

  /** Move a message to trash */
  async trash(id) {
    await this._gmail.users.messages.trash({ userId: 'me', id });
    return { ok: true, id };
  }

  /**
   * List recent messages from a specific label (not history-based).
   * Used for sent mail scanning where history API filters to INBOX.
   *
   * @param {string} labelId — Gmail label ID (e.g. 'SENT')
   * @param {number} maxResults
   * @returns {Promise<string[]>} — array of message IDs
   */
  async listMessagesByLabel(labelId, maxResults = 25) {
    const res = await withRetry(
      () => this._gmail.users.messages.list({
        userId: 'me',
        labelIds: [labelId],
        maxResults,
      }),
      `${this.account}:messages.list:${labelId}`
    );
    return (res.data.messages || []).map(m => m.id);
  }

  /** List recent inbox messages (up to limit) */
  async listInbox(limit = 30) {
    const res = await this._gmail.users.messages.list({
      userId: 'me',
      labelIds: ['INBOX'],
      maxResults: Math.min(limit, 100),
    });
    const messages = [];
    for (const msg of (res.data.messages || []).slice(0, limit)) {
      const detail = await this.fetchMetadata(msg.id);
      const headers = detail.payload?.headers || [];
      messages.push({
        id: msg.id,
        threadId: detail.threadId,
        subject: headers.find(h => h.name === 'Subject')?.value || '(no subject)',
        from: headers.find(h => h.name === 'From')?.value || '(unknown)',
        date: headers.find(h => h.name === 'Date')?.value || '',
        snippet: detail.snippet || '',
        labels: detail.labelIds || [],
        isUnread: (detail.labelIds || []).includes('UNREAD'),
      });
    }
    return messages;
  }

  /** Get unread messages (up to limit) */
  async getUnread(limit = 20) {
    const res = await this._gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread',
      maxResults: Math.min(limit, 100),
    });

    const messages = [];
    for (const msg of (res.data.messages || []).slice(0, limit)) {
      const detail = await this.fetchMetadata(msg.id);
      const headers = detail.payload?.headers || [];
      messages.push({
        id: msg.id,
        subject: headers.find(h => h.name === 'Subject')?.value || '(no subject)',
        from: headers.find(h => h.name === 'From')?.value || '(unknown)',
        date: headers.find(h => h.name === 'Date')?.value || '',
        snippet: detail.snippet || '',
        labels: detail.labelIds || [],
      });
    }
    return messages;
  }

  /** Get email summary: unread count + recent messages */
  async getEmailSummary() {
    try {
      const unreadRes = await this._gmail.users.messages.list({
        userId: 'me',
        q: 'is:unread',
        maxResults: 1,
      });
      const unreadCount = unreadRes.data.resultSizeEstimate || 0;

      const recentRes = await this._gmail.users.messages.list({
        userId: 'me',
        maxResults: 10,
      });

      const recent = [];
      for (const msg of recentRes.data.messages || []) {
        const detail = await this.fetchMetadata(msg.id);
        const headers = detail.payload?.headers || [];
        recent.push({
          id: msg.id,
          subject: headers.find(h => h.name === 'Subject')?.value || '(no subject)',
          from: headers.find(h => h.name === 'From')?.value || '(unknown)',
          date: headers.find(h => h.name === 'Date')?.value || '',
          snippet: detail.snippet || '',
          labels: detail.labelIds || [],
        });
      }

      return { account: this.account, entity: this.entity, status: 'ok', unread: unreadCount, recent };
    } catch (e) {
      return { account: this.account, entity: this.entity, status: 'error', message: e.message };
    }
  }

  /** Send an email */
  async sendEmail({ to, subject, body, cc, bcc }) {
    const lines = [
      `From: ${this.account}`,
      `To: ${to}`,
      cc ? `Cc: ${cc}` : null,
      bcc ? `Bcc: ${bcc}` : null,
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      body,
    ].filter(Boolean);

    const raw = Buffer.from(lines.join('\r\n'))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const res = await this._gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw },
    });
    return { ok: true, id: res.data.id };
  }
}
