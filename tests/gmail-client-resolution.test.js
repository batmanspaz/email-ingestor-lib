/**
 * Unit tests for GmailClient.fromTokenFile() OAuth *client* resolution.
 *
 * Background (real production incident, 2026-09-13): Google OAuth refresh
 * tokens are bound to the OAuth client that minted them. fromTokenFile() used
 * to load ONE hardcoded client credentials file (conductor_paul_client.json)
 * for every account and ignore any client_id/client_secret already present in
 * the account's own token file. Any account re-authorized by a tool embedding
 * a DIFFERENT OAuth client (e.g. shared/scripts/google_oauth_multi.py) was then
 * permanently un-refreshable — `unauthorized_client`, deterministic.
 *
 * The contract these tests pin:
 *   1. A token file that carries its OWN client_id + client_secret is
 *      self-describing — those win over the shared client file.
 *   2. A token file WITHOUT them falls back to the shared client file
 *      (the pre-existing behaviour every other account relies on).
 *   3. A partially-populated token file (only one of the two) is NOT trusted —
 *      half a client pair can never mint a working refresh.
 *
 * `fs` and `googleapis` are both mocked — no real credential file is ever read
 * and no real Gmail API call is made. Every credential value below is
 * synthetic; none of it corresponds to a real OAuth client or token.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSetCredentials, oauth2Calls, mockExistsSync, mockReadFileSync } = vi.hoisted(() => ({
  mockSetCredentials: vi.fn(),
  oauth2Calls: [],
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
}));

vi.mock('googleapis', () => {
  function OAuth2(clientId, clientSecret) {
    oauth2Calls.push({ clientId, clientSecret });
    this.setCredentials = mockSetCredentials;
  }
  return {
    google: {
      auth: { OAuth2 },
      gmail: vi.fn().mockReturnValue({ users: {} }),
    },
  };
});

vi.mock('fs', () => {
  const api = { existsSync: mockExistsSync, readFileSync: mockReadFileSync };
  return { default: api, ...api };
});

import { GmailClient } from '../gmail.js';

// ── Synthetic fixtures (NOT real credentials) ───────────────────────────────

const SHARED_CLIENT_ID = '111111111111-sharedfake.apps.googleusercontent.com';
const SHARED_CLIENT_SECRET = 'FAKE-shared-client-secret';
const SHARED_CLIENT_FILE_JSON = JSON.stringify({
  installed: { client_id: SHARED_CLIENT_ID, client_secret: SHARED_CLIENT_SECRET },
});

const OWN_CLIENT_ID = '222222222222-ownfake.apps.googleusercontent.com';
const OWN_CLIENT_SECRET = 'FAKE-own-client-secret';

/**
 * Wire the fs mock so the shared client file and one account token file exist.
 * @param {object} tokenData — the account token file's parsed contents
 */
function mockCredentialFiles(tokenData) {
  mockExistsSync.mockReturnValue(true);
  mockReadFileSync.mockImplementation((filePath) => {
    if (String(filePath).includes('conductor_paul_client.json')) return SHARED_CLIENT_FILE_JSON;
    return JSON.stringify(tokenData);
  });
}

beforeEach(() => {
  oauth2Calls.length = 0;
  mockExistsSync.mockReset();
  mockReadFileSync.mockReset();
  mockSetCredentials.mockReset();
});

