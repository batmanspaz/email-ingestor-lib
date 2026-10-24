/**
 * tasks.db #2421 — Sent mail has not been ingested since 2026-08-05.
 *
 * Root cause (git archaeology): lib 1681b77 (2026-08-04, the parked-cursor dup-storm fix) dropped
 * history.list's `labelId:'INBOX'` filter and, to keep the widened window from pulling in the whole
 * Sent folder, added a per-message screen in poll() that rings and skips EVERY message carrying the
 * SENT label. Before it, sent mail that also carried INBOX (self-sent mail, and sent replies Gmail
 * kept in the inbox thread) did reach producers with direction 'sent' — 46 such items in intake.db,
 * the last at 2026-08-05 02:59. After it: zero.
 *
 * Fix: a per-account `ingestSent` option on the client entry, DEFAULT FALSE. Off = the old screen,
 * unchanged. On = SENT mail goes through the SAME history cursor and processed ring (no second
 * cursor), DRAFT/SPAM/TRASH stay screened, and self-sent / automated sent mail is skipped and counted
 * so Intake's own digests can never feed back into Intake.
 *
 * Gmail is fully mocked (plain objects with the methods poll() touches).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { poll } from '../poll.js';
import { GmailClient } from '../gmail.js';
import {
  computeSentSilentCheck, reportProducerHealth, producerHealthStats, producerRunStats, trackProducerRun,
} from '../producer-health.js';
import { createTelemetry, HealthReportSchema, AnalyticsBatchSchema } from '@perfectcity/telemetry';

let tmpDir;
let statePath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-sent-test-'));
  statePath = path.join(tmpDir, 'state.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const ME = 'me@example.com';

function makeMeta({ id, messageId, from = 'Sender <s@example.com>', to = ME, cc, subject = 'Test', labelIds = ['INBOX', 'UNREAD'], extra = [] }) {
  const headers = [
    { name: 'Message-ID', value: messageId ?? `<${id}@mail.example.com>` },
    { name: 'From', value: from },
    { name: 'To', value: to },
    { name: 'Subject', value: subject },
  ];
  if (cc) headers.push({ name: 'Cc', value: cc });
  return { id, labelIds, snippet: '', payload: { headers: [...headers, ...extra] } };
}

/** A message Paul sent from ME to someone else. */
const sentTo = (id, to = 'Client <client@other.example>', more = {}) =>
  makeMeta({ id, from: `Paul <${ME}>`, to, labelIds: ['SENT'], ...more });

function historyResult(ids, { truncated = false, startAt = 100 } = {}) {
  const map = Object.fromEntries(ids.map((id, i) => [id, String(startAt + i)]));
  const last = ids.length ? map[ids[ids.length - 1]] : null;
  return { ids, truncated, historyIdById: map, lastEnumeratedHistoryId: last };
}

function makeClient({ account = ME, messages = [], currentHistoryId = '3000' } = {}) {
  const metaById = Object.fromEntries(messages.map(m => [m.id, m]));
  return {
    account,
    getCurrentHistoryId: vi.fn().mockResolvedValue(currentHistoryId),
    getHistory: vi.fn().mockResolvedValue(historyResult(messages.map(m => m.id))),
    fetchMetadata: vi.fn().mockImplementation(async id => metaById[id]),
    _gmail: { users: { messages: { batchModify: vi.fn().mockResolvedValue({}) } } },
  };
}

function seedState(accounts) {
  fs.writeFileSync(statePath, JSON.stringify({ accounts, totalProcessed: 0 }), 'utf8');
}
const readStateFile = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
const handledIds = (handler) => handler.mock.calls.map(c => c[0].id);

