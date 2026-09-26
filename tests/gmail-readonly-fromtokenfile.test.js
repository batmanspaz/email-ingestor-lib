/**
 * fromTokenFile(account, entity, { readOnly }) threads the flag through to the
 * client (see gmail-readonly-guard.test.js for the guard contract itself).
 * fs + googleapis mocked; every value is synthetic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { apiCalls, mockExistsSync, mockReadFileSync } = vi.hoisted(() => ({
  apiCalls: [], mockExistsSync: vi.fn(), mockReadFileSync: vi.fn(),
}));

vi.mock('googleapis', () => {
  function OAuth2() { this.setCredentials = () => {}; }
  const modify = () => { apiCalls.push('users.messages.modify'); return Promise.resolve({}); };
  return {
    google: { auth: { OAuth2 }, gmail: vi.fn().mockReturnValue({ users: { messages: { modify } } }) },
  };
});
vi.mock('fs', () => {
  const api = { existsSync: mockExistsSync, readFileSync: mockReadFileSync };
  return { default: api, ...api };
});

import { GmailClient } from '../gmail.js';
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