describe('GmailClient.fromTokenFile — OAuth client resolution', () => {
  it('prefers the token file\'s OWN client_id/client_secret when it carries both', () => {
    mockCredentialFiles({
      email: 'self.describing@example.com',
      refresh_token: 'FAKE-refresh-token-own-client',
      client_id: OWN_CLIENT_ID,
      client_secret: OWN_CLIENT_SECRET,
    });

    GmailClient.fromTokenFile('self.describing@example.com', 'test-entity');

    expect(oauth2Calls).toHaveLength(1);
    expect(oauth2Calls[0].clientId).toBe(OWN_CLIENT_ID);
    expect(oauth2Calls[0].clientSecret).toBe(OWN_CLIENT_SECRET);
    // The whole point: the hardcoded shared client must NOT win here.
    expect(oauth2Calls[0].clientId).not.toBe(SHARED_CLIENT_ID);
  });

  it('still uses the token\'s own refresh_token when the token carries its own client', () => {
    mockCredentialFiles({
      refresh_token: 'FAKE-refresh-token-own-client',
      client_id: OWN_CLIENT_ID,
      client_secret: OWN_CLIENT_SECRET,
    });

    GmailClient.fromTokenFile('self.describing@example.com');

    expect(mockSetCredentials).toHaveBeenCalledWith({
      refresh_token: 'FAKE-refresh-token-own-client',
    });
  });

  it('falls back to the shared client file when the token carries no client fields', () => {
    mockCredentialFiles({
      account: 'legacy@example.com',
      refresh_token: 'FAKE-refresh-token-shared-client',
    });

    GmailClient.fromTokenFile('legacy@example.com', 'test-entity');

    expect(oauth2Calls).toHaveLength(1);
    expect(oauth2Calls[0].clientId).toBe(SHARED_CLIENT_ID);
    expect(oauth2Calls[0].clientSecret).toBe(SHARED_CLIENT_SECRET);
  });

  it('falls back to the shared client file when the token has client_id but no client_secret', () => {
    mockCredentialFiles({
      refresh_token: 'FAKE-refresh-token-partial',
      client_id: OWN_CLIENT_ID,
    });

    GmailClient.fromTokenFile('partial@example.com');

    expect(oauth2Calls[0].clientId).toBe(SHARED_CLIENT_ID);
    expect(oauth2Calls[0].clientSecret).toBe(SHARED_CLIENT_SECRET);
  });

  it('falls back to the shared client file when the token has client_secret but no client_id', () => {
    mockCredentialFiles({
      refresh_token: 'FAKE-refresh-token-partial',
      client_secret: OWN_CLIENT_SECRET,
    });

    GmailClient.fromTokenFile('partial@example.com');

    expect(oauth2Calls[0].clientId).toBe(SHARED_CLIENT_ID);
    expect(oauth2Calls[0].clientSecret).toBe(SHARED_CLIENT_SECRET);
  });

  it('does not require the shared client file to exist when the token is self-describing', () => {
    // An account minted under its own client must work even if the shared
    // client file is absent — it is no longer a dependency for that account.
    mockExistsSync.mockImplementation((filePath) =>
      !String(filePath).includes('conductor_paul_client.json'));
    mockReadFileSync.mockImplementation(() =>
      JSON.stringify({
        refresh_token: 'FAKE-refresh-token-own-client',
        client_id: OWN_CLIENT_ID,
        client_secret: OWN_CLIENT_SECRET,
      }));

    expect(() => GmailClient.fromTokenFile('self.describing@example.com')).not.toThrow();
    expect(oauth2Calls[0].clientId).toBe(OWN_CLIENT_ID);
  });

  it('still throws when the shared client file is missing AND the token is not self-describing', () => {
    mockExistsSync.mockImplementation((filePath) =>
      !String(filePath).includes('conductor_paul_client.json'));
    mockReadFileSync.mockImplementation(() =>
      JSON.stringify({ refresh_token: 'FAKE-refresh-token-shared-client' }));

    expect(() => GmailClient.fromTokenFile('legacy@example.com')).toThrow(/client file not found/i);
  });

  it('still throws when the token file itself is missing', () => {
    mockExistsSync.mockImplementation((filePath) =>
      String(filePath).includes('conductor_paul_client.json'));
    mockReadFileSync.mockReturnValue(SHARED_CLIENT_FILE_JSON);

    expect(() => GmailClient.fromTokenFile('missing@example.com')).toThrow(/Token file not found/i);
  });

  it('still throws when the token file has no refresh_token', () => {
    mockCredentialFiles({ client_id: OWN_CLIENT_ID, client_secret: OWN_CLIENT_SECRET });

    expect(() => GmailClient.fromTokenFile('norefresh@example.com')).toThrow(/No refresh_token/i);
  });
});