describe('#2421 poll_default_unchanged_screens_sent (ingestSent off = the old behaviour)', () => {
  it('screens SENT, rings it, calls fetchMetadata with the id ONLY, and adds no sent state', async () => {
    const messages = [makeMeta({ id: 'in1' }), sentTo('s1')];
    const client = makeClient({ messages });
    seedState({ [ME]: { lastHistoryId: '2000' } });
    const handler = vi.fn().mockResolvedValue('processed');

    const stats = await poll({ clients: [{ client, label: 'A' }], statePath }, handler);

    expect(handledIds(handler)).toEqual(['in1']);
    expect(readStateFile().accounts[ME].processedIds).toEqual(expect.arrayContaining(['in1', 's1']));
    // The metadata call is byte-identical to before: no second argument.
    for (const call of client.fetchMetadata.mock.calls) expect(call).toHaveLength(1);
    // No new per-account state keys when the option is off.
    expect(Object.keys(readStateFile().accounts[ME]).filter(k => /sent/i.test(k))).toEqual([]);
    expect(readStateFile().accounts[ME]).not.toHaveProperty('sentEnabledAt');
    expect(readStateFile().accounts[ME]).not.toHaveProperty('lastSentIngestedAt');
    // New counters are always present, at zero.
    expect(stats).toMatchObject({ sentIngested: 0, sentSkippedAuto: 0, sentSkippedSelf: 0, sentSilentAccounts: 0 });
  });

  it('ingestSent:false explicitly is the same as absent', async () => {
    const client = makeClient({ messages: [sentTo('s1')] });
    seedState({ [ME]: { lastHistoryId: '2000' } });
    const handler = vi.fn().mockResolvedValue('processed');
    await poll({ clients: [{ client, label: 'A', ingestSent: false }], statePath }, handler);
    expect(handler).not.toHaveBeenCalled();
  });

  it('a truthy NON-boolean (e.g. the string "false" from an env var) does NOT enable it', async () => {
    const client = makeClient({ messages: [sentTo('s1')] });
    seedState({ [ME]: { lastHistoryId: '2000' } });
    const handler = vi.fn().mockResolvedValue('processed');
    await poll({ clients: [{ client, label: 'A', ingestSent: 'false' }], statePath }, handler);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('#2421 poll_ingests_sent_when_account_ingestSent_true', () => {
  it('hands a SENT message to the handler and counts it', async () => {
    const messages = [makeMeta({ id: 'in1' }), sentTo('s1')];
    const client = makeClient({ messages });
    seedState({ [ME]: { lastHistoryId: '2000' } });
    const handler = vi.fn().mockResolvedValue('processed');

    const stats = await poll({ clients: [{ client, label: 'A', ingestSent: true }], statePath }, handler);

    expect(handledIds(handler)).toEqual(['in1', 's1']);
    expect(stats.processed).toBe(2);
    expect(stats.sentIngested).toBe(1);
    expect(stats.sentSkippedAuto).toBe(0);
  });

  it('is PER ACCOUNT: the other account in the same run keeps screening SENT', async () => {
    const a = makeClient({ account: ME, messages: [sentTo('a-s1')] });
    const b = makeClient({ account: 'b@example.com', messages: [makeMeta({ id: 'b-s1', from: 'b@example.com', to: 'x@other.example', labelIds: ['SENT'] })] });
    seedState({ [ME]: { lastHistoryId: '2000' }, 'b@example.com': { lastHistoryId: '2000' } });
    const handler = vi.fn().mockResolvedValue('processed');

    const stats = await poll({ clients: [{ client: a, label: 'A', ingestSent: true }, { client: b, label: 'B' }], statePath }, handler);

    expect(handledIds(handler)).toEqual(['a-s1']);
    expect(stats.sentIngested).toBe(1);
    expect(readStateFile().accounts['b@example.com'].processedIds).toContain('b-s1');
  });

  it('asks Gmail for the extra headers it needs to recognise automated mail, only for that account', async () => {
    const client = makeClient({ messages: [sentTo('s1')] });
    seedState({ [ME]: { lastHistoryId: '2000' } });
    await poll({ clients: [{ client, label: 'A', ingestSent: true }], statePath }, vi.fn().mockResolvedValue('processed'));
    const opts = client.fetchMetadata.mock.calls[0][1];
    expect(opts.extraHeaders).toEqual(expect.arrayContaining(['Cc', 'Auto-Submitted', 'List-Id', 'List-Unsubscribe', 'Precedence']));
  });

  it('a handler failure on a sent message is a messageError and does NOT count as ingested', async () => {
    const client = makeClient({ messages: [sentTo('s1')] });
    seedState({ [ME]: { lastHistoryId: '2000' } });
    const stats = await poll({ clients: [{ client, label: 'A', ingestSent: true }], statePath }, vi.fn().mockRejectedValue(new Error('boom')));
    expect(stats.sentIngested).toBe(0);
    expect(stats.messageErrors).toBe(1);
  });
});

describe('#2421 direction_sent_maps_to_envelope (what the lib hands over)', () => {
  it('the handler receives the message with its SENT label intact — the ingestors map SENT -> direction:"sent" (gmail-source.js)', async () => {
    const s1 = sentTo('s1');
    const client = makeClient({ messages: [s1] });
    seedState({ [ME]: { lastHistoryId: '2000' } });
    const handler = vi.fn().mockResolvedValue('processed');
    await poll({ clients: [{ client, label: 'A', ingestSent: true }], statePath }, handler);
    const [meta, gotClient, opts] = handler.mock.calls[0];
    expect(meta.labelIds).toContain('SENT');
    expect(meta).toBe(s1);
    expect(gotClient).toBe(client);
    expect(opts).toEqual({ dryRun: false });
  });
});

describe('#2421 poll_still_screens_draft_spam_trash (with ingestSent on)', () => {
  it('DRAFT, SPAM and TRASH stay screened even when they also carry SENT', async () => {
    const messages = [
      makeMeta({ id: 'd1', from: ME, labelIds: ['DRAFT'] }),
      sentTo('st1', undefined, { labelIds: ['SENT', 'TRASH'] }),
      sentTo('ss1', undefined, { labelIds: ['SENT', 'SPAM'] }),
      makeMeta({ id: 'sp1', labelIds: ['SPAM', 'UNREAD'] }),
      makeMeta({ id: 't1', labelIds: ['TRASH'] }),
      sentTo('ok1'),
    ];
    const client = makeClient({ messages });
    seedState({ [ME]: { lastHistoryId: '2000' } });
    const handler = vi.fn().mockResolvedValue('processed');

    const stats = await poll({ clients: [{ client, label: 'A', ingestSent: true }], statePath }, handler);

    expect(handledIds(handler)).toEqual(['ok1']);
    expect(stats.sentIngested).toBe(1);
    expect(readStateFile().accounts[ME].processedIds).toEqual(expect.arrayContaining(['d1', 'st1', 'ss1', 'sp1', 't1', 'ok1']));
  });
});

describe('#2421 sent_shares_cursor_and_ring_no_double_ingest', () => {
  it('one history call per account per run, one cursor, and a re-listed sent message is never handled twice', async () => {
    const messages = [makeMeta({ id: 'in1' }), sentTo('s1')];
    const client = makeClient({ messages });
    // Same window every run (cursor parked by overflow elsewhere / identical getHistory).
    seedState({ [ME]: { lastHistoryId: '2000' } });
    const handler = vi.fn().mockResolvedValue('processed');

    await poll({ clients: [{ client, label: 'A', ingestSent: true }], statePath }, handler);
    // Force the same window again: reset the cursor, keep the ring.
    const st = readStateFile();
    st.accounts[ME].lastHistoryId = '2000';
    fs.writeFileSync(statePath, JSON.stringify(st), 'utf8');
    await poll({ clients: [{ client, label: 'A', ingestSent: true }], statePath }, handler);

    expect(handledIds(handler)).toEqual(['in1', 's1']);
    expect(client.getHistory).toHaveBeenCalledTimes(2); // once per run, no second (Sent) listing
    const keys = Object.keys(readStateFile().accounts[ME]);
    expect(keys.filter(k => /history/i.test(k))).toEqual(['lastHistoryId']); // no second cursor
  });

  it('a self-sent message (SENT + INBOX) is ONE Gmail message: handled at most once', async () => {
    const self = makeMeta({ id: 'self1', from: `Paul <${ME}>`, to: ME, labelIds: ['SENT', 'INBOX'] });
    const client = makeClient({ messages: [self] });
    seedState({ [ME]: { lastHistoryId: '2000' } });
    const handler = vi.fn().mockResolvedValue('processed');
    await poll({ clients: [{ client, label: 'A', ingestSent: true, ingestSelfSent: true }], statePath }, handler);
    expect(handledIds(handler)).toEqual(['self1']);
  });

  it('a SENT copy in one account never suppresses the RECEIVED copy of the same Message-ID in another', async () => {
    const shared = '<x@mail.example.com>';
    const a = makeClient({ account: ME, messages: [sentTo('a1', 'B <b@example.com>', { messageId: shared })] });
    const b = makeClient({ account: 'b@example.com', messages: [makeMeta({ id: 'b1', messageId: shared, from: `Paul <${ME}>`, to: 'b@example.com' })] });
    seedState({ [ME]: { lastHistoryId: '2000' }, 'b@example.com': { lastHistoryId: '2000' } });
    const handler = vi.fn().mockResolvedValue('processed');

    await poll({ clients: [{ client: a, label: 'A', ingestSent: true }, { client: b, label: 'B' }], statePath }, handler);

    expect(handledIds(handler)).toEqual(['a1', 'b1']);
  });

  it('two SENT copies of one Message-ID across accounts still dedupe (same rule as received mail)', async () => {
    const shared = '<y@mail.example.com>';
    const a = makeClient({ account: ME, messages: [sentTo('a1', undefined, { messageId: shared })] });
    const b = makeClient({ account: 'b@example.com', messages: [makeMeta({ id: 'b1', messageId: shared, from: 'b@example.com', to: 'c@other.example', labelIds: ['SENT'] })] });
    seedState({ [ME]: { lastHistoryId: '2000' }, 'b@example.com': { lastHistoryId: '2000' } });
    const handler = vi.fn().mockResolvedValue('processed');
    await poll({ clients: [{ client: a, label: 'A', ingestSent: true }, { client: b, label: 'B', ingestSent: true }], statePath }, handler);
    expect(handledIds(handler)).toEqual(['a1']);
  });
});

describe('#2421 sent_idempotent_across_parked_cursor (the 08-04 dup-storm class)', () => {
  it('drains a mixed sent/received overflow across runs: each message exactly once, then the cursor advances', async () => {
    const metaById = {
      m1: makeMeta({ id: 'm1' }),
      s1: sentTo('s1'),
      m2: makeMeta({ id: 'm2' }),
      s2: sentTo('s2'),
      m3: makeMeta({ id: 'm3' }),
    };
    const client = {
      account: ME,
      getCurrentHistoryId: vi.fn().mockResolvedValue('3000'),
      getHistory: vi.fn().mockImplementation(async (startId) =>
        startId === '2000' ? historyResult(['m1', 's1', 'm2', 's2', 'm3']) : historyResult([])),
      fetchMetadata: vi.fn().mockImplementation(async id => metaById[id]),
      _gmail: { users: { messages: { batchModify: vi.fn() } } },
    };
    seedState({ [ME]: { lastHistoryId: '2000' } });
    const handler = vi.fn().mockResolvedValue('processed');
    const run = () => poll({ clients: [{ client, label: 'A', ingestSent: true }], statePath, maxPerRun: 2 }, handler);

    const r1 = await run();
    expect(readStateFile().accounts[ME].lastHistoryId).toBe('2000'); // parked
    const r2 = await run();
    const r3 = await run();
    expect(readStateFile().accounts[ME].lastHistoryId).toBe('3000');
    await run(); // caught up: nothing new

    expect(handledIds(handler)).toEqual(['m1', 's1', 'm2', 's2', 'm3']);
    expect(r1.sentIngested + r2.sentIngested + r3.sentIngested).toBe(2);
  });
});

describe('#2421 self_sent_automated_mail_skipped_and_counted', () => {
  const run = async (messages, entry = {}) => {
    const client = makeClient({ messages });
    seedState({ [ME]: { lastHistoryId: '2000' } });
    const handler = vi.fn().mockResolvedValue('processed');
    const stats = await poll({ clients: [{ client, label: 'A', ingestSent: true, ...entry }], statePath }, handler);
    return { stats, handler };
  };

  it('self-sent mail with an automated header (Auto-Submitted) is skipped, counted, and ringed', async () => {
    const m = makeMeta({ id: 'auto1', from: `Intake <${ME}>`, to: ME, labelIds: ['SENT', 'INBOX'], extra: [{ name: 'Auto-Submitted', value: 'auto-generated' }] });
    const { stats, handler } = await run([m]);
    expect(handler).not.toHaveBeenCalled();
    expect(stats.sentSkippedAuto).toBe(1);
    expect(stats.sentIngested).toBe(0);
    expect(readStateFile().accounts[ME].processedIds).toContain('auto1');
  });

  it.each([
    ['List-Id', '<digest.example>'],
    ['List-Unsubscribe', '<mailto:u@example.com>'],
    ['Precedence', 'bulk'],
    ['Precedence', 'list'],
    ['Auto-Submitted', 'auto-replied'],
  ])('sent mail carrying %s: %s is automated even when addressed to someone else', async (name, value) => {
    const m = sentTo('a1', 'x@other.example', { extra: [{ name, value }] });
    const { stats, handler } = await run([m]);
    expect(handler).not.toHaveBeenCalled();
    expect(stats.sentSkippedAuto).toBe(1);
  });

  it('Auto-Submitted: no is NOT automated (RFC 3834)', async () => {
    const m = sentTo('h1', 'x@other.example', { extra: [{ name: 'Auto-Submitted', value: 'no' }] });
    const { stats, handler } = await run([m]);
    expect(handledIds(handler)).toEqual(['h1']);
    expect(stats.sentSkippedAuto).toBe(0);
  });

  it('plain self-to-self mail (Intake\'s own digests carry NO automated header) is skipped by default and counted as self', async () => {
    const m = makeMeta({ id: 'self1', from: `Paul <${ME.toUpperCase()}>`, to: `"Paul" <${ME}>`, labelIds: ['SENT', 'INBOX'] });
    const { stats, handler } = await run([m]);
    expect(handler).not.toHaveBeenCalled();
    expect(stats.sentSkippedSelf).toBe(1);
    expect(stats.sentSkippedAuto).toBe(0);
    expect(readStateFile().accounts[ME].processedIds).toContain('self1');
  });

  it('self-sent with a Cc to someone else is NOT self-only: ingested', async () => {
    const m = makeMeta({ id: 'cc1', from: ME, to: ME, cc: 'Other <o@other.example>', labelIds: ['SENT', 'INBOX'] });
    const { stats, handler } = await run([m]);
    expect(handledIds(handler)).toEqual(['cc1']);
    expect(stats.sentIngested).toBe(1);
  });

  it('ingestSelfSent:true lets a human note-to-self through, but automated self-sent is still skipped', async () => {
    const human = makeMeta({ id: 'note1', from: ME, to: ME, labelIds: ['SENT', 'INBOX'] });
    const auto = makeMeta({ id: 'dig1', from: ME, to: ME, labelIds: ['SENT', 'INBOX'], extra: [{ name: 'List-Id', value: '<x>' }] });
    const { stats, handler } = await run([human, auto], { ingestSelfSent: true });
    expect(handledIds(handler)).toEqual(['note1']);
    expect(stats.sentSkippedAuto).toBe(1);
    expect(stats.sentSkippedSelf).toBe(0);
  });

  it('sentSelfAddresses widens "self" to the account\'s send-as aliases', async () => {
    const m = makeMeta({ id: 'alias1', from: 'Paul <alias@example.com>', to: ME, labelIds: ['SENT', 'INBOX'] });
    const { stats, handler } = await run([m], { sentSelfAddresses: ['alias@example.com'] });
    expect(handler).not.toHaveBeenCalled();
    expect(stats.sentSkippedSelf).toBe(1);
  });

  it('received (non-SENT) mail is never subject to the automated/self screen', async () => {
    const m = makeMeta({ id: 'r1', from: 'news@shop.example', to: ME, extra: [{ name: 'List-Unsubscribe', value: '<x>' }] });
    const { stats, handler } = await run([m]);
    expect(handledIds(handler)).toEqual(['r1']);
    expect(stats.sentSkippedAuto).toBe(0);
  });

  it('dry-run counts but never rings or writes state', async () => {
    const m = makeMeta({ id: 'auto1', from: ME, to: ME, labelIds: ['SENT'], extra: [{ name: 'Auto-Submitted', value: 'auto-generated' }] });
    const client = makeClient({ messages: [m, sentTo('s1')] });
    seedState({ [ME]: { lastHistoryId: '2000' } });
    const before = fs.readFileSync(statePath, 'utf8');
    const stats = await poll({ clients: [{ client, label: 'A', ingestSent: true }], statePath, dryRun: true }, vi.fn());
    expect(fs.readFileSync(statePath, 'utf8')).toBe(before);
    expect(stats.sentSkippedAuto).toBe(1);
    expect(stats.sentIngested).toBe(1);
  });
});

describe('#2421 poll.sent_enabled_but_zero_30d — "enabled yet silent" must be visible', () => {
  const DAY = 24 * 3600 * 1000;

  it('first enabled run stamps sentEnabledAt; an ingested sent message stamps lastSentIngestedAt', async () => {
    const client = makeClient({ messages: [sentTo('s1')] });
    seedState({ [ME]: { lastHistoryId: '2000' } });
    const stats = await poll({ clients: [{ client, label: 'A', ingestSent: true }], statePath }, vi.fn().mockResolvedValue('processed'));
    const acct = readStateFile().accounts[ME];
    expect(Date.parse(acct.sentEnabledAt)).toBeGreaterThan(Date.now() - DAY);
    expect(Date.parse(acct.lastSentIngestedAt)).toBeGreaterThan(Date.now() - DAY);
    expect(stats.sentSilentAccounts).toBe(0);
  });

  it('an account enabled >30 days ago that has ingested no sent mail counts as silent', async () => {
    const client = makeClient({ messages: [makeMeta({ id: 'in1' })] });
    seedState({ [ME]: { lastHistoryId: '2000', sentEnabledAt: new Date(Date.now() - 31 * DAY).toISOString() } });
    const stats = await poll({ clients: [{ client, label: 'A', ingestSent: true }], statePath }, vi.fn().mockResolvedValue('processed'));
    expect(stats.sentSilentAccounts).toBe(1);
  });

  it('skipped (self/automated) sent mail does not count as ingested — it is still silent', async () => {
    const auto = makeMeta({ id: 'a1', from: ME, to: ME, labelIds: ['SENT'] });
    const client = makeClient({ messages: [auto] });
    seedState({ [ME]: { lastHistoryId: '2000', sentEnabledAt: new Date(Date.now() - 31 * DAY).toISOString() } });
    const stats = await poll({ clients: [{ client, label: 'A', ingestSent: true }], statePath }, vi.fn().mockResolvedValue('processed'));
    expect(stats.sentSilentAccounts).toBe(1);
  });

  it('a recent ingested sent message clears it', async () => {
    const client = makeClient({ messages: [] });
    seedState({ [ME]: { lastHistoryId: '2000', sentEnabledAt: new Date(Date.now() - 90 * DAY).toISOString(), lastSentIngestedAt: new Date(Date.now() - 2 * DAY).toISOString() } });
    const stats = await poll({ clients: [{ client, label: 'A', ingestSent: true }], statePath }, vi.fn());
    expect(stats.sentSilentAccounts).toBe(0);
  });

  it('is never counted for an account with ingestSent off, whatever its state says', async () => {
    const client = makeClient({ messages: [] });
    seedState({ [ME]: { lastHistoryId: '2000', sentEnabledAt: new Date(Date.now() - 90 * DAY).toISOString() } });
    const stats = await poll({ clients: [{ client, label: 'A' }], statePath }, vi.fn());
    expect(stats.sentSilentAccounts).toBe(0);
  });

  it('computeSentSilentCheck: 0 -> pass, >0 -> warn, unreported -> warn (missing is never green)', () => {
    expect(computeSentSilentCheck(0)).toMatchObject({ id: 'poll.sent_enabled_but_zero_30d', status: 'pass', metric: 0 });
    expect(computeSentSilentCheck(2)).toMatchObject({ id: 'poll.sent_enabled_but_zero_30d', status: 'warn', metric: 2 });
    expect(computeSentSilentCheck(undefined).status).toBe('warn');
    expect(computeSentSilentCheck(Number.NaN).status).toBe('warn');
  });

  it('reportProducerHealth always carries the check, schema-valid, ok on a clean ingestSent-off run', async () => {
    const sent = { health: [] };
    const transport = { async send(p, body) { if (p.includes('health')) sent.health.push(body); } };
    const telemetry = createTelemetry({ product: 'sluice', module: 'producer.test', version: 'test', transport, heartbeatMs: 0, batchIntervalMs: 0, autoStart: false });
    const sluiceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sent-health-'));
    fs.mkdirSync(path.join(sluiceDir, 'inbox'));
    try {
      const client = makeClient({ messages: [makeMeta({ id: 'in1' })] });
      seedState({ [ME]: { lastHistoryId: '2000' } });
      const stats = await poll({ clients: [{ client, label: 'A' }], statePath }, vi.fn().mockResolvedValue('processed'));
      await reportProducerHealth(telemetry, producerHealthStats(stats), { sluiceDir });
      const report = sent.health[0];
      expect(() => HealthReportSchema.parse(report)).not.toThrow();
      expect(report.checks.map(c => c.id)).toContain('poll.sent_enabled_but_zero_30d');
      expect(report.status).toBe('ok');
    } finally {
      fs.rmSync(sluiceDir, { recursive: true, force: true });
    }
  });
});

describe('#2421 analytics: sent counters reach producer.run (PII-free)', () => {
  it('producerRunStats forwards the sent counters', () => {
    const out = producerRunStats('personal', { fetched: 1, processed: 1, errors: 0, messageErrors: 0, accountErrors: 0, quarantined: 0, sentIngested: 2, sentSkippedAuto: 3, sentSkippedSelf: 4 });
    expect(out).toMatchObject({ sentIngested: 2, sentSkippedAuto: 3, sentSkippedSelf: 4 });
  });

  it('trackProducerRun emits sent_* props when given, omits them when not (absent is never a laundered zero)', async () => {
    const sent = { analytics: [] };
    const transport = { async send(p, body) { if (!p.includes('health')) sent.analytics.push(body); } };
    const telemetry = createTelemetry({ product: 'sluice', module: 'producer.personal', version: 'test', transport, heartbeatMs: 0, batchIntervalMs: 0, autoStart: false, batchSize: 1 });
    trackProducerRun(telemetry, { entityId: 'personal', fetched: 1, produced: 1, skipped: 0, errors: 0, sentIngested: 1, sentSkippedAuto: 0, sentSkippedSelf: 2 });
    trackProducerRun(telemetry, { entityId: 'personal', fetched: 1, produced: 1, skipped: 0, errors: 0 });
    await telemetry.flush();
    const [withSent, without] = sent.analytics.flat();
    expect(() => AnalyticsBatchSchema.parse([withSent])).not.toThrow();
    expect(withSent.props).toMatchObject({ sent_ingested: 1, sent_skipped_auto: 0, sent_skipped_self: 2 });
    expect(JSON.stringify(withSent.props)).not.toMatch(/@/);
    expect(without.props).not.toHaveProperty('sent_ingested');
  });
});

describe('#2421 GmailClient.fetchMetadata extra headers', () => {
  const fakeSelf = () => {
    const get = vi.fn().mockResolvedValue({ data: { id: 'm1' } });
    return { self: { account: ME, _gmail: { users: { messages: { get } } } }, get };
  };

  it('default call is unchanged (the five headers, nothing else)', async () => {
    const { self, get } = fakeSelf();
    await GmailClient.prototype.fetchMetadata.call(self, 'm1');
    expect(get.mock.calls[0][0].metadataHeaders).toEqual(['Subject', 'From', 'Date', 'To', 'Message-ID']);
  });

  it('extraHeaders are appended, deduped', async () => {
    const { self, get } = fakeSelf();
    await GmailClient.prototype.fetchMetadata.call(self, 'm1', { extraHeaders: ['Cc', 'From', 'List-Id'] });
    expect(get.mock.calls[0][0].metadataHeaders).toEqual(['Subject', 'From', 'Date', 'To', 'Message-ID', 'Cc', 'List-Id']);
  });
});

// ── review follow-ups on PR #85 (Sonnet/Opus/Fable) ────────────────────────────────────────────────────
describe('#2421 review follow-ups', () => {
  const runWith = async (messages, entry = {}, cfg = {}) => {
    const client = makeClient({ messages });
    if (!fs.existsSync(statePath)) seedState({ [ME]: { lastHistoryId: '2000' } });
    const handler = vi.fn().mockResolvedValue('processed');
    const stats = await poll({ clients: [{ client, label: 'A', ingestSent: true, ...entry }], statePath, ...cfg }, handler);
    return { stats, handler, client };
  };

  it('Bcc: To:self with real recipients in Bcc is NOT self-only (Bcc header is requested and counted)', async () => {
    const m = makeMeta({ id: 'bcc1', from: ME, to: ME, labelIds: ['SENT'], extra: [{ name: 'Bcc', value: 'Client <client@other.example>' }] });
    const { stats, handler, client } = await runWith([m]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(stats.sentSkippedSelf).toBe(0);
    expect(client.fetchMetadata.mock.calls[0][1].extraHeaders).toContain('Bcc');
  });

  it('a processed SENT message is never batch-archived even with archiveAfterProcess on', async () => {
    const { client, handler } = await runWith([sentTo('arch1')], {}, { archiveAfterProcess: true });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(client._gmail.users.messages.batchModify.mock.calls)).not.toContain('arch1');
  });

  it('turning ingestSent off clears sentEnabledAt so a later re-enable starts a fresh 30-day baseline', async () => {
    await runWith([sentTo('t1')]);
    expect(readStateFile().accounts[ME].sentEnabledAt).toBeTruthy();
    await runWith([], { ingestSent: false });
    const acct = readStateFile().accounts[ME];
    expect(acct.sentEnabledAt).toBeUndefined();
    expect(acct.lastSentIngestedAt).toBeUndefined();
  });

  it('fetchMetadata tolerates opts === null', async () => {
    const gm = Object.create(GmailClient.prototype);
    gm.account = 'x';
    gm._gmail = { users: { messages: { get: async () => ({ data: {} }) } } };
    await expect(GmailClient.prototype.fetchMetadata.call(gm, 'x', null)).resolves.toBeDefined();
  });
});
