/**
 * fromTokenFile(account, entity, { readOnly }) threads the flag through to the
 * client (see gmail-readonly-guard.test.js for the guard contract itself).
 * fs + googleapis mocked; every value is synthetic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { apiCalls, mockExistsSync, mockReadFileSync, appended } = vi.hoisted(() => ({
  apiCalls: [], mockExistsSync: vi.fn(), mockReadFileSync: vi.fn(), appended: [],
}));

vi.mock('googleapis', () => {
  function OAuth2() { this.setCredentials = () => {}; }
  const modify = () => { apiCalls.push('users.messages.modify'); return Promise.resolve({}); };
  const gmail = vi.fn().mockReturnValue({ users: { messages: { modify } } });
  // readOnly clients are built from their OWN GoogleApis instance (A2), not the shared singleton.
  function GoogleApis() { this.auth = { OAuth2 }; this.gmail = gmail; }
  return { google: { auth: { OAuth2 }, gmail }, GoogleApis };
});
vi.mock('fs', () => {
  const api = {
    existsSync: mockExistsSync, readFileSync: mockReadFileSync,
    appendFileSync: (_p, line) => { appended.push(line); }, mkdirSync: () => {},
  };
  return { default: api, ...api };
});

import { GmailClient } from '../gmail.js';
import { createLogger } from '../log.js';
import { ReadOnlyScopeError } from '../readonly-guard.js';

const ADDR = 'read.only.person@example.com';
const READONLY = 'https://www.googleapis.com/auth/gmail.readonly';
beforeEach(() => {
  apiCalls.length = 0;
  mockExistsSync.mockReset().mockReturnValue(true);
  mockReadFileSync.mockReset().mockImplementation(() => JSON.stringify({
    refresh_token: 'FAKE', client_id: 'FAKE-id', client_secret: 'FAKE-secret',
    scopes: [READONLY],
  }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('fromTokenFile threads readOnly through', () => {
  it('readOnly:true via options blocks writes', async () => {
    const c = GmailClient.fromTokenFile(ADDR, 'test-entity', { readOnly: true });
    expect(c.readOnly).toBe(true);
    await expect(c.archive('m1')).rejects.toMatchObject({ code: 'READ_ONLY_ACCOUNT' });
    expect(apiCalls).toEqual([]);
  });
  it('defaults to writable when no options are passed', async () => {
    const c = GmailClient.fromTokenFile(ADDR, 'test-entity');
    expect(c.readOnly).toBe(false);
    await c.archive('m1');
    expect(apiCalls).toEqual(['users.messages.modify']);
  });
});

// L4 (Opus, the strongest control): a readOnly client is only ever built from a token
// whose GRANTED scopes are exactly [gmail.readonly] — so Google itself refuses writes,
// even for a caller that bypasses the proxy. Fails closed, per account, with a typed error.
describe('L4 — fromTokenFile({readOnly}) fails closed unless scopes are exactly gmail.readonly', () => {
  const tokenWith = (extra) => mockReadFileSync.mockImplementation(() => JSON.stringify({
    refresh_token: 'SECRET-REFRESH-VALUE', client_id: 'FAKE-id', client_secret: 'SECRET-CLIENT-VALUE', ...extra,
  }));
  const build = () => GmailClient.fromTokenFile(ADDR, 'test-entity', { readOnly: true });

  it('accepts exactly [gmail.readonly]', () => {
    tokenWith({ scopes: [READONLY] });
    expect(build().readOnly).toBe(true);
  });

  it.each([
    ['gmail.modify added', [READONLY, 'https://www.googleapis.com/auth/gmail.modify']],
    ['gmail.modify only', ['https://www.googleapis.com/auth/gmail.modify']],
    ['gmail.send added', [READONLY, 'https://www.googleapis.com/auth/gmail.send']],
    ['gmail.compose added', [READONLY, 'https://www.googleapis.com/auth/gmail.compose']],
    ['full mail scope added', [READONLY, 'https://mail.google.com/']],
    ['drive added', [READONLY, 'https://www.googleapis.com/auth/drive']],
    ['openid/email added', [READONLY, 'openid', 'email']],
    ['empty array', []],
    ['a different read scope', ['https://www.googleapis.com/auth/gmail.metadata']],
  ])('rejects %s', (_n, scopes) => {
    tokenWith({ scopes });
    expect(build).toThrow(ReadOnlyScopeError);
  });

  it.each([
    ['scopes missing', {}],
    ['scopes is a string', { scopes: READONLY }],
    ['scopes null', { scopes: null }],
    ['scopes has a non-string', { scopes: [READONLY, 7] }],
    ['only the singular `scope` string is present', { scope: READONLY }],
  ])('fails closed when %s', (_n, extra) => {
    tokenWith(extra);
    expect(build).toThrow(ReadOnlyScopeError);
  });

  it('the error is typed, per-account, names the offending scopes, and leaks no token contents', () => {
    tokenWith({ scopes: [READONLY, 'https://www.googleapis.com/auth/gmail.modify'] });
    let err;
    try { build(); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ReadOnlyScopeError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ReadOnlyScopeError');
    expect(err.code).toBe('READ_ONLY_SCOPE_MISMATCH');
    expect(err.message).toContain('r***@example.com');
    expect(err.message).not.toContain(ADDR);
    expect(err.message).toContain('gmail.modify');
    expect(err.message).not.toMatch(/SECRET-REFRESH-VALUE|SECRET-CLIENT-VALUE|FAKE-id/);
    expect(err.account).toBe('r***@example.com');
  });

  it('a non-readOnly fromTokenFile is unaffected by scopes (modify token still fine)', () => {
    tokenWith({ scopes: [READONLY, 'https://www.googleapis.com/auth/gmail.modify'] });
    expect(GmailClient.fromTokenFile(ADDR, 'test-entity').readOnly).toBe(false);
    tokenWith({});
    expect(GmailClient.fromTokenFile(ADDR, 'test-entity').readOnly).toBe(false);
  });
});

// A4 (Opus): 'exactly [gmail.readonly]' means ONE entry. The old Set() de-duplication let
// [ro, ro] through.
describe('A4 — duplicate scope entries are rejected ("exactly" means one entry)', () => {
  const tokenWith = (extra) => mockReadFileSync.mockImplementation(() => JSON.stringify({
    refresh_token: 'SECRET-REFRESH-VALUE', client_id: 'FAKE-id', client_secret: 'SECRET-CLIENT-VALUE', ...extra,
  }));
  const build = () => GmailClient.fromTokenFile(ADDR, 'test-entity', { readOnly: true });
  it.each([
    ['[ro, ro]', [READONLY, READONLY]],
    ['[ro, ro, ro]', [READONLY, READONLY, READONLY]],
    ['[ro, modify, ro]', [READONLY, 'https://www.googleapis.com/auth/gmail.modify', READONLY]],
  ])('rejects %s', (_n, scopes) => {
    tokenWith({ scopes });
    expect(build).toThrow(ReadOnlyScopeError);
  });
  it('the duplicate error is typed, masked, and says why', () => {
    tokenWith({ scopes: [READONLY, READONLY] });
    let err;
    try { build(); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ReadOnlyScopeError);
    expect(err.message).toContain('r***@example.com');
    expect(err.message).toMatch(/more than once|duplicate/i);
    expect(err.message).not.toMatch(/SECRET-REFRESH-VALUE|SECRET-CLIENT-VALUE/);
  });
  it('a single [ro] still passes', () => {
    tokenWith({ scopes: [READONLY] });
    expect(build().readOnly).toBe(true);
  });
});

// A3 (Opus, real leak): a JSON.parse SyntaxError quotes part of the malformed file, which
// can include a bare token value. The error must name only the masked address + a fixed reason.
describe('A3 — a malformed token file never leaks its contents through the error', () => {
  const SECRET = '1//0gFAKE-BARE-REFRESH-TOKEN-ZZZ';
  const CSECRET = 'GOCSPX-FAKE-CLIENT-SECRET-QQQ';
  const malformed = [
    ['bare token value', SECRET],
    ['unquoted value after key', `{"refresh_token": ${SECRET}, "client_secret": "${CSECRET}"}`],
    ['truncated mid-secret', `{"refresh_token": "${SECRET}", "client_secret": "${CSECRET.slice(0, 12)}`],
    ['missing comma', `{"refresh_token": "${SECRET}" "client_secret": "${CSECRET}"}`],
    ['trailing garbage', `{"refresh_token": "${SECRET}"} ${CSECRET}`],
    ['single quotes', `{'refresh_token': '${SECRET}'}`],
  ];
  const capture = (readOnly) => {
    let err;
    try { GmailClient.fromTokenFile(ADDR, 'test-entity', readOnly ? { readOnly: true } : undefined); } catch (e) { err = e; }
    return err;
  };

  it.each(malformed)('%s: message/stack/log line carry none of the file', (_n, body) => {
    for (const readOnly of [true, false]) {
      mockReadFileSync.mockImplementation(() => body);
      appended.length = 0;
      const err = capture(readOnly);
      expect(err, 'expected an error').toBeInstanceOf(Error);
      expect(err.name).toBe('TokenFileInvalidError');
      expect(err.code).toBe('TOKEN_FILE_INVALID');
      expect(err.message).toContain('r***@example.com');
      expect(err.message).toContain('token file is not valid JSON');
      expect(err.message).not.toContain(ADDR);
      expect(err).not.toBeInstanceOf(SyntaxError);
      expect(err.cause).toBeUndefined();
      const logger = createLogger('test-entity', '/tmp/never-written.jsonl');
      logger.error('fromTokenFile', err);
      const everything = [err.message, err.stack, ...appended, JSON.stringify(err)].join('\n');
      for (const needle of [SECRET, CSECRET, CSECRET.slice(0, 12), 'refresh_token', 'Unexpected token', 'in JSON at position']) {
        expect(everything, `leaked ${needle}`).not.toContain(needle);
      }
      expect(appended).toHaveLength(1);
    }
  });

  it('valid JSON that is not an object (string/array/null) fails the same clean way', () => {
    for (const body of [`"${SECRET}"`, `["${SECRET}"]`, 'null', '42']) {
      mockReadFileSync.mockImplementation(() => body);
      const err = capture(true);
      expect(err.name).toBe('TokenFileInvalidError');
      expect(`${err.message}\n${err.stack}`).not.toContain(SECRET);
    }
  });

  it('a malformed shared OAuth-client file (fallback) is also masked', () => {
    mockReadFileSync.mockImplementation((p) => (String(p).endsWith('conductor_paul_client.json')
      ? `{"installed": {"client_secret": ${CSECRET}}`
      : JSON.stringify({ refresh_token: 'FAKE', scopes: [READONLY] })));
    const err = capture(true);
    expect(err).toBeInstanceOf(Error);
    expect(`${err.message}\n${err.stack}`).not.toContain(CSECRET);
    expect(err.message).toContain('not valid JSON');
  });
});

// A4 (docs): fromTokenFile WITHOUT opts builds a WRITABLE client — other callers rely on it.
// This is deliberate, and README says so plainly.
describe('A4 — fromTokenFile without opts is WRITABLE (documented, deliberately unchanged)', () => {
  it('no opts, opts:{} and readOnly:false all build a writable client that reaches modify', async () => {
    for (const opts of [undefined, {}, { readOnly: false }]) {
      apiCalls.length = 0;
      const c = GmailClient.fromTokenFile(ADDR, 'test-entity', opts);
      expect(c.readOnly).toBe(false);
      await c._gmail.users.messages.modify({ userId: 'me', id: 'm1' });
      expect(apiCalls).toEqual(['users.messages.modify']);
    }
  });
});
