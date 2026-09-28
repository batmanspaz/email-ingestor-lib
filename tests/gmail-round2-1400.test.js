/**
 * tasks.db #1400 / PR #68 round 2 (Sonnet + Opus + Fable reviews). fs + googleapis mocked;
 * every value synthetic; no mailbox touched.
 *
 *  R1  a credentials file that exists but cannot be READ (EACCES/EPERM/EISDIR/ENOENT-after-exists)
 *      must not escape as a raw Node error (its message and .path carry the credential path).
 *  R2  optional non-PII `accountLabel`, so two mailboxes that mask to the same string are still
 *      told apart in a fatal log.
 *  R3  ReadOnlyScopeError.unexpectedScopes is a DISPLAY list; unexpectedScopeCount is the truth.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';

const { mockExistsSync, mockReadFileSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(), mockReadFileSync: vi.fn(),
}));

vi.mock('googleapis', () => {
  function OAuth2() { this.setCredentials = () => {}; }
  const gmail = vi.fn().mockReturnValue({ users: {} });
  function GoogleApis() { this.auth = { OAuth2 }; this.gmail = gmail; }
  return { google: { auth: { OAuth2 }, gmail }, GoogleApis };
});
vi.mock('fs', () => {
  const api = { existsSync: mockExistsSync, readFileSync: mockReadFileSync };
  return { default: api, ...api };
});

import { GmailClient } from '../gmail.js';
import * as lib from '../index.js';

const ADDR = 'token.person@example.com';
const MASKED = 't***@example.com';
const READONLY = 'https://www.googleapis.com/auth/gmail.readonly';
const isShared = (p) => String(p).includes('conductor_paul_client.json');
const rawFsError = (code, p) => Object.assign(new Error(`${code}: operation failed, open '${p}'`), { code, path: p, errno: -13, syscall: 'open' });

const capture = (opts) => {
  let err;
  try { GmailClient.fromTokenFile(ADDR, 'test-entity', opts); } catch (e) { err = e; }
  return err;
};
const expectNoPath = (err) => {
  const everything = [err.message, JSON.stringify(err), String(err.path), Object.keys(err).join(',')].join('\n');
  for (const needle of [os.homedir(), 'claude/shared/config', 'credentials/', `${ADDR}.json`, ADDR, '.json']) {
    expect(everything, `error text contains ${needle}`).not.toContain(needle);
  }
  expect(err.path).toBeUndefined();
  expect(err.cause).toBeUndefined();
  expect(err.errno).toBeUndefined();
  expect(err.syscall).toBeUndefined();
};

beforeEach(() => {
  mockExistsSync.mockReset().mockReturnValue(true);
  mockReadFileSync.mockReset();
});

describe('R1 — an unreadable credentials file is a typed, path-free error', () => {
  it.each(['EACCES', 'EPERM', 'EISDIR', 'ENOENT'])('token file read throws %s → TOKEN_FILE_INVALID, no path', (code) => {
    mockReadFileSync.mockImplementation((p) => { throw rawFsError(code, p); });
    for (const readOnly of [false, true]) {
      const err = capture(readOnly ? { readOnly: true } : undefined);
      expect(err).toBeInstanceOf(lib.TokenFileInvalidError);
      expect(err.code).toBe('TOKEN_FILE_INVALID');
      expect(err.message).toContain(MASKED);
      expect(err.message).toContain('token file is not readable');
      expectNoPath(err);
    }
  });

  it.each(['EACCES', 'EPERM', 'EISDIR', 'ENOENT'])('shared client file read throws %s → OAUTH_CLIENT_FILE_INVALID, no path', (code) => {
    mockReadFileSync.mockImplementation((p) => {
      if (isShared(p)) throw rawFsError(code, p);
      return JSON.stringify({ refresh_token: 'FAKE-refresh' }); // names no client of its own
    });
    const err = capture();
    expect(err).toBeInstanceOf(lib.OAuthClientFileError);
    expect(err.code).toBe('OAUTH_CLIENT_FILE_INVALID');
    expect(err.message).toContain('client file is not readable');
    expectNoPath(err);
  });

  it('a non-Error throw from readFileSync is also contained', () => {
    mockReadFileSync.mockImplementation(() => { throw 'boom /secret/path'; }); // eslint-disable-line no-throw-literal
    const err = capture();
    expect(err.code).toBe('TOKEN_FILE_INVALID');
    expect(err.message).not.toContain('/secret/path');
  });
});

describe('R2 — optional accountLabel distinguishes mailboxes that mask alike', () => {
  const tokenOk = { refresh_token: 'FAKE-refresh', client_id: 'FAKE-id', client_secret: 'FAKE-secret', scopes: [READONLY] };
  const label = 'pc-billing';

  it('every error class accepts a label: message + err.accountLabel', () => {
    const errs = [
      new lib.TokenFileMissingError(ADDR, label),
      new lib.RefreshTokenMissingError(ADDR, label),
      new lib.TokenFileInvalidError(ADDR, 'token file is not valid JSON', label),
      new lib.OAuthClientFileError('not found', label),
      new lib.ReadOnlyScopeError(ADDR, ['https://x.example/s'], '', label),
      new lib.ReadOnlyAccountError(ADDR, 'users.messages.modify', label),
    ];
    for (const e of errs) {
      expect(e.message, e.name).toContain(label);
      expect(e.accountLabel, e.name).toBe(label);
    }
  });

  it('default: no label in the message, err.accountLabel undefined, wording unchanged', () => {
    const errs = [
      new lib.TokenFileMissingError(ADDR), new lib.RefreshTokenMissingError(ADDR),
      new lib.TokenFileInvalidError(ADDR, 'x'), new lib.OAuthClientFileError('x'),
      new lib.ReadOnlyScopeError(ADDR), new lib.ReadOnlyAccountError(ADDR, 'op'),
    ];
    for (const e of errs) {
      expect(e.accountLabel, e.name).toBeUndefined();
      expect(e.message, e.name).not.toMatch(/undefined|\(\)|\[\]/);
    }
    expect(new lib.TokenFileMissingError(ADDR).message).toBe(`${MASKED}: token file not found — run the OAuth flow for this account`);
  });

  it('the label is sanitised + capped (caller-supplied text never injects control chars)', () => {
    const e = new lib.TokenFileMissingError(ADDR, `pc\nFAKE LOG LINE\u001b[31m${'x'.repeat(500)}`);
    expect(e.message).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(e.accountLabel.length).toBeLessThanOrEqual(lib.MAX_ACCOUNT_LABEL_LEN + 1);
    expect(e.message.length).toBeLessThan(400);
  });

  it('a non-string / empty label is treated as absent', () => {
    for (const bad of ['', 7, {}, null]) expect(new lib.TokenFileMissingError(ADDR, bad).accountLabel).toBeUndefined();
  });

  it('fromTokenFile threads opts.accountLabel into every failure', () => {
    const disks = {
      missing: () => { mockExistsSync.mockReturnValue(false); },
      invalid: () => { mockExistsSync.mockReturnValue(true); mockReadFileSync.mockReturnValue('{nope'); },
      unreadable: () => { mockReadFileSync.mockImplementation((p) => { throw rawFsError('EACCES', p); }); },
      norefresh: () => { mockReadFileSync.mockReturnValue(JSON.stringify({ client_id: 'a', client_secret: 'b' })); },
      badscope: () => { mockReadFileSync.mockReturnValue(JSON.stringify({ ...tokenOk, scopes: [READONLY, 'https://x.example/wide'] })); },
      sharedmissing: () => {
        mockExistsSync.mockImplementation((p) => !isShared(p));
        mockReadFileSync.mockReturnValue(JSON.stringify({ refresh_token: 'FAKE' }));
      },
    };
    for (const [name, setup] of Object.entries(disks)) {
      mockExistsSync.mockReset().mockReturnValue(true);
      mockReadFileSync.mockReset();
      setup();
      const err = capture({ readOnly: name === 'badscope', accountLabel: label });
      expect(err, name).toBeInstanceOf(Error);
      expect(err.accountLabel, name).toBe(label);
      expect(err.message, name).toContain(label);
      expect(err.message, name).not.toContain(ADDR);
    }
  });

  it('threads through the client constructor into the read-only guard and refresh-scope errors', () => {
    const c = new GmailClient({
      account: ADDR, refreshToken: 'FAKE', clientId: 'FAKE-id', clientSecret: 'FAKE-s', readOnly: true, accountLabel: label,
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let err;
    try { void c._gmail.auth; } catch (e) { err = e; } // googleapis internals are blocked → denyWrite
    expect(err?.code).toBe('READ_ONLY_ACCOUNT');
    expect(err.accountLabel).toBe(label);
    expect(err.message).toContain(label);
  });
});

describe('R3 — unexpectedScopes is display-only; unexpectedScopeCount is the true total', () => {
  it('count is the real number, list is capped with a synthetic entry', () => {
    const many = Array.from({ length: 300 }, (_, i) => `https://evil.example/s${i}`);
    const err = new lib.ReadOnlyScopeError(ADDR, many);
    expect(err.unexpectedScopeCount).toBe(300);
    expect(err.unexpectedScopes).toHaveLength(lib.MAX_ECHOED_SCOPES + 1);
    expect(err.unexpectedScopes.at(-1)).toBe(`(+${300 - lib.MAX_ECHOED_SCOPES} more)`);
  });
  it('count is 0 when nothing offending was listed, and equals the list length when short', () => {
    expect(new lib.ReadOnlyScopeError(ADDR).unexpectedScopeCount).toBe(0);
    const e = new lib.ReadOnlyScopeError(ADDR, ['https://a.example/x', 'https://b.example/y']);
    expect(e.unexpectedScopeCount).toBe(2);
    expect(e.unexpectedScopes).toHaveLength(2);
  });
  it('end to end: a token file with 8 wider scopes reports count 8', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      refresh_token: 'FAKE', client_id: 'a', client_secret: 'b',
      scopes: [READONLY, ...Array.from({ length: 8 }, (_, i) => `https://x.example/w${i}`)],
    }));
    const err = capture({ readOnly: true });
    expect(err.code).toBe('READ_ONLY_SCOPE_MISMATCH');
    expect(err.unexpectedScopeCount).toBe(8);
  });
});

describe('R4 — exports, engines, README', () => {
  it('index.js re-exports the guard constants + helper', () => {
    expect(lib.MAX_TIMEOUT_MS).toBe(2 ** 31 - 1);
    expect(typeof lib.safeScopeList).toBe('function');
    expect(lib.MAX_ECHOED_SCOPES).toBeGreaterThan(0);
    expect(lib.MAX_ECHOED_SCOPE_LEN).toBeGreaterThan(0);
    expect(lib.MAX_ACCOUNT_LABEL_LEN).toBeGreaterThan(0);
  });
});
