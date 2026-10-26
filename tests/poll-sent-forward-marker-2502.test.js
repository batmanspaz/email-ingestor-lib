/**
 * tasks.db #2502 — gate before Sent ingestion goes shadow -> on (Fable F1, review of lib #85).
 *
 * Intake's own forwards (GmailClient.forwardEmail, called by checkAndForward / the personal sluice
 * producer) are sent From = the polled account, To = another entity's mailbox, and before this fix
 * carried no Auto-Submitted / Precedence / List-* header. So with `ingestSent: true` every machine
 * forward landed in SENT, passed both screens (not automated, not self-only), and was handed to the
 * handler as Paul's own outbound mail: inbound -> forward -> re-ingested as "sent". In shadow it only
 * inflated `sentShadowWouldIngest`.
 *
 * Fix: forwardEmail stamps `Auto-Submitted: auto-forwarded` (RFC 3834; the screen already honours any
 * value but "no") AND a distinctive `X-Intake-Forwarded: 1`; the Sent screen requests and honours the
 * X- marker on its own too, so a forward is screened even if a relay rewrote Auto-Submitted.
 * Forwards are counted as automated (`sentSkippedAuto` / `sentShadowWouldSkip`).
 *
 * The round-trip tests drive the REAL forwardEmail (Gmail transport faked) and feed what it actually
 * wrote back through poll() via a fetchMetadata fake that, like Gmail's format:'metadata', returns
 * ONLY the requested headers — so the test fails if poll() stops asking for the marker.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { poll } from '../poll.js';
import { GmailClient, INTAKE_FORWARD_HEADER } from '../gmail.js';

let tmpDir;
let statePath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-sent-fwd-marker-test-'));
  statePath = path.join(tmpDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({ accounts: { [ME]: { lastHistoryId: '2000' } }, totalProcessed: 0 }), 'utf8');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const ME = 'me@example.com';
const OTHER_ENTITY = 'shop@entity.example';
const DEFAULT_METADATA_HEADERS = ['Subject', 'From', 'Date', 'To', 'Message-ID'];

/** Top-level RFC 822 headers of a raw message (stops at the first blank line), unfolded. */
function topHeaders(raw) {
  const head = raw.split(/\r?\n\r?\n/)[0];
  return head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/).map(line => {
    const i = line.indexOf(':');
    return { name: line.slice(0, i).trim(), value: line.slice(i + 1).trim() };
  });
}

const decodeB64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');

/** Run the REAL GmailClient#forwardEmail against a faked transport; return the headers it sent. */
async function headersOfRealForward() {
  const client = new GmailClient({ account: ME, refreshToken: 'rt_fake', clientId: 'cid_fake', clientSecret: 'cs_fake' });
  const send = vi.fn().mockResolvedValue({ data: { id: 'fwd-sent-1' } });
  const original = 'From: Vendor <v@vendor.example>\r\nTo: me@example.com\r\nSubject: Invoice 42\r\n\r\nPlease pay.';
  client._gmail = {
    users: {
      messages: {
        get: vi.fn().mockImplementation(async ({ format }) => (format === 'raw'
          ? { data: { raw: Buffer.from(original).toString('base64') } }
          : { data: { id: 'in-1', snippet: 'Please pay.', payload: { headers: [
            { name: 'Subject', value: 'Invoice 42' }, { name: 'From', value: 'Vendor <v@vendor.example>' },
          ] } } })),
        send,
      },
    },
  };
  await client.forwardEmail('in-1', OTHER_ENTITY);
  expect(send).toHaveBeenCalledOnce();
  return topHeaders(decodeB64url(send.mock.calls[0][0].requestBody.raw));
}

/** What Gmail stores in SENT for that forward: its headers plus a Message-ID, label SENT. */
function sentCopy(id, headers) {
  return { id, labelIds: ['SENT'], snippet: '', payload: { headers: [...headers, { name: 'Message-ID', value: `<${id}@mail.gmail.com>` }] } };
}

/** A message Paul himself wrote to a real contact. */
function paulSent(id, extra = []) {
  return sentCopy(id, [
    { name: 'From', value: `Paul <${ME}>` },
    { name: 'To', value: 'Client <client@other.example>' },
    { name: 'Subject', value: 'Re: proposal' },
    ...extra,
  ]);
}

/** A mock client whose fetchMetadata returns ONLY the requested headers, like Gmail's format:'metadata'. */
function makeClient(messages) {
  const byId = Object.fromEntries(messages.map(m => [m.id, m]));
  const ids = messages.map(m => m.id);
  const historyIdById = Object.fromEntries(ids.map((id, i) => [id, String(100 + i)]));
  return {
    account: ME,
    getCurrentHistoryId: vi.fn().mockResolvedValue('3000'),
    getHistory: vi.fn().mockResolvedValue({ ids, truncated: false, historyIdById, lastEnumeratedHistoryId: ids.length ? historyIdById[ids.at(-1)] : null }),
    fetchMetadata: vi.fn().mockImplementation(async (id, opts) => {
      const wanted = new Set([...DEFAULT_METADATA_HEADERS, ...(opts?.extraHeaders || [])].map(h => h.toLowerCase()));
      const m = byId[id];
      return { ...m, payload: { headers: m.payload.headers.filter(h => wanted.has(h.name.toLowerCase())) } };
    }),
    _gmail: { users: { messages: { batchModify: vi.fn().mockResolvedValue({}) } } },
  };
}

