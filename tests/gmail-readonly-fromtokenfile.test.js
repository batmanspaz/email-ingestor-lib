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

const ADDR = 'read.only.person@example.com';
beforeEach(() => {
  apiCalls.length = 0;
  mockExistsSync.mockReset().mockReturnValue(true);
  mockReadFileSync.mockReset().mockImplementation(() => JSON.stringify({
    refresh_token: 'FAKE', client_id: 'FAKE-id', client_secret: 'FAKE-secret',
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
