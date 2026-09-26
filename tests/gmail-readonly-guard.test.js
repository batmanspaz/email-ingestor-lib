/**
 * Read-only account guard — GmailClient({ readOnly: true }).
 *
 * Background (Paul's HARD RULE, 2026-09-26): the emilee.stone@collagesoup.com
 * mailbox must NEVER be archived, labelled, filed, moved, marked read, trashed,
 * forwarded, or otherwise modified by any ingestor. Until now that held only by
 * convention (archiveAfterProcess:false, FORWARD_RULES=[] and a handful of
 * per-call-site flags). This suite pins an ENFORCED guard at the one place every
 * Gmail write in this library passes through: the googleapis client held in
 * GmailClient._gmail.
 *
 * Contract:
 *   1. A client built with readOnly:true refuses EVERY state-changing Gmail call
 *      (messages.modify/batchModify/trash/untrash/delete/insert/import/send,
 *      drafts.*, labels.create/update/delete, threads.modify/trash, settings.*,
 *      users.watch/stop) — the API function is never invoked, the call throws a
 *      ReadOnlyAccountError (code READ_ONLY_ACCOUNT), and the denial is logged
 *      with the address masked.
 *   2. The guard is an ALLOWLIST of read verbs (get / list / getProfile), so a
 *      Gmail method this suite has never heard of is denied too (fail closed).
 *   3. Reads keep working: getProfile, history.list, messages.get/list,
 *      attachments.get, labels.list — the ingestor's whole job.
 *   4. It also catches code that bypasses the GmailClient methods and reaches
 *      for client._gmail directly (poll.js's batch-archive does exactly that).
 *   5. A default (non-readOnly) client is completely unchanged.
 *   6. fromTokenFile(account, entity, { readOnly }) threads the flag through
 *      (gmail-readonly-fromtokenfile.test.js).
 *   7. poll() never even attempts the batch archive for a readOnly client, and
 *      checkAndForward() declines to forward from one (no thrown error, so the
 *      message is not retried into quarantine).
 *
 * googleapis is mocked; every value is synthetic. (fromTokenFile threading is in
 * gmail-readonly-fromtokenfile.test.js, which needs an fs mock this file cannot have.)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { apiCalls } = vi.hoisted(() => ({ apiCalls: [] }));

vi.mock('googleapis', () => {
  function OAuth2() {
    this.setCredentials = () => {};
  }
  // Prototype methods that depend on `this` — like the real googleapis
  // resource classes — so a guard that loses `this` fails loudly here.
  const make = (name) =>
    class {
      constructor() { this.context = { ok: true }; }
    };
  const resource = (path, verbs) => {
    const C = make(path);
    for (const v of verbs) {
      C.prototype[v] = function (params) {
        if (!this.context?.ok) throw new Error('lost this');
        apiCalls.push(`${path}.${v}`);
        return Promise.resolve({ data: { messages: [], labels: [], historyId: '1' } });
      };
    }
    return new C();
  };
  const users = {
    context: { ok: true },
    getProfile() { apiCalls.push('users.getProfile'); return Promise.resolve({ data: { historyId: '1' } }); },
    watch() { apiCalls.push('users.watch'); return Promise.resolve({}); },
    stop() { apiCalls.push('users.stop'); return Promise.resolve({}); },
    messages: Object.assign(
      resource('users.messages', ['get', 'list', 'modify', 'batchModify', 'trash', 'untrash', 'delete',
        'batchDelete', 'insert', 'import', 'send', 'someFutureMethod']),
      { attachments: resource('users.messages.attachments', ['get']) },
    ),
    threads: resource('users.threads', ['get', 'list', 'modify', 'trash', 'untrash', 'delete']),
    labels: resource('users.labels', ['get', 'list', 'create', 'update', 'patch', 'delete']),
    drafts: resource('users.drafts', ['get', 'list', 'create', 'update', 'delete', 'send']),
    history: resource('users.history', ['list']),
    settings: {
      filters: resource('users.settings.filters', ['list', 'create', 'delete']),
      forwardingAddresses: resource('users.settings.forwardingAddresses', ['list', 'create', 'delete']),
      updateAutoForwarding() { apiCalls.push('users.settings.updateAutoForwarding'); return Promise.resolve({}); },
    },
  };
  // getProfile/watch/stop etc. must run with `this` = users too
  // Real googleapis defines `users` as a read-only, NON-configurable data property;
  // a Proxy that targets the real object then violates the get-trap invariant and
  // throws TypeError on first access (found by a smoke test against the real lib).
  const gmail = vi.fn().mockImplementation(() => {
    const root = { context: { ok: true } };
    Object.defineProperty(root, 'users', { value: users, writable: false, configurable: false, enumerable: true });
    return root;
  });
  // readOnly clients are built from their own GoogleApis instance, not the singleton.
  function GoogleApis() { this.auth = { OAuth2 }; this.gmail = gmail; }
  return { google: { auth: { OAuth2 }, gmail }, GoogleApis };
});

import { GmailClient } from '../gmail.js';
import { ReadOnlyAccountError } from '../readonly-guard.js';
import { checkAndForward } from '../forward.js';
import { poll } from '../poll.js';

const ADDR = 'read.only.person@example.com';
const cfg = (extra = {}) => ({
  account: ADDR, refreshToken: 'FAKE-refresh', clientId: 'FAKE-id', clientSecret: 'FAKE-secret', ...extra,
});

let errSpy;
beforeEach(() => {
  apiCalls.length = 0;
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { errSpy.mockRestore(); });

describe('readOnly client — every write is refused', () => {
  const rejects = async (fn) => {
    await expect(Promise.resolve().then(fn)).rejects.toMatchObject({
      name: 'ReadOnlyAccountError', code: 'READ_ONLY_ACCOUNT',
    });
  };

  it('exposes readOnly:true', () => {
    expect(new GmailClient(cfg({ readOnly: true })).readOnly).toBe(true);
    expect(new GmailClient(cfg()).readOnly).toBe(false);
  });

  it.each([
    ['markRead', c => c.markRead('m1')],
    ['addLabels', c => c.addLabels('m1', ['L'])],
    ['removeLabels', c => c.removeLabels('m1', ['UNREAD'])],
    ['archive', c => c.archive('m1')],
    ['labelAndArchive', c => c.labelAndArchive('m1', ['L'])],
    ['trash', c => c.trash('m1')],
    ['createDraft', c => c.createDraft({ to: 'x@example.com', subject: 's', body: 'b' })],
    ['sendEmail', c => c.sendEmail({ to: 'x@example.com', subject: 's', body: 'b' })],
    ['forwardEmail', c => c.forwardEmail('m1', 'x@example.com')],
  ])('GmailClient.%s throws and never reaches the API', async (_n, call) => {
    const c = new GmailClient(cfg({ readOnly: true }));
    await rejects(() => call(c));
    expect(apiCalls.filter(x => !/\.(get|list)$|getProfile/.test(x))).toEqual([]);
  });

  it.each([
    'messages.modify', 'messages.batchModify', 'messages.trash', 'messages.untrash', 'messages.delete',
    'messages.batchDelete', 'messages.insert', 'messages.import', 'messages.send',
    'messages.someFutureMethod',
    'threads.modify', 'threads.trash', 'threads.untrash', 'threads.delete',
    'labels.create', 'labels.update', 'labels.patch', 'labels.delete',
    'drafts.create', 'drafts.update', 'drafts.delete', 'drafts.send',
    'settings.filters.create', 'settings.filters.delete',
    'settings.forwardingAddresses.create', 'settings.forwardingAddresses.delete',
    'settings.updateAutoForwarding',
    'watch', 'stop',
  ])('raw client._gmail.users.%s is denied (bypass of GmailClient methods)', async (p) => {
    const c = new GmailClient(cfg({ readOnly: true }));
    const fn = p.split('.').reduce((o, k) => o[k], c._gmail.users);
    await rejects(() => fn({ userId: 'me', id: 'm1', requestBody: {} }));
    expect(apiCalls).toEqual([]);
  });

  it('logs each denial to console.error with the address masked', async () => {
    const c = new GmailClient(cfg({ readOnly: true }));
    await c.archive('m1').catch(() => {});
    const line = errSpy.mock.calls.map(a => a.join(' ')).join('\n');
    expect(line).toMatch(/READ-ONLY/i);
    expect(line).toMatch(/messages\.modify/);
    expect(line).toContain('r***@example.com');
    expect(line).not.toContain(ADDR);
  });

  it('ReadOnlyAccountError is an Error subclass', () => {
    const e = new ReadOnlyAccountError('a@b.co', 'users.messages.modify');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('READ_ONLY_ACCOUNT');
    expect(e.message).not.toContain('a@b.co');
  });
});

describe('readOnly client — reads keep working', () => {
  it('getProfile / history.list / messages.get+list / attachments.get / labels.list', async () => {
    const c = new GmailClient(cfg({ readOnly: true }));
    await c.getCurrentHistoryId();
    await c._gmail.users.history.list({ userId: 'me', startHistoryId: '1' });
    await c._gmail.users.messages.get({ userId: 'me', id: 'm1' });
    await c._gmail.users.messages.list({ userId: 'me' });
    await c._gmail.users.messages.attachments.get({ userId: 'me', messageId: 'm1', id: 'a' });
    await c.listLabels();
    expect(apiCalls).toEqual([
      'users.getProfile', 'users.history.list', 'users.messages.get', 'users.messages.list',
      'users.messages.attachments.get', 'users.labels.list',
    ]);
    expect(errSpy).not.toHaveBeenCalled();
  });
});

describe('default client is unchanged', () => {
  it('still performs writes', async () => {
    const c = new GmailClient(cfg());
    await c.markRead('m1');
    await c.trash('m1');
    await c.addLabels('m1', ['L']);
    expect(apiCalls).toEqual(['users.messages.modify', 'users.messages.trash', 'users.messages.modify']);
  });
});

describe('checkAndForward — readOnly client', () => {
  const msg = { id: 'm1', snippet: 'perfectcity', payload: { headers: [{ name: 'Subject', value: 'perfectcity' }] } };
  it('declines to forward, does not throw, does not call forwardEmail', async () => {
    const client = { readOnly: true, account: ADDR, forwardEmail: vi.fn() };
    const rules = [{ patterns: ['perfectcity'], target: 't@example.com', label: 'pc' }];
    const r = await checkAndForward(msg, client, rules);
    expect(r).toMatchObject({ forwarded: false, denied: true });
    expect(client.forwardEmail).not.toHaveBeenCalled();
  });
});

describe('poll — readOnly client is never batch-archived', () => {
  it('archiveAfterProcess:true + readOnly => batchModify not attempted', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-poll-'));
    const statePath = path.join(tmp, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({
      accounts: { [ADDR]: { lastHistoryId: '100', lastRunAt: new Date().toISOString() } }, totalProcessed: 0,
    }));
    const batchModify = vi.fn().mockResolvedValue({});
    const meta = {
      id: 'm1', labelIds: ['INBOX'], snippet: '',
      payload: { headers: [{ name: 'Message-ID', value: '<m1@x>' }, { name: 'From', value: 'a@b.co' }] },
    };
    const client = {
      account: ADDR, readOnly: true,
      getCurrentHistoryId: vi.fn().mockResolvedValue('200'),
      getHistory: vi.fn().mockResolvedValue({
        ids: ['m1'], truncated: false, historyIdById: { m1: '150' }, lastEnumeratedHistoryId: '150',
      }),
      fetchMetadata: vi.fn().mockResolvedValue(meta),
      _gmail: { users: { messages: { batchModify } } },
    };
    const stats = await poll(
      { clients: [{ client, label: 'ro' }], statePath, archiveAfterProcess: true },
      async () => 'processed',
    );
    expect(stats.processed).toBe(1);
    expect(batchModify).not.toHaveBeenCalled();
    expect(stats.archived).toBe(0);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
