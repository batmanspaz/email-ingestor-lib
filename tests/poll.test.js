/**
 * Unit tests for poll.js — poll()
 *
 * Focus: dry-run semantics. dryRun must skip BOTH state writes and the
 * handler (the historical bug: state writes were gated but the handler
 * still ran, so "dry" runs forwarded real email). invokeHandlerInDryRun
 * is the explicit opt-in for handlers that gate their own side effects.
 *
 * Gmail is fully mocked — clients are plain objects with the methods
 * poll() touches: account, getCurrentHistoryId, getHistory, fetchMetadata.
 *
 * getHistory returns {ids, truncated, historyIdById, lastEnumeratedHistoryId}
 * as of 2026-08-23. Build mock returns with historyResult() below — a bare
 * array is the OLD contract and mocking it is how poll.js was able to break
 * against real gmail.js while this suite stayed green.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { poll } from '../poll.js';

let tmpDir;
let statePath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-test-'));
  statePath = path.join(tmpDir, 'state.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeMeta({ id, messageId, from = 'Sender <s@example.com>', subject = 'Test', labelIds = ['INBOX', 'UNREAD'] }) {
  return {
    id,
    labelIds,
    snippet: '',
    payload: {
      headers: [
        { name: 'Message-ID', value: messageId ?? `<${id}@mail.example.com>` },
        { name: 'From', value: from },
        { name: 'Subject', value: subject },
      ],
    },
  };
}

function makeClient({ account = 'a@example.com', messages = [], currentHistoryId = '2000' } = {}) {
  const metaById = Object.fromEntries(messages.map(m => [m.id, m]));
  return {
    account,
    getCurrentHistoryId: vi.fn().mockResolvedValue(currentHistoryId),
    getHistory: vi.fn().mockResolvedValue(historyResult(messages.map(m => m.id))),
    fetchMetadata: vi.fn().mockImplementation(async id => metaById[id]),
    // Stub for archiveAfterProcess — batchModify is never called in these tests
    // (archiveAfterProcess defaults to false), but the field must exist.
    _gmail: { users: { messages: { batchModify: vi.fn().mockResolvedValue({}) } } },
  };
}

function seedState(accounts) {
  fs.writeFileSync(statePath, JSON.stringify({ accounts, totalProcessed: 0 }), 'utf8');
}

function readStateFile() {
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}


/**
 * Build a getHistory() return value. Assigns each id a synthetic ascending
 * historyId unless one is supplied, mirroring Gmail's ordering guarantee.
 */
function historyResult(ids, { truncated = false, startAt = 100, historyIdById } = {}) {
  const map = historyIdById || Object.fromEntries(ids.map((id, i) => [id, String(startAt + i)]));
  const last = ids.length ? map[ids[ids.length - 1]] : null;
  return { ids, truncated, historyIdById: map, lastEnumeratedHistoryId: last };
}

describe('poll — first run (no historyId)', () => {
  it('seeds historyId and writes state without calling handler', async () => {
    const client = makeClient({ currentHistoryId: '1234' });
    const handler = vi.fn();

    const stats = await poll({ clients: [{ client, label: 'A' }], statePath }, handler);

    expect(handler).not.toHaveBeenCalled();
    expect(stats).toEqual({ fetched: 0, processed: 0, errors: 0, forwarded: 0, archived: 0 , truncated: 0 });
    expect(readStateFile().accounts['a@example.com'].lastHistoryId).toBe('1234');
  });

  it('does NOT write the seeded state in dry-run', async () => {
    const client = makeClient({ currentHistoryId: '1234' });

    await poll({ clients: [{ client, label: 'A' }], statePath, dryRun: true }, vi.fn());

    expect(fs.existsSync(statePath)).toBe(false);
  });
});

