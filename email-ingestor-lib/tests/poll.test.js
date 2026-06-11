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

function makeMeta({ id, messageId, from = 'Sender <s@example.com>', subject = 'Test' }) {
  return {
    id,
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
    getHistory: vi.fn().mockResolvedValue(messages.map(m => m.id)),
    fetchMetadata: vi.fn().mockImplementation(async id => metaById[id]),
  };
}

function seedState(accounts) {
  fs.writeFileSync(statePath, JSON.stringify({ accounts, totalProcessed: 0 }), 'utf8');
}

function readStateFile() {
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

describe('poll — first run (no historyId)', () => {
  it('seeds historyId and writes state without calling handler', async () => {
    const client = makeClient({ currentHistoryId: '1234' });
    const handler = vi.fn();

    const stats = await poll({ clients: [{ client, label: 'A' }], statePath }, handler);

    expect(handler).not.toHaveBeenCalled();
    expect(stats).toEqual({ fetched: 0, processed: 0, errors: 0, forwarded: 0 });
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
    expect(stats).toEqual({ fetched: 2, processed: 2, errors: 0, forwarded: 0 });
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
    expect(stats).toEqual({ fetched: 2, processed: 2, errors: 0, forwarded: 0 });
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
