/**
 * Unit tests for gmail.js — GmailClient
 *
 * Tests cover:
 * - Constructor validation (required fields throw descriptive errors)
 * - GmailClient.getHeader (pure static method, no mocks needed)
 * - fromTokenFile error path (file not found)
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
  it('throws "Token file not found" when credential file is missing', () => {
    expect(() => GmailClient.fromTokenFile('nonexistent@example.com', 'test'))
      .toThrow('Token file not found');
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
