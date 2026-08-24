/**
 * Unit tests for gmail.js — GmailClient
 *
 * Tests cover:
 * - Constructor validation (required fields throw descriptive errors)
 * - GmailClient.getHeader (pure static method, no mocks needed)
 * - fromTokenFile error path (file not found)
 * - getHistory() paging, the 500-cap truncation signal, and historyId exposure
 * - archive() delegates to removeLabels
 * - createDraft() builds valid RFC 2822 base64 raw message
 * - sendEmail() builds valid raw message
 *
 * googleapis is mocked — no real Gmail API calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock googleapis before the module is imported ──────────────────────────
// vi.hoisted ensures these fns are available when the factory runs (hoisted to top)

const {
  mockDraftsCreate, mockModify, mockSend, mockTrash,
  mockMessagesList, mockMessagesGet, mockLabelsList,
  mockHistoryList, mockGetProfile, mockSetCredentials,
} = vi.hoisted(() => ({
  mockDraftsCreate: vi.fn(),
  mockModify: vi.fn(),
  mockSend: vi.fn(),
  mockTrash: vi.fn(),
  mockMessagesList: vi.fn(),
  mockMessagesGet: vi.fn(),
  mockLabelsList: vi.fn(),
  mockHistoryList: vi.fn(),
  mockGetProfile: vi.fn(),
  mockSetCredentials: vi.fn(),
}));

vi.mock('googleapis', () => {
  // Use a plain constructor function so `new OAuth2()` creates a proper instance
  function OAuth2() {
    this.setCredentials = mockSetCredentials;
  }
  const gmailUsers = {
    messages: {
      get: mockMessagesGet,
      send: mockSend,
      modify: mockModify,
      trash: mockTrash,
      list: mockMessagesList,
      attachments: { get: vi.fn() },
    },
    drafts: { create: mockDraftsCreate },
    labels: { list: mockLabelsList },
    history: { list: mockHistoryList },
    getProfile: mockGetProfile,
  };
  return {
    google: {
      auth: { OAuth2 },
      gmail: vi.fn().mockReturnValue({ users: gmailUsers }),
    },
  };
});

import { GmailClient } from '../gmail.js';

const BASE_CONFIG = {
  account: 'test@example.com',
  refreshToken: 'rt_fake',
  clientId: 'client_id_fake',
  clientSecret: 'client_secret_fake',
  entity: 'test-entity',
};

// ── Constructor ─────────────────────────────────────────────────────────────

describe('GmailClient constructor', () => {
  it('constructs without error when all required fields provided', () => {
    expect(() => new GmailClient(BASE_CONFIG)).not.toThrow();
  });

  it('stores account and entity', () => {
    const client = new GmailClient(BASE_CONFIG);
    expect(client.account).toBe('test@example.com');
    expect(client.entity).toBe('test-entity');
  });

  it('defaults entity to Unknown when not provided', () => {
    const { entity, ...rest } = BASE_CONFIG;
    const client = new GmailClient(rest);
    expect(client.entity).toBe('Unknown');
  });

  it('throws "account required" when account is missing', () => {
    const { account, ...rest } = BASE_CONFIG;
    expect(() => new GmailClient(rest)).toThrow('account required');
  });

  it('throws "refreshToken required" when refreshToken is missing', () => {
    const { refreshToken, ...rest } = BASE_CONFIG;
    expect(() => new GmailClient(rest)).toThrow('refreshToken required');
  });

  it('throws "clientId required" when clientId is missing', () => {
    const { clientId, ...rest } = BASE_CONFIG;
    expect(() => new GmailClient(rest)).toThrow('clientId required');
  });

  it('throws "clientSecret required" when clientSecret is missing', () => {
    const { clientSecret, ...rest } = BASE_CONFIG;
    expect(() => new GmailClient(rest)).toThrow('clientSecret required');
  });

  it('throws when config is null', () => {
    expect(() => new GmailClient(null)).toThrow();
  });
});

// ── GmailClient.getHeader ────────────────────────────────────────────────────

describe('GmailClient.getHeader', () => {
  const msg = {
    payload: {
      headers: [
        { name: 'Subject', value: 'Hello World' },
        { name: 'From', value: 'sender@example.com' },
        { name: 'Date', value: 'Mon, 1 Jan 2026 00:00:00 +0000' },
      ],
    },
  };

  it('returns the header value by exact name', () => {
    expect(GmailClient.getHeader(msg, 'Subject')).toBe('Hello World');
    expect(GmailClient.getHeader(msg, 'From')).toBe('sender@example.com');
  });

  it('is case-insensitive (Subject === subject === SUBJECT)', () => {
    expect(GmailClient.getHeader(msg, 'subject')).toBe('Hello World');
    expect(GmailClient.getHeader(msg, 'FROM')).toBe('sender@example.com');
  });

  it('returns empty string when header is not present', () => {
    expect(GmailClient.getHeader(msg, 'X-Custom-Header')).toBe('');
  });

  it('returns empty string when message has no payload', () => {
    expect(GmailClient.getHeader({}, 'Subject')).toBe('');
  });

  it('returns empty string when payload has no headers array', () => {
    expect(GmailClient.getHeader({ payload: {} }, 'Subject')).toBe('');
  });
});

// ── fromTokenFile error path ─────────────────────────────────────────────────

describe('GmailClient.fromTokenFile', () => {
  it('throws a "file not found" error when credential files are missing', () => {
    expect(() => GmailClient.fromTokenFile('nonexistent@example.com', 'test'))
      .toThrow(/not found/i);
  });
});

// ── archive ──────────────────────────────────────────────────────────────────

describe('GmailClient#archive', () => {
  it('delegates to removeLabels([INBOX]) and returns its result', async () => {
    const client = new GmailClient(BASE_CONFIG);
    client.removeLabels = vi.fn().mockResolvedValue({ ok: true, id: 'msg-abc' });

    const result = await client.archive('msg-abc');

    expect(client.removeLabels).toHaveBeenCalledWith('msg-abc', ['INBOX']);
    expect(result).toEqual({ ok: true, id: 'msg-abc' });
  });
});

// ── createDraft ──────────────────────────────────────────────────────────────

describe('GmailClient#createDraft', () => {
  let client;

  beforeEach(() => {
    client = new GmailClient(BASE_CONFIG);
    mockDraftsCreate.mockReset();
  });

  function decode(raw) {
    return Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
  }

  it('returns ok=true, draftId, and threadId', async () => {
    mockDraftsCreate.mockResolvedValue({
      data: { id: 'draft-001', message: { threadId: 'thread-001' } },
    });

    const result = await client.createDraft({ to: 'r@example.com', subject: 'S', body: 'B' });
    expect(result.ok).toBe(true);
    expect(result.draftId).toBe('draft-001');
    expect(result.threadId).toBe('thread-001');
  });

  it('encodes From, To, Subject, and body in raw RFC 2822 format', async () => {
    mockDraftsCreate.mockImplementation(async ({ requestBody }) => {
      const decoded = decode(requestBody.message.raw);
      expect(decoded).toContain(`From: ${BASE_CONFIG.account}`);
      expect(decoded).toContain('To: recipient@example.com');
      expect(decoded).toContain('Subject: Test Subject');
      expect(decoded).toContain('Test body text');
      return { data: { id: 'd1', message: { threadId: 't1' } } };
    });

    await client.createDraft({
      to: 'recipient@example.com',
      subject: 'Test Subject',
      body: 'Test body text',
    });
    expect(mockDraftsCreate).toHaveBeenCalledOnce();
  });

  it('includes Cc line when cc is provided', async () => {
    mockDraftsCreate.mockImplementation(async ({ requestBody }) => {
      const decoded = decode(requestBody.message.raw);
      expect(decoded).toContain('Cc: cc@example.com');
      return { data: { id: 'd1', message: {} } };
    });

    await client.createDraft({
      to: 'r@example.com', subject: 'S', body: 'B', cc: 'cc@example.com',
    });
  });

  it('omits Cc line when cc is not provided', async () => {
    mockDraftsCreate.mockImplementation(async ({ requestBody }) => {
      const decoded = decode(requestBody.message.raw);
      expect(decoded).not.toMatch(/^Cc:/m);
      return { data: { id: 'd1', message: {} } };
    });

    await client.createDraft({ to: 'r@example.com', subject: 'S', body: 'B' });
  });

  it('includes In-Reply-To and References when provided', async () => {
    mockDraftsCreate.mockImplementation(async ({ requestBody }) => {
      const decoded = decode(requestBody.message.raw);
      expect(decoded).toContain('In-Reply-To: <msg-id@example.com>');
      expect(decoded).toContain('References: <msg-id@example.com>');
      return { data: { id: 'd1', message: {} } };
    });

    await client.createDraft({
      to: 'r@example.com', subject: 'Re: S', body: 'B',
      inReplyTo: '<msg-id@example.com>',
      references: '<msg-id@example.com>',
    });
  });

  it('includes threadId in requestBody when threadId is provided', async () => {
    mockDraftsCreate.mockImplementation(async ({ requestBody }) => {
      expect(requestBody.message.threadId).toBe('thread-xyz');
      return { data: { id: 'd1', message: { threadId: 'thread-xyz' } } };
    });

    await client.createDraft({
      to: 'r@example.com', subject: 'S', body: 'B', threadId: 'thread-xyz',
    });
  });

  it('accepts an array for to and joins with comma', async () => {
    mockDraftsCreate.mockImplementation(async ({ requestBody }) => {
      const decoded = decode(requestBody.message.raw);
      expect(decoded).toContain('To: a@example.com, b@example.com');
      return { data: { id: 'd1', message: {} } };
    });

    await client.createDraft({
      to: ['a@example.com', 'b@example.com'], subject: 'S', body: 'B',
    });
  });
});

// ── sendEmail ────────────────────────────────────────────────────────────────

describe('GmailClient#sendEmail', () => {
  let client;

  beforeEach(() => {
    client = new GmailClient(BASE_CONFIG);
    mockSend.mockReset();
  });

  function decode(raw) {
    return Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
  }

  it('returns ok=true and message id', async () => {
    mockSend.mockResolvedValue({ data: { id: 'sent-001' } });

    const result = await client.sendEmail({
      to: 'r@example.com', subject: 'S', body: 'B',
    });
    expect(result).toEqual({ ok: true, id: 'sent-001' });
  });

  it('encodes To, Subject, and body in raw format', async () => {
    mockSend.mockImplementation(async ({ requestBody }) => {
      const decoded = decode(requestBody.raw);
      expect(decoded).toContain('To: r@example.com');
      expect(decoded).toContain('Subject: Hello');
      expect(decoded).toContain('Body text');
      return { data: { id: 's1' } };
    });

    await client.sendEmail({ to: 'r@example.com', subject: 'Hello', body: 'Body text' });
  });
});

// ── getHistory — truncation + historyId watermark ───────────────────────────
// Added 2026-08-23. getHistory previously had NO direct tests, and it is the
// function the mail-loss incident rests on: it hard-capped at 500 ids, DISCARDED
// the pageToken, and returned a bare array — so poll() could not distinguish
// 500-of-500 from 500-of-5000 and advanced its cursor past messages that were
// never listed. 44 real occurrences on personal. The caller cannot be written
// correctly against a return value that cannot express truncation.

describe('GmailClient.getHistory', () => {
  beforeEach(() => {
    mockHistoryList.mockReset();
  });

  /** Build a history.list page: records ascending by historyId. */
  const page = (records, nextPageToken = null) => ({
    data: { history: records, nextPageToken },
  });
  /** One history record carrying its own historyId (`record.id`). */
  const rec = (historyId, ...messageIds) => ({
    id: String(historyId),
    messagesAdded: messageIds.map((id) => ({ message: { id } })),
  });

  it('returns every id with truncated:false for a single complete page', async () => {
    mockHistoryList.mockResolvedValueOnce(page([rec(1001, 'm1', 'm2'), rec(1002, 'm3')]));
    const r = await new GmailClient(BASE_CONFIG).getHistory('1000');
    expect(r.ids).toEqual(['m1', 'm2', 'm3']);
    expect(r.truncated).toBe(false);
  });

  it('follows pageToken across MULTIPLE pages and still reports truncated:false', async () => {
    mockHistoryList
      .mockResolvedValueOnce(page([rec(1001, 'm1')], 'tok'))
      .mockResolvedValueOnce(page([rec(1002, 'm2')]));
    const r = await new GmailClient(BASE_CONFIG).getHistory('1000');
    expect(r.ids).toEqual(['m1', 'm2']);
    expect(r.truncated).toBe(false);
    expect(mockHistoryList.mock.calls[1][0].pageToken).toBe('tok');
  });

  it('reports truncated:true when the 500 cap is struck with a pageToken still pending', async () => {
    // THE BUG: this is the state that was previously indistinguishable from a
    // complete window. 500 ids AND more pages waiting.
    const many = Array.from({ length: 500 }, (_, i) => rec(2000 + i, `m${i}`));
    mockHistoryList.mockResolvedValueOnce(page(many, 'more-please'));
    const r = await new GmailClient(BASE_CONFIG).getHistory('1000');
    expect(r.ids).toHaveLength(500);
    expect(r.truncated).toBe(true);
  });

  it('does NOT report truncated when exactly 500 arrive and no page remains', async () => {
    // 500-of-500 is complete, not truncated. Distinguishing these two is the
    // entire point; treating the cap value itself as the signal would be wrong.
    const many = Array.from({ length: 500 }, (_, i) => rec(2000 + i, `m${i}`));
    mockHistoryList.mockResolvedValueOnce(page(many, null));
    const r = await new GmailClient(BASE_CONFIG).getHistory('1000');
    expect(r.ids).toHaveLength(500);
    expect(r.truncated).toBe(false);
  });

  it('exposes each message historyId, and the last enumerated historyId', async () => {
    // record.id is returned by the API today and was being discarded. It is the
    // information the cursor watermark needs.
    mockHistoryList.mockResolvedValueOnce(page([rec(1001, 'm1', 'm2'), rec(1005, 'm3')]));
    const r = await new GmailClient(BASE_CONFIG).getHistory('1000');
    expect(r.historyIdById).toEqual({ m1: '1001', m2: '1001', m3: '1005' });
    expect(r.lastEnumeratedHistoryId).toBe('1005');
  });

  it('preserves ascending historyId order — the watermark depends on it', async () => {
    mockHistoryList.mockResolvedValueOnce(page([rec(10, 'a'), rec(20, 'b'), rec(30, 'c')]));
    const r = await new GmailClient(BASE_CONFIG).getHistory('1');
    const order = r.ids.map((id) => Number(r.historyIdById[id]));
    expect(order).toEqual([...order].sort((x, y) => x - y));
  });

  it('returns an empty result (not null) for an empty window', async () => {
    mockHistoryList.mockResolvedValueOnce(page([]));
    const r = await new GmailClient(BASE_CONFIG).getHistory('1000');
    expect(r.ids).toEqual([]);
    expect(r.truncated).toBe(false);
    expect(r.lastEnumeratedHistoryId).toBeNull();
  });

  it('returns EXACTLY the keys poll.js destructures — guards mock/real drift', async () => {
    // poll.js does: const { ids, truncated, historyIdById } = history
    // (lastEnumeratedHistoryId is returned for diagnostics and is not read by
    // poll — see tests/poll-gmail-composition.test.js for the composed path).
    // When getHistory's shape changed
    // on 2026-08-23, poll.test.js's mocks still returned the OLD bare array and
    // the whole suite stayed green while poll.js was broken against real
    // gmail.js. This pins the producer side of that contract; poll.test.js's
    // historyResult() helper is the consumer side.
    mockHistoryList.mockResolvedValueOnce(page([rec(1001, 'm1')]));
    const r = await new GmailClient(BASE_CONFIG).getHistory('1000');
    expect(Object.keys(r).sort()).toEqual(
      ['historyIdById', 'ids', 'lastEnumeratedHistoryId', 'truncated'].sort(),
    );
  });

  it('still returns null on 404 — history expired, caller resets', async () => {
    const err = new Error('Requested entity was not found'); err.code = 404;
    mockHistoryList.mockRejectedValueOnce(err);
    expect(await new GmailClient(BASE_CONFIG).getHistory('1000')).toBeNull();
  });

  it('still throws on a non-404 error', async () => {
    mockHistoryList.mockRejectedValue(new Error('boom'));
    await expect(new GmailClient(BASE_CONFIG).getHistory('1000')).rejects.toThrow('boom');
  });
});