describe('poll — normal run', () => {
  it('calls handler per message, counts stats, and advances historyId', async () => {
    const messages = [makeMeta({ id: 'm1' }), makeMeta({ id: 'm2' })];
    const client = makeClient({ messages, currentHistoryId: '3000' });
    seedState({ 'a@example.com': { lastHistoryId: '2000' } });

    const handler = vi.fn().mockResolvedValue('processed');
    const stats = await poll({ clients: [{ client, label: 'A' }], statePath }, handler);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledWith(messages[0], client, { dryRun: false });
    expect(stats).toEqual({ fetched: 2, processed: 2, errors: 0, forwarded: 0, archived: 0 , truncated: 0 });
    const state = readStateFile();
    expect(state.accounts['a@example.com'].lastHistoryId).toBe('3000');
    expect(state.totalProcessed).toBe(2);
  });

  it("counts 'forwarded' handler results", async () => {
    const client = makeClient({ messages: [makeMeta({ id: 'm1' })] });
    seedState({ 'a@example.com': { lastHistoryId: '2000' } });

    const stats = await poll(
      { clients: [{ client, label: 'A' }], statePath },
      vi.fn().mockResolvedValue('forwarded')
    );

    expect(stats.forwarded).toBe(1);
  });

  it('counts handler errors and keeps processing remaining messages', async () => {
    const client = makeClient({ messages: [makeMeta({ id: 'm1' }), makeMeta({ id: 'm2' })] });
    seedState({ 'a@example.com': { lastHistoryId: '2000' } });

    const handler = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('processed');
    const stats = await poll({ clients: [{ client, label: 'A' }], statePath }, handler);

    expect(stats.errors).toBe(1);
    expect(stats.processed).toBe(1);
  });

  it('dedupes by Message-ID across accounts', async () => {
    const shared = '<dup@mail.example.com>';
    const clientA = makeClient({
      account: 'a@example.com',
      messages: [makeMeta({ id: 'a1', messageId: shared })],
    });
    const clientB = makeClient({
      account: 'b@example.com',
      messages: [makeMeta({ id: 'b1', messageId: shared })],
    });
    seedState({
      'a@example.com': { lastHistoryId: '2000' },
      'b@example.com': { lastHistoryId: '2000' },
    });

    const handler = vi.fn().mockResolvedValue('processed');
    const stats = await poll(
      { clients: [{ client: clientA, label: 'A' }, { client: clientB, label: 'B' }], statePath },
      handler
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(stats.processed).toBe(1);
  });

  it('drains overflow across runs WITHOUT reprocessing (window does not shrink — producers no longer archive)', async () => {
    // 3 new messages, maxPerRun = 2. Under the single-writer contract nothing
    // leaves INBOX between runs, so getHistory returns the SAME window while
    // the cursor is parked. The durable processed-ring must prevent the
    // 2026-08-04 dup-storm (same first batch re-enveloped every run, forever).
    const metaById = {
      m1: makeMeta({ id: 'm1' }),
      m2: makeMeta({ id: 'm2' }),
      m3: makeMeta({ id: 'm3' }),
    };
    const client = {
      account: 'a@example.com',
      getCurrentHistoryId: vi.fn().mockResolvedValue('3000'),
      getHistory: vi.fn().mockImplementation(async (startId) =>
        startId === '2000' ? historyResult(['m1', 'm2', 'm3']) : historyResult([])),
      fetchMetadata: vi.fn().mockImplementation(async id => metaById[id]),
      _gmail: { users: { messages: { batchModify: vi.fn().mockResolvedValue({}) } } },
    };
    seedState({ 'a@example.com': { lastHistoryId: '2000' } });

    const processed = [];
    const handler = vi.fn().mockImplementation(async (meta) => {
      processed.push(meta.id);
      return 'processed';
    });

    // Run 1 — first 2 fit; cursor parks; ring records m1+m2 durably.
    await poll({ clients: [{ client, label: 'A' }], statePath, maxPerRun: 2 }, handler);
    expect(processed).toEqual(['m1', 'm2']);
    expect(readStateFile().accounts['a@example.com'].lastHistoryId).toBe('2000');
    expect(readStateFile().accounts['a@example.com'].processedIds).toEqual(['m1', 'm2']);

    // Run 2 — SAME window returned; ring skips m1+m2; only m3 processed; cursor advances.
    await poll({ clients: [{ client, label: 'A' }], statePath, maxPerRun: 2 }, handler);
    expect(processed).toEqual(['m1', 'm2', 'm3']); // no duplicates, no loss
    expect(readStateFile().accounts['a@example.com'].lastHistoryId).toBe('3000');

    // Run 3 — cursor advanced; nothing new; handler untouched.
    await poll({ clients: [{ client, label: 'A' }], statePath, maxPerRun: 2 }, handler);
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('screens SENT/DRAFT/SPAM/TRASH out of the widened history window (labelId filter removed)', async () => {
    const messages = [
      makeMeta({ id: 'in1' }),
      makeMeta({ id: 's1', labelIds: ['SENT'] }),
      makeMeta({ id: 'sp1', labelIds: ['SPAM', 'UNREAD'] }),
      makeMeta({ id: 'arch1', labelIds: ['UNREAD'] }), // archived by triage — MUST still be enveloped
    ];
    const client = makeClient({ messages });
    seedState({ 'a@example.com': { lastHistoryId: '2000' } });

    const handler = vi.fn().mockResolvedValue('processed');
    await poll({ clients: [{ client, label: 'A' }], statePath }, handler);

    const handled = handler.mock.calls.map(c => c[0].id);
    expect(handled).toEqual(['in1', 'arch1']);
    // screened ids land in the ring so they are never refetched
    expect(readStateFile().accounts['a@example.com'].processedIds).toEqual(
      expect.arrayContaining(['s1', 'sp1', 'in1', 'arch1']));
  });

  it('bounds the processed ring', async () => {
    const messages = Array.from({ length: 30 }, (_, i) => makeMeta({ id: 'm' + i }));
    const client = makeClient({ messages });
    seedState({ 'a@example.com': { lastHistoryId: '2000', processedIds: Array.from({ length: 995 }, (_, i) => 'old' + i) } });

    await poll({ clients: [{ client, label: 'A' }], statePath }, vi.fn().mockResolvedValue('processed'));

    const ring = readStateFile().accounts['a@example.com'].processedIds;
    expect(ring.length).toBeLessThanOrEqual(1000);
    expect(ring).toContain('m29');       // newest kept
    expect(ring).not.toContain('old0');  // oldest evicted
  });

  it('caps messages at maxPerRun', async () => {
    const messages = ['m1', 'm2', 'm3'].map(id => makeMeta({ id }));
    const client = makeClient({ messages });
    seedState({ 'a@example.com': { lastHistoryId: '2000' } });

    const handler = vi.fn().mockResolvedValue('processed');
    const stats = await poll(
      { clients: [{ client, label: 'A' }], statePath, maxPerRun: 2 },
      handler
    );

    expect(handler).toHaveBeenCalledTimes(2);
    expect(stats.fetched).toBe(2);
  });
});

describe('poll — dry-run', () => {
  it('does NOT call the handler by default', async () => {
    const client = makeClient({ messages: [makeMeta({ id: 'm1' }), makeMeta({ id: 'm2' })] });
    seedState({ 'a@example.com': { lastHistoryId: '2000' } });

    const handler = vi.fn();
    const stats = await poll(
      { clients: [{ client, label: 'A' }], statePath, dryRun: true },
      handler
    );

    expect(handler).not.toHaveBeenCalled();
    expect(stats).toEqual({ fetched: 2, processed: 2, errors: 0, forwarded: 0, archived: 0 , truncated: 0 });
  });

  it('logs a "[DRY] would process" preview line per message', async () => {
    const client = makeClient({
      messages: [makeMeta({ id: 'm1', from: 'Jane <jane@example.com>', subject: 'Quarterly invoice' })],
    });
    seedState({ 'a@example.com': { lastHistoryId: '2000' } });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await poll({ clients: [{ client, label: 'A' }], statePath, dryRun: true }, vi.fn());

    const dryLines = logSpy.mock.calls.map(c => c[0]).filter(l => String(l).includes('[DRY] would process'));
    expect(dryLines).toHaveLength(1);
    expect(dryLines[0]).toContain('Quarterly invoice');
    logSpy.mockRestore();
  });

  it('does not touch the state file', async () => {
    const client = makeClient({ messages: [makeMeta({ id: 'm1' })], currentHistoryId: '3000' });
    seedState({ 'a@example.com': { lastHistoryId: '2000' } });
    const before = fs.readFileSync(statePath, 'utf8');

    await poll({ clients: [{ client, label: 'A' }], statePath, dryRun: true }, vi.fn());

    expect(fs.readFileSync(statePath, 'utf8')).toBe(before);
  });

  it('calls handler with { dryRun: true } when invokeHandlerInDryRun is set', async () => {
    const messages = [makeMeta({ id: 'm1' })];
    const client = makeClient({ messages });
    seedState({ 'a@example.com': { lastHistoryId: '2000' } });
    const before = fs.readFileSync(statePath, 'utf8');

    const handler = vi.fn().mockResolvedValue('processed');
    const stats = await poll(
      { clients: [{ client, label: 'A' }], statePath, dryRun: true, invokeHandlerInDryRun: true },
      handler
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(messages[0], client, { dryRun: true });
    expect(stats.processed).toBe(1);
    // state still untouched even when the handler runs
    expect(fs.readFileSync(statePath, 'utf8')).toBe(before);
  });

  it('invokeHandlerInDryRun has no effect on normal runs', async () => {
    const client = makeClient({ messages: [makeMeta({ id: 'm1' })] });
    seedState({ 'a@example.com': { lastHistoryId: '2000' } });

    const handler = vi.fn().mockResolvedValue('processed');
    await poll(
      { clients: [{ client, label: 'A' }], statePath, invokeHandlerInDryRun: true },
      handler
    );

    expect(handler).toHaveBeenCalledWith(expect.anything(), client, { dryRun: false });
    expect(readStateFile().accounts['a@example.com'].lastHistoryId).toBe('2000');
  });
});

// ── Truncated-window cursor safety ──────────────────────────────────────────
// The 2026-08-23 mail-loss incident. getHistory hard-caps at 500 ids; before
// this work it returned a bare array, so poll() could not tell 500-of-500 from
// 500-of-5000 and advanced its cursor to NOW once the listed batch was drained.
// Messages 501+ were never listed, never ringed, and fell behind the cursor.
// 44 real occurrences on personal.
//
// Note the second failure mode these tests also guard: simply PARKING on a
// truncated window deadlocks the producer. getHistory(startId) is
// deterministic, so the same 500 return every run; once all are ringed the
// filter yields empty forever and the cursor never moves again. The fix is
// neither "advance to now" nor "never advance" — it is advance to the last
// CONTIGUOUSLY handled message.

describe('poll() — truncated history windows must not lose or stall', () => {
  const win = ['w1', 'w2', 'w3', 'w4'];
  const hid = { w1: '10', w2: '20', w3: '30', w4: '40' };
  const metaFor = (id) => makeMeta({ id });

  function truncatedClient(ids = win) {
    return {
      account: 'a@example.com',
      getCurrentHistoryId: vi.fn().mockResolvedValue('99999'), // "now" — must NOT be used
      getHistory: vi.fn().mockResolvedValue(
        historyResult(ids, { truncated: true, historyIdById: hid }),
      ),
      fetchMetadata: vi.fn().mockImplementation(async (id) => metaFor(id)),
      _gmail: { users: { messages: { batchModify: vi.fn().mockResolvedValue({}) } } },
    };
  }

  it('does NOT advance the cursor to now when the window was truncated', async () => {
    // THE INCIDENT. Everything listed gets handled, so the old code read
    // "caught up" and jumped to 99999, orphaning everything past the cap.
    const client = truncatedClient();
    seedState({ 'a@example.com': { lastHistoryId: '5' } });
    await poll({ clients: [{ client, label: 'A' }], statePath, maxPerRun: 100 },
      vi.fn().mockResolvedValue('processed'));
    expect(readStateFile().accounts['a@example.com'].lastHistoryId).not.toBe('99999');
  });

  it('advances to the last CONTIGUOUSLY handled historyId — not now, not parked', async () => {
    const client = truncatedClient();
    seedState({ 'a@example.com': { lastHistoryId: '5' } });
    await poll({ clients: [{ client, label: 'A' }], statePath, maxPerRun: 100 },
      vi.fn().mockResolvedValue('processed'));
    // all four handled -> watermark is the last one
    expect(readStateFile().accounts['a@example.com'].lastHistoryId).toBe('40');
  });

  it('stops the watermark at the FIRST unhandled message, not the last handled one', async () => {
    // maxPerRun 2 -> w1,w2 handled; w3,w4 deferred. Advancing to w4's historyId
    // would lose w3 and w4. The watermark must stop at w2.
    const client = truncatedClient();
    seedState({ 'a@example.com': { lastHistoryId: '5' } });
    await poll({ clients: [{ client, label: 'A' }], statePath, maxPerRun: 2 },
      vi.fn().mockResolvedValue('processed'));
    expect(readStateFile().accounts['a@example.com'].lastHistoryId).toBe('20');
  });

  it('a HOLE mid-window stops the watermark — not just an unhandled suffix', async () => {
    // Caught by mutation testing 2026-08-23: the previous "stops at the first
    // unhandled message" test only ever produced unhandled messages as a
    // SUFFIX, where `break` and `continue` yield the same watermark. A hole in
    // the MIDDLE is what distinguishes them: w2 fails, w3/w4 succeed. Skipping
    // the hole would advance past w2 and lose it permanently.
    const client = truncatedClient();
    client.fetchMetadata = vi.fn().mockImplementation(async (id) => {
      if (id === 'w2') throw new Error('network flake');
      return metaFor(id);
    });
    seedState({ 'a@example.com': { lastHistoryId: '5' } });
    await poll({ clients: [{ client, label: 'A' }], statePath, maxPerRun: 100 },
      vi.fn().mockResolvedValue('processed'));
    // w1 handled, w2 NOT (errored), w3+w4 handled. Watermark must stop at w1.
    expect(readStateFile().accounts['a@example.com'].lastHistoryId).toBe('10');
  });

  it('makes FORWARD PROGRESS across runs instead of deadlocking on the same window', async () => {
    // The failure mode "never advance on truncation" would introduce: the same
    // 500 return forever, all ringed, filter empty, cursor frozen.
    const seen = [];
    const client = truncatedClient();
    client.getHistory = vi.fn().mockImplementation(async (startId) => {
      // Emulate a real moving window: only records AFTER the cursor come back.
      const remaining = win.filter((id) => Number(hid[id]) > Number(startId));
      return historyResult(remaining, { truncated: true, historyIdById: hid });
    });
    seedState({ 'a@example.com': { lastHistoryId: '5' } });
    const handler = vi.fn().mockImplementation(async (m) => { seen.push(m.id); return 'processed'; });
    for (let i = 0; i < 4; i++) {
      await poll({ clients: [{ client, label: 'A' }], statePath, maxPerRun: 2 }, handler);
    }
    expect(seen).toEqual(win);                    // every message reached, none skipped
    expect(new Set(seen).size).toBe(seen.length); // and none duplicated
  });

  it('COUNTS truncated windows into stats so health can report them', async () => {
    // Caught by mutation testing: disabling the counter entirely left every
    // other poll test green. Without this the truncation health check would
    // always report a clean zero — "missing = healthy" rebuilt one layer up.
    const client = truncatedClient();
    seedState({ 'a@example.com': { lastHistoryId: '5' } });
    const stats = await poll({ clients: [{ client, label: 'A' }], statePath, maxPerRun: 100 },
      vi.fn().mockResolvedValue('processed'));
    expect(stats.truncated).toBe(1);
  });

  it('leaves the truncation counter at zero for a normal window', async () => {
    const client = truncatedClient();
    client.getHistory = vi.fn().mockResolvedValue(historyResult(win, { historyIdById: hid }));
    seedState({ 'a@example.com': { lastHistoryId: '5' } });
    const stats = await poll({ clients: [{ client, label: 'A' }], statePath, maxPerRun: 100 },
      vi.fn().mockResolvedValue('processed'));
    expect(stats.truncated).toBe(0);
  });

  it('parks the cursor when a truncated window yields nothing handled at all', async () => {
    const client = truncatedClient();
    client.fetchMetadata = vi.fn().mockRejectedValue(new Error('network flake'));
    seedState({ 'a@example.com': { lastHistoryId: '5' } });
    await poll({ clients: [{ client, label: 'A' }], statePath, maxPerRun: 100 },
      vi.fn().mockResolvedValue('processed'));
    expect(readStateFile().accounts['a@example.com'].lastHistoryId).toBe('5');
  });

  it('leaves the UNtruncated path exactly as it was — advances to now', async () => {
    const client = truncatedClient();
    client.getHistory = vi.fn().mockResolvedValue(
      historyResult(win, { truncated: false, historyIdById: hid }),
    );
    seedState({ 'a@example.com': { lastHistoryId: '5' } });
    await poll({ clients: [{ client, label: 'A' }], statePath, maxPerRun: 100 },
      vi.fn().mockResolvedValue('processed'));
    expect(readStateFile().accounts['a@example.com'].lastHistoryId).toBe('99999');
  });
});
