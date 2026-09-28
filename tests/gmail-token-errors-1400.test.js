/**
 * tasks.db #1400 + reviews of consumer PR #61: fromTokenFile's failure modes are TYPED and
 * DISTINCT, and no error names the credential path (the per-account token path embeds the
 * unmasked address; the directory layout is not the operator log's business either).
 *
 *   per-account  TOKEN_FILE_MISSING       the account's token file does not exist
 *                REFRESH_TOKEN_MISSING    it parses but has no refresh_token
 *                TOKEN_FILE_INVALID       it is not valid JSON / not an object (unchanged)
 *   shared       OAUTH_CLIENT_FILE_INVALID  the SHARED OAuth client file is missing, unparseable
 *                                           or incomplete — affects every account that relies on
 *                                           it, so it must not look like a per-account skip.
 *
 * fs + googleapis mocked; every value is synthetic.
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
const SHARED_BASENAME = 'conductor_paul_client.json';
const CSECRET = 'GOCSPX-FAKE-SHARED-CLIENT-SECRET-QQQ';
const isShared = (p) => String(p).includes(SHARED_BASENAME);

/** Configure the fake disk: token file + shared client file (undefined = absent). */
const disk = ({ token, shared }) => {
  mockExistsSync.mockImplementation((p) => (isShared(p) ? shared !== undefined : token !== undefined));
  mockReadFileSync.mockImplementation((p) => {
    const body = isShared(p) ? shared : token;
    if (body === undefined) throw new Error('ENOENT (test)');
    return body;
  });
};

const capture = (readOnly = false) => {
  let err;
  try { GmailClient.fromTokenFile(ADDR, 'test-entity', readOnly ? { readOnly: true } : undefined); } catch (e) { err = e; }
  return err;
};

/** No credential path, directory, file name or raw address anywhere in the error's message or
 *  serialised fields (the stack's own frames are source locations under the home dir, so the
 *  message line is what is checked — the stack begins with it). */
const expectNoPath = (err) => {
  const everything = [err.message, JSON.stringify(err)].join('\n');
  for (const needle of [
    os.homedir(), 'claude/shared/config', 'credentials/', `${ADDR}.json`, ADDR, SHARED_BASENAME, '.json', CSECRET,
  ]) {
    expect(everything, `error text contains ${needle}`).not.toContain(needle);
  }
};

beforeEach(() => {
  mockExistsSync.mockReset();
  mockReadFileSync.mockReset();
});

describe('per-account: missing token file', () => {
  it.each([false, true])('readOnly=%s → TOKEN_FILE_MISSING, masked, no path', (readOnly) => {
    disk({ token: undefined, shared: JSON.stringify({ installed: { client_id: 'FAKE-id', client_secret: CSECRET } }) });
    const err = capture(readOnly);
    expect(err).toBeInstanceOf(lib.TokenFileMissingError);
    expect(err.name).toBe('TokenFileMissingError');
    expect(err.code).toBe('TOKEN_FILE_MISSING');
    expect(err.account).toBe(MASKED);
    expect(err.message).toContain(MASKED);
    expect(err.message).toMatch(/token file not found/i);
    expectNoPath(err);
  });
});

describe('per-account: token file with no refresh_token', () => {
  it.each([
    ['absent', {}],
    ['empty string', { refresh_token: '' }],
    ['null', { refresh_token: null }],
  ])('%s → REFRESH_TOKEN_MISSING, masked, no path', (_n, extra) => {
    disk({ token: JSON.stringify({ client_id: 'FAKE-id', client_secret: CSECRET, ...extra }) });
    const err = capture();
    expect(err).toBeInstanceOf(lib.RefreshTokenMissingError);
    expect(err.name).toBe('RefreshTokenMissingError');
    expect(err.code).toBe('REFRESH_TOKEN_MISSING');
    expect(err.account).toBe(MASKED);
    expect(err.message).toContain(MASKED);
    expect(err.message).toMatch(/no refresh_token/i);
    expectNoPath(err);
  });
});

describe('per-account: malformed token file keeps TOKEN_FILE_INVALID', () => {
  it('not JSON → TOKEN_FILE_INVALID, no path', () => {
    disk({ token: '{nope' });
    const err = capture();
    expect(err.code).toBe('TOKEN_FILE_INVALID');
    expectNoPath(err);
  });
});

describe('SHARED OAuth client file failures are OAUTH_CLIENT_FILE_INVALID, never TOKEN_FILE_INVALID', () => {
  const legacyToken = JSON.stringify({ refresh_token: 'FAKE-refresh' }); // names no client of its own

  it.each([
    ['missing', undefined, /not found/i],
    ['not JSON (and would quote the secret)', `{"installed": {"client_secret": ${CSECRET}}`, /not valid JSON/i],
    ['JSON but not an object', `["${CSECRET}"]`, /not a JSON object/i],
    ['object without a client pair', JSON.stringify({ installed: { client_id: 'FAKE-id' } }), /client_id\/client_secret/i],
  ])('%s', (_n, shared, reason) => {
    disk({ token: legacyToken, shared });
    const err = capture();
    expect(err).toBeInstanceOf(lib.OAuthClientFileError);
    expect(err).not.toBeInstanceOf(lib.TokenFileInvalidError);
    expect(err.name).toBe('OAuthClientFileError');
    expect(err.code).toBe('OAUTH_CLIENT_FILE_INVALID');
    expect(err.message).toMatch(/shared OAuth client file/i);
    expect(err.message).toMatch(reason);
    expect(err.cause).toBeUndefined();
    expectNoPath(err);
  });

  it('a self-describing token never touches the shared file (unchanged)', () => {
    disk({ token: JSON.stringify({ refresh_token: 'FAKE-refresh', client_id: 'FAKE-id', client_secret: 'FAKE-s' }) });
    expect(capture()).toBeUndefined();
  });
});

describe('the codes are distinct and exported for consumers', () => {
  it('each failure has its own code', () => {
    const codes = [
      new lib.TokenFileMissingError(ADDR).code,
      new lib.RefreshTokenMissingError(ADDR).code,
      new lib.TokenFileInvalidError(ADDR, 'x').code,
      new lib.OAuthClientFileError('x').code,
    ];
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('PER_ACCOUNT_TOKEN_ERROR_CODES lists the per-account (skippable) codes and NOT the shared one', () => {
    expect([...lib.PER_ACCOUNT_TOKEN_ERROR_CODES].sort()).toEqual(
      ['READ_ONLY_SCOPE_MISMATCH', 'REFRESH_TOKEN_MISSING', 'TOKEN_FILE_INVALID', 'TOKEN_FILE_MISSING'],
    );
    expect(lib.PER_ACCOUNT_TOKEN_ERROR_CODES).not.toContain('OAUTH_CLIENT_FILE_INVALID');
    expect(Object.isFrozen(lib.PER_ACCOUNT_TOKEN_ERROR_CODES)).toBe(true);
  });
});
