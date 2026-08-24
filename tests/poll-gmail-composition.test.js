/**
 * poll() driving a REAL GmailClient — composition, not mocks-of-mocks.
 *
 * Why this file exists. poll.test.js stubs the client, and gmail.test.js stubs
 * googleapis; neither ever runs the two real modules against each other. On
 * 2026-08-23 that gap cost twice in one afternoon:
 *
 *  1. getHistory's return shape changed from a bare array to an object, and the
 *     whole suite stayed GREEN while poll.js was broken against real gmail.js —
 *     because poll.test.js's mocks still returned the old shape.
 *  2. The per-message-vs-per-record watermark blocker was invisible to
 *     poll.test.js, whose helper assigns every message a DISTINCT historyId.
 *     Real Gmail history records carry an ARRAY of messagesAdded, so a record
 *     can hold both a handled and an unhandled message. Two independent audits
 *     found it; the suite could not.
 *
 * So this stubs only the outermost boundary — googleapis — and lets real
 * GmailClient and real poll() compose.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { mockHistoryList, mockMessagesGet, mockGetProfile, mockBatchModify } = vi.hoisted(() => ({
  mockHistoryList: vi.fn(),
  mockMessagesGet: vi.fn(),
  mockGetProfile: vi.fn(),
  mockBatchModify: vi.fn(),
}));

vi.mock('googleapis', () => {
  function OAuth2() { this.setCredentials = vi.fn(); }
  return {
    google: {
      auth: { OAuth2 },
      gmail: vi.fn().mockReturnValue({
        users: {
          history: { list: mockHistoryList },
          messages: { get: mockMessagesGet, batchModify: mockBatchModify },
          getProfile: mockGetProfile,
        },
      }),
    },
  };
});

import { GmailClient } from '../gmail.js';
import { poll } from '../poll.js';

let tmpDir, statePath;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-composition-'));
  statePath = path.join(tmpDir, 'state.json');
  vi.clearAllMocks();
  mockGetProfile.mockResolvedValue({ data: { historyId: '99999' } });
  mockBatchModify.mockResolvedValue({});
  mockMessagesGet.mockImplementation(async ({ id }) => ({
    data: { id, labelIds: ['INBOX'], payload: { headers: [
      { name: 'Message-ID', value: `<${id}@example.com>` },
      { name: 'From', value: 'someone@example.com' },
      { name: 'Subject', value: `subject ${id}` },
    ] } },
  }));
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const client = () => new GmailClient({
  account: 'real@example.com', refreshToken: 'rt', clientId: 'ci', clientSecret: 'cs', entity: 'test',
});
const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
const seed = (lastHistoryId) => fs.writeFileSync(statePath, JSON.stringify({
  accounts: { 'real@example.com': { lastHistoryId, processedIds: [] } }, totalProcessed: 0,
}));

/** A history record carrying SEVERAL messages — the shape mocks kept flattening. */
const rec = (id, ...msgs) => ({ id: String(id), messagesAdded: msgs.map((m) => ({ message: { id: m } })) });

describe('poll() + real GmailClient', () => {
  it('carries a truncated window end to end without losing a shared-record sibling', async () => {
    // 500 ids across records that each hold TWO messages, with a page still
    // pending -> genuinely truncated. maxPerRun cuts mid-record, so the last
    // touched record has one handled and one unhandled message.
    const records = [];
    for (let i = 0; i < 250; i++) records.push(rec(1000 + i, `m${i}a`, `m${i}b`));
    mockHistoryList.mockResolvedValue({ data: { history: records, nextPageToken: 'more' } });
    seed('999');

    const handled = [];
    await poll({ clients: [{ client: client(), label: 'R' }], statePath, maxPerRun: 5 },
      async (meta) => { handled.push(meta.id); return 'processed'; });

    const cursor = readState().accounts['real@example.com'].lastHistoryId;
    // Whatever the cursor became, every message belonging to a record at or
    // before it must have been handled. That is the entire safety property.
    for (const r of records) {
      if (BigInt(r.id) <= BigInt(cursor)) {
        for (const { message } of r.messagesAdded) {
          expect(handled, `record ${r.id} passed but ${message.id} was not handled`).toContain(message.id);
        }
      }
    }
  });

  it('drains a multi-record truncated backlog across runs with no loss and no duplicates', async () => {
    const records = [];
    for (let i = 0; i < 20; i++) records.push(rec(1000 + i, `m${i}a`, `m${i}b`));
    // Exclusive startHistoryId, as Gmail documents: records AFTER the cursor.
    // Honour pageToken, so truncation arises from a modeled multi-page backlog
    // rather than from the mock re-serving the same records until the cap trips.
    mockHistoryList.mockImplementation(async ({ startHistoryId, pageToken }) => {
      const remaining = records.filter((r) => BigInt(r.id) > BigInt(startHistoryId));
      const page = Number(pageToken || 0);
      const slice = remaining.slice(page * 5, page * 5 + 5);
      const more = remaining.length > (page + 1) * 5;
      return { data: { history: slice, nextPageToken: more ? String(page + 1) : null } };
    });
    seed('999');

    const handled = [];
    for (let run = 0; run < 30; run++) {
      await poll({ clients: [{ client: client(), label: 'R' }], statePath, maxPerRun: 3 },
        async (meta) => { handled.push(meta.id); return 'processed'; });
    }
    const expected = records.flatMap((r) => r.messagesAdded.map((m) => m.message.id));
    expect(new Set(handled).size).toBe(expected.length);   // every message reached
    expect(handled.length).toBe(new Set(handled).size);    // none processed twice
  });

  it('does not treat 500-of-500-with-no-next-page as truncated', async () => {
    const records = [];
    for (let i = 0; i < 250; i++) records.push(rec(1000 + i, `m${i}a`, `m${i}b`));
    mockHistoryList.mockResolvedValue({ data: { history: records, nextPageToken: null } });
    seed('999');
    await poll({ clients: [{ client: client(), label: 'R' }], statePath, maxPerRun: 1000 },
      async () => 'processed');
    // Complete window, fully drained -> the untruncated path advances to now.
    expect(readState().accounts['real@example.com'].lastHistoryId).toBe('99999');
  });
});