async function run(messages, ingestSent) {
  const client = makeClient(messages);
  const handler = vi.fn().mockResolvedValue('processed');
  const stats = await poll({ clients: [{ client, label: 'A', ingestSent }], statePath }, handler);
  return { stats, handler, client };
}

const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));

describe('#2502 forwardEmail marks every forward it sends', () => {
  it('exports the marker header name', () => {
    expect(INTAKE_FORWARD_HEADER).toBe('X-Intake-Forwarded');
  });

  it('stamps Auto-Submitted: auto-forwarded and X-Intake-Forwarded: 1 as TOP-LEVEL headers', async () => {
    const h = await headersOfRealForward();
    const get = (n) => h.filter(x => x.name.toLowerCase() === n.toLowerCase()).map(x => x.value);
    expect(get('Auto-Submitted')).toEqual(['auto-forwarded']);
    expect(get('X-Intake-Forwarded')).toEqual(['1']);
    // Unchanged addressing: still From the polled account to the other entity.
    expect(get('From')).toEqual([ME]);
    expect(get('To')).toEqual([OTHER_ENTITY]);
  });

  it('createDraft (a message Paul sends himself) is NOT marked', async () => {
    const client = new GmailClient({ account: ME, refreshToken: 'rt_fake', clientId: 'cid_fake', clientSecret: 'cs_fake' });
    const create = vi.fn().mockResolvedValue({ data: { id: 'd1', message: { threadId: 't1' } } });
    client._gmail = { users: { drafts: { create } } };
    await client.createDraft({ to: 'client@other.example', subject: 'S', body: 'B' });
    const raw = decodeB64url(create.mock.calls[0][0].requestBody.message.raw);
    expect(raw).not.toMatch(/^Auto-Submitted:/mi);
    expect(raw).not.toMatch(/^X-Intake-Forwarded:/mi);
  });
});

describe('#2502 ingestSent:true — a system forward is never ingested as Paul\'s outbound mail', () => {
  it('round trip: what forwardEmail wrote is skipped (counted auto), a real Paul-sent message still counts', async () => {
    const fwd = sentCopy('fwd1', await headersOfRealForward());
    const { stats, handler } = await run([fwd, paulSent('real1')], true);
    expect(handler.mock.calls.map(c => c[0].id)).toEqual(['real1']);
    expect(stats.sentIngested).toBe(1);
    expect(stats.sentSkippedAuto).toBe(1);
    expect(stats.sentSkippedSelf).toBe(0);
    // Skipped forwards are ringed like any screened id (never refetched).
    expect(readState().accounts[ME].processedIds).toEqual(expect.arrayContaining(['fwd1', 'real1']));
  });

  it('the X-Intake-Forwarded marker alone is enough (Auto-Submitted stripped or rewritten in transit)', async () => {
    const fwd = sentCopy('fwd2', [
      { name: 'From', value: ME }, { name: 'To', value: OTHER_ENTITY }, { name: 'Subject', value: 'Fwd: x' },
      { name: 'X-Intake-Forwarded', value: '1' },
    ]);
    const { stats, handler } = await run([fwd], true);
    expect(handler).not.toHaveBeenCalled();
    expect(stats.sentSkippedAuto).toBe(1);
    expect(stats.sentIngested).toBe(0);
  });

  it('requests the marker header in the metadata fetch (Gmail returns only what is asked for)', async () => {
    const { client } = await run([paulSent('real1')], true);
    expect(client.fetchMetadata.mock.calls[0][1].extraHeaders).toEqual(expect.arrayContaining(['X-Intake-Forwarded', 'Auto-Submitted']));
  });

  it('a Paul-sent message with an empty marker value is still real outbound mail', async () => {
    const { stats, handler } = await run([paulSent('real2', [{ name: 'X-Intake-Forwarded', value: '' }])], true);
    expect(handler).toHaveBeenCalledOnce();
    expect(stats.sentIngested).toBe(1);
    expect(stats.sentSkippedAuto).toBe(0);
  });
});

describe('#2502 ingestSent:\'shadow\' — counters reflect the marker exactly as the live path would', () => {
  it('a forward counts as would-skip, a real Paul-sent message as would-ingest; nothing is handled', async () => {
    const fwd = sentCopy('fwd1', await headersOfRealForward());
    const { stats, handler } = await run([fwd, paulSent('real1'), paulSent('real2')], 'shadow');
    expect(handler).not.toHaveBeenCalled();
    expect(stats.sentShadowWouldIngest).toBe(2);
    expect(stats.sentShadowWouldSkip).toBe(1);
    // Live counters untouched in shadow.
    expect(stats.sentIngested).toBe(0);
    expect(stats.sentSkippedAuto).toBe(0);
    expect(stats.sentSkippedSelf).toBe(0);
  });

  it('the X- marker alone counts as would-skip in shadow too', async () => {
    const fwd = sentCopy('fwd3', [
      { name: 'From', value: ME }, { name: 'To', value: OTHER_ENTITY }, { name: 'Subject', value: 'Fwd: y' },
      { name: 'X-Intake-Forwarded', value: '1' },
    ]);
    const { stats } = await run([fwd], 'shadow');
    expect(stats.sentShadowWouldSkip).toBe(1);
    expect(stats.sentShadowWouldIngest).toBe(0);
  });
});
