/**
 * tasks.db #2421 — Sent ingestion SHADOW mode (Paul, 2026-10-24: "enable personal-gmail only, shadow first").
 *
 * `ingestSent: 'shadow'` (that exact string) counts what Sent ingestion WOULD do and changes nothing:
 *   - every SENT message is still screened exactly as with the option off (ringed, never handed to the
 *     handler, never archived),
 *   - but it is classified first with the same screens `ingestSent: true` uses, and counted:
 *       sentShadowWouldIngest — would have been handed to the handler
 *       sentShadowWouldSkip   — would have been skipped as automated or self-only
 *   - no sent state is written (shadow is not "enabled": no sentEnabledAt, no 30-day silence check).
 * Anything other than `true` or the exact string 'shadow' is OFF.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { poll } from '../poll.js';
import { producerRunStats, trackProducerRun } from '../producer-health.js';
import { createTelemetry, AnalyticsBatchSchema } from '@perfectcity/telemetry';

let tmpDir;
let statePath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-sent-shadow-test-'));
  statePath = path.join(tmpDir, 'state.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const ME = 'me@example.com';

function makeMeta({ id, from = 'Sender <s@example.com>', to = ME, labelIds = ['INBOX', 'UNREAD'], extra = [] }) {
  const headers = [
    { name: 'Message-ID', value: `<${id}@mail.example.com>` },
    { name: 'From', value: from },
    { name: 'To', value: to },
    { name: 'Subject', value: 'Test' },
  ];
  return { id, labelIds, snippet: '', payload: { headers: [...headers, ...extra] } };
}

const sentTo = (id, to = 'Client <client@other.example>', more = {}) =>
  makeMeta({ id, from: `Paul <${ME}>`, to, labelIds: ['SENT'], ...more });
const selfNote = (id) => makeMeta({ id, from: `Paul <${ME}>`, to: ME, labelIds: ['SENT', 'INBOX'] });
const automated = (id) => sentTo(id, 'x@other.example', { extra: [{ name: 'List-Id', value: '<digest.example>' }] });

function historyResult(ids) {
  const map = Object.fromEntries(ids.map((id, i) => [id, String(100 + i)]));
  return { ids, truncated: false, historyIdById: map, lastEnumeratedHistoryId: ids.length ? map[ids[ids.length - 1]] : null };
}

function makeClient({ messages = [] } = {}) {
  const metaById = Object.fromEntries(messages.map(m => [m.id, m]));
  return {
    account: ME,
    getCurrentHistoryId: vi.fn().mockResolvedValue('3000'),
    getHistory: vi.fn().mockResolvedValue(historyResult(messages.map(m => m.id))),
    fetchMetadata: vi.fn().mockImplementation(async id => metaById[id]),
    _gmail: { users: { messages: { batchModify: vi.fn().mockResolvedValue({}) } } },
  };
}

const seedState = (acct = { lastHistoryId: '2000' }) =>
  fs.writeFileSync(statePath, JSON.stringify({ accounts: { [ME]: acct }, totalProcessed: 0 }), 'utf8');
const readStateFile = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
const handledIds = (handler) => handler.mock.calls.map(c => c[0].id);

async function run(messages, entry = {}, cfg = {}) {
  const client = makeClient({ messages });
  if (!fs.existsSync(statePath)) seedState();
  const handler = vi.fn().mockResolvedValue('processed');
  const stats = await poll({ clients: [{ client, label: 'A', ingestSent: 'shadow', ...entry }], statePath, ...cfg }, handler);
  return { stats, handler, client };
}

describe('#2421 shadow: counts what Sent ingestion would do, changes nothing', () => {
  it('SENT mail is NOT handed to the handler, IS ringed, and is counted as would-ingest', async () => {
    const { stats, handler } = await run([makeMeta({ id: 'in1' }), sentTo('s1'), sentTo('s2')]);
    expect(handledIds(handler)).toEqual(['in1']);
    expect(stats.sentShadowWouldIngest).toBe(2);
    expect(stats.sentShadowWouldSkip).toBe(0);
    expect(stats.sentIngested).toBe(0);
    expect(stats.processed).toBe(1);
    expect(readStateFile().accounts[ME].processedIds).toEqual(expect.arrayContaining(['in1', 's1', 's2']));
  });

  it('automated and self-only sent mail count as would-skip, not would-ingest (same screens as ingestSent:true)', async () => {
    const { stats, handler } = await run([sentTo('real1'), automated('auto1'), selfNote('self1')]);
    expect(handler).not.toHaveBeenCalled();
    expect(stats.sentShadowWouldIngest).toBe(1);
    expect(stats.sentShadowWouldSkip).toBe(2);
    // The live skip counters stay at zero: nothing was actually skipped-instead-of-ingested.
    expect(stats.sentSkippedAuto).toBe(0);
    expect(stats.sentSkippedSelf).toBe(0);
  });

  it('with ingestSelfSent, a note to self counts as would-ingest', async () => {
    const { stats } = await run([selfNote('self1')], { ingestSelfSent: true });
    expect(stats.sentShadowWouldIngest).toBe(1);
    expect(stats.sentShadowWouldSkip).toBe(0);
  });

  it('requests the screen headers (it cannot classify without them)', async () => {
    const { client } = await run([sentTo('s1')]);
    expect(client.fetchMetadata.mock.calls[0][1].extraHeaders).toEqual(expect.arrayContaining(['Cc', 'Bcc', 'List-Id', 'Auto-Submitted']));
  });

  it('DRAFT / SPAM / TRASH stay screened and are not counted, even with SENT', async () => {
    const msgs = ['DRAFT', 'SPAM', 'TRASH'].map((l, i) => makeMeta({ id: `x${i}`, from: ME, to: 'c@other.example', labelIds: ['SENT', l] }));
    const { stats, handler } = await run(msgs);
    expect(handler).not.toHaveBeenCalled();
    expect(stats.sentShadowWouldIngest).toBe(0);
    expect(stats.sentShadowWouldSkip).toBe(0);
  });

  it('writes no sent state and never reports the account as silent (shadow is not "enabled")', async () => {
    seedState({ lastHistoryId: '2000', sentEnabledAt: '2020-01-01T00:00:00.000Z' });
    const { stats } = await run([sentTo('s1')]);
    const acct = readStateFile().accounts[ME];
    expect(acct.sentEnabledAt).toBeUndefined();
    expect(acct.lastSentIngestedAt).toBeUndefined();
    expect(stats.sentSilentAccounts).toBe(0);
  });

  it('never archives a sent message (archiveAfterProcess on)', async () => {
    const { client } = await run([sentTo('arch1')], {}, { archiveAfterProcess: true });
    expect(JSON.stringify(client._gmail.users.messages.batchModify.mock.calls)).not.toContain('arch1');
  });

  it('a ringed message is not counted again on the next run', async () => {
    await run([sentTo('s1')]);
    const { stats } = await run([sentTo('s1')]);
    expect(stats.sentShadowWouldIngest).toBe(0);
  });

  it('dryRun counts but does not ring', async () => {
    const { stats } = await run([sentTo('s1')], {}, { dryRun: true });
    expect(stats.sentShadowWouldIngest).toBe(1);
    expect(readStateFile().accounts[ME].processedIds || []).not.toContain('s1');
  });

  // #2502 / Fable N1: dryRun skips the stale-baseline delete, so a long-expired sentEnabledAt is still
  // in state when the silence loop runs. Only its `ingestSent !== true` guard keeps shadow from being
  // reported "silent" here (a `!entry.ingestSent` guard would count it: 'shadow' is truthy).
  it('dryRun with a stale sentEnabledAt seeded: shadow is still never reported silent', async () => {
    seedState({ lastHistoryId: '2000', sentEnabledAt: '2020-01-01T00:00:00.000Z' });
    const { stats } = await run([sentTo('s1')], {}, { dryRun: true });
    expect(readStateFile().accounts[ME].sentEnabledAt).toBe('2020-01-01T00:00:00.000Z'); // dryRun wrote nothing
    expect(stats.sentSilentAccounts).toBe(0);
  });
});

describe('#2421 shadow: strictness and default', () => {
  it.each([['Shadow'], ['on'], ['true'], [1], [{}]])('ingestSent=%j is OFF: no extra headers, nothing counted, nothing handled', async (value) => {
    const { stats, handler, client } = await run([sentTo('s1')], { ingestSent: value });
    expect(handler).not.toHaveBeenCalled();
    for (const call of client.fetchMetadata.mock.calls) expect(call).toHaveLength(1);
    expect(stats.sentShadowWouldIngest).toBe(0);
  });

  it('the shadow counters are always present, 0 when the option is off', async () => {
    const { stats } = await run([sentTo('s1')], { ingestSent: undefined });
    expect(stats).toMatchObject({ sentShadowWouldIngest: 0, sentShadowWouldSkip: 0 });
  });

  it('ingestSent:true does not touch the shadow counters', async () => {
    const { stats, handler } = await run([sentTo('s1')], { ingestSent: true });
    expect(handledIds(handler)).toEqual(['s1']);
    expect(stats.sentIngested).toBe(1);
    expect(stats.sentShadowWouldIngest).toBe(0);
  });
});

describe('#2421 shadow: analytics (PII-free, absent is never a laundered zero)', () => {
  it('producerRunStats forwards the shadow counters as-is', () => {
    const out = producerRunStats('personal', { fetched: 1, processed: 1, errors: 0, sentShadowWouldIngest: 3, sentShadowWouldSkip: 4 });
    expect(out).toMatchObject({ sentShadowWouldIngest: 3, sentShadowWouldSkip: 4 });
  });

  it('trackProducerRun emits sent_shadow_* only when reported, and the batch is schema-valid', async () => {
    const sent = [];
    const transport = { async send(p, body) { if (!p.includes('health')) sent.push(body); } };
    const telemetry = createTelemetry({ product: 'sluice', module: 'producer.personal', version: 'test', transport, heartbeatMs: 0, batchIntervalMs: 0, autoStart: false, batchSize: 1 });
    trackProducerRun(telemetry, { entityId: 'personal', fetched: 1, produced: 1, skipped: 0, errors: 0, sentShadowWouldIngest: 2, sentShadowWouldSkip: 0 });
    trackProducerRun(telemetry, { entityId: 'personal', fetched: 1, produced: 1, skipped: 0, errors: 0 });
    await telemetry.flush();
    const [withShadow, without] = sent.flat();
    expect(() => AnalyticsBatchSchema.parse([withShadow])).not.toThrow();
    expect(withShadow.props).toMatchObject({ sent_shadow_would_ingest: 2, sent_shadow_would_skip: 0 });
    expect(without.props).not.toHaveProperty('sent_shadow_would_ingest');
    expect(without.props).not.toHaveProperty('sent_shadow_would_skip');
  });
});
