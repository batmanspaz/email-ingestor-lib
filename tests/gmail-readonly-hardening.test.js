/**
 * Read-only guard HARDENING — fix pass after the three-reviewer security review
 * of PR #66 (Sonnet, Opus, Fable). Uses the REAL googleapis (no vi.mock) with a
 * spy on the transport (OAuth2Client.prototype.request + global fetch), so every
 * "bypass" here is the same call a real attacker/bug would make. No network: the
 * transport spy answers every request and records what would have been sent.
 * Every value is synthetic.
 *
 *  L1  options/params override bypass (googleapis Object.assigns caller options over
 *      url/method) — allowlist the known-safe option + param keys, reject the rest.
 *  L2  client._oauth2 must not be reachable (private #oauth2), and the proxy must not
 *      expose googleapis' internal `context` / `_options` / `auth`.
 *  L3  readOnly (and _gmail, on a readOnly client) are non-writable, non-configurable.
 *  L5  denials also go to a durable JSONL sink, address masked.
 *  L6  README states the layered model and never claims "impossible".
 *  (L4, the token-scope check, is in gmail-readonly-fromtokenfile.test.js — needs an fs mock.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { google } from 'googleapis';
import { GmailClient } from '../gmail.js';
import { createLogger } from '../log.js';
import { setReadOnlyDenialSink } from '../readonly-guard.js';

const ADDR = 'read.only.person@example.com';
const cfg = (extra = {}) => ({
  account: ADDR, refreshToken: 'FAKE-refresh', clientId: 'FAKE-id', clientSecret: 'FAKE-secret', ...extra,
});
const OK_RES = { data: {}, headers: {}, status: 200, statusText: 'OK', config: {} };

let transport; // every request that would have reached Google
let errSpy;
beforeEach(() => {
  transport = [];
  vi.spyOn(google.auth.OAuth2.prototype, 'request').mockImplementation(async (opts) => {
    transport.push({ method: opts.method, url: String(opts.url), headers: opts.headers, data: opts.data });
    return OK_RES;
  });
  // Belt and braces: if anything ever skips the OAuth2 spy, fail rather than touch the network.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => {
    transport.push({ method: 'FETCH', url: String(u) });
    throw new Error('network blocked in test');
  });
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); setReadOnlyDenialSink(null); });

const ro = () => new GmailClient(cfg({ readOnly: true }));
const denied = async (fn) => {
  let err;
  try { await fn(); } catch (e) { err = e; }
  expect(err, 'expected the call to be denied').toBeTruthy();
  expect(err.code).toBe('READ_ONLY_ACCOUNT');
  expect(transport).toEqual([]);
};

describe('sanity: real googleapis through the guard still reads', () => {
  it('messages.get reaches the transport as a GET', async () => {
    await ro()._gmail.users.messages.get({ userId: 'me', id: 'm1', format: 'metadata', metadataHeaders: ['From'] });
    expect(transport).toHaveLength(1);
    expect(transport[0].method).toBe('GET');
    expect(transport[0].url).toContain('/messages/m1');
  });
  it('the lib\'s own read helpers work (getCurrentHistoryId / fetchMetadata / listLabels)', async () => {
    const c = ro();
    await c.getCurrentHistoryId();
    await c.fetchMetadata('m1');
    await c.listLabels();
    expect(transport.map(t => t.method)).toEqual(['GET', 'GET', 'GET']);
  });
  it('safe options pass through: signal, timeout, responseType, retry', async () => {
    const ac = new AbortController();
    await ro()._gmail.users.messages.get(
      { userId: 'me', id: 'm1' }, { signal: ac.signal, timeout: 5000, responseType: 'json', retry: false });
    expect(transport).toHaveLength(1);
    expect(transport[0].method).toBe('GET');
  });
  it('callback style still works for reads', async () => {
    const c = ro();
    await new Promise((resolve, reject) =>
      c._gmail.users.messages.get({ userId: 'me', id: 'm1' }, (err) => (err ? reject(err) : resolve())));
    expect(transport).toHaveLength(1);
  });
});

describe('L1 — options-argument bypass (reviewer probe: get(params, {url, method:POST, data}))', () => {
  const MODIFY = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/m1/modify';
  const readCalls = {
    'messages.get': (c, ...extra) => c._gmail.users.messages.get({ userId: 'me', id: 'm1' }, ...extra),
    'messages.list': (c, ...extra) => c._gmail.users.messages.list({ userId: 'me' }, ...extra),
    'labels.list': (c, ...extra) => c._gmail.users.labels.list({ userId: 'me' }, ...extra),
    'history.list': (c, ...extra) => c._gmail.users.history.list({ userId: 'me', startHistoryId: '1' }, ...extra),
    'getProfile': (c, ...extra) => c._gmail.users.getProfile({ userId: 'me' }, ...extra),
    'attachments.get': (c, ...extra) =>
      c._gmail.users.messages.attachments.get({ userId: 'me', messageId: 'm1', id: 'a' }, ...extra),
  };

  for (const [name, call] of Object.entries(readCalls)) {
    it(`${name}: the original url+method+data override is DENIED and never reaches the transport`, async () => {
      await denied(() => call(ro(), { url: MODIFY, method: 'POST', data: { addLabelIds: ['TRASH'] } }));
    });
  }

  it.each([
    ['url', { url: MODIFY }],
    ['method', { method: 'POST' }],
    ['rootUrl', { rootUrl: 'https://evil.example.com/' }],
    ['baseUrl', { baseUrl: 'https://evil.example.com/' }],
    ['data', { data: { a: 1 } }],
    ['body', { body: '{}' }],
    ['headers (method override)', { headers: { 'X-HTTP-Method-Override': 'POST' } }],
    ['auth (other credential)', { auth: { request: async () => OK_RES } }],
    ['params (endpoint redirect)', { params: { userId: 'someone-else' } }],
    ['http2', { http2: true }],
    ['adapter', { adapter: () => {} }],
    ['agent', { agent: {} }],
    ['unknown key', { somethingNew: 1 }],
  ])('option key %s is rejected', async (_n, opts) => {
    await denied(() => readCalls['messages.get'](ro(), opts));
  });

  it('options with an INHERITED url/method (googleapis deep-extends with for..in) are rejected', async () => {
    const opts = Object.create({ url: MODIFY, method: 'POST' });
    await denied(() => readCalls['messages.get'](ro(), opts));
  });

  it('a Symbol-keyed or getter-based options object is rejected', async () => {
    const withSymbol = { [Symbol('x')]: 1 };
    await denied(() => readCalls['messages.get'](ro(), withSymbol));
    const withGetter = {};
    Object.defineProperty(withGetter, 'timeout', { get: () => 1, enumerable: true });
    await denied(() => readCalls['messages.get'](ro(), withGetter));
  });

  it('a non-object, non-function second argument is rejected', async () => {
    await denied(() => readCalls['messages.get'](ro(), 'POST'));
  });

  it('a third argument that is not a function is rejected (options, cb)', async () => {
    await denied(() => readCalls['messages.get'](ro(), {}, { url: MODIFY }));
    await denied(() => readCalls['messages.get'](ro(), {}, () => {}, 'extra'));
  });

  describe('params that redirect the endpoint or change the verb', () => {
    const get = (params) => () => ro()._gmail.users.messages.get(params);
    it.each([
      ['headers X-HTTP-Method-Override', { userId: 'me', id: 'm1', headers: { 'X-HTTP-Method-Override': 'POST' } }],
      ['auth', { userId: 'me', id: 'm1', auth: { request: async () => OK_RES } }],
      ['requestBody', { userId: 'me', id: 'm1', requestBody: { addLabelIds: ['TRASH'] } }],
      ['resource', { userId: 'me', id: 'm1', resource: { addLabelIds: ['TRASH'] } }],
      ['media', { userId: 'me', id: 'm1', media: { body: 'x' } }],
      ['$httpMethod', { userId: 'me', id: 'm1', $httpMethod: 'POST' }],
      ['options', { userId: 'me', id: 'm1', options: { method: 'POST' } }],
      ['unknown key', { userId: 'me', id: 'm1', brandNewParam: 1 }],
      ['object-valued path param', { userId: 'me', id: { toString: () => 'm1/modify' } }],
    ])('params.%s is rejected', async (_n, params) => {
      await denied(get(params));
    });
    it('non-object params are rejected', async () => {
      await denied(() => ro()._gmail.users.messages.get('m1'));
    });
    it('the ordinary read params the lib uses are accepted', async () => {
      const c = ro();
      await c._gmail.users.messages.list({ userId: 'me', labelIds: ['INBOX'], q: 'is:unread', maxResults: 5, pageToken: 'p', includeSpamTrash: false });
      await c._gmail.users.history.list({ userId: 'me', startHistoryId: '1', historyTypes: ['messageAdded'], maxResults: 500 });
      expect(transport.map(t => t.method)).toEqual(['GET', 'GET']);
    });
  });

  it('a path-traversal id cannot turn a get into the modify endpoint (URL-encoded)', async () => {
    await ro()._gmail.users.messages.get({ userId: 'me', id: 'm1/modify' });
    expect(transport).toHaveLength(1);
    expect(transport[0].method).toBe('GET');
    expect(transport[0].url).not.toMatch(/\/messages\/m1\/modify/);
  });

  it('writes are still denied outright (verb allowlist, unchanged)', async () => {
    await denied(() => ro()._gmail.users.messages.modify({ userId: 'me', id: 'm1', requestBody: {} }));
    await denied(() => ro()._gmail.users.messages.batchModify({ userId: 'me', requestBody: {} }));
  });
});

describe('L2 — the OAuth2 client is not reachable from a readOnly client', () => {
  it('client._oauth2 is gone (private #oauth2)', () => {
    const c = ro();
    expect(c._oauth2).toBeUndefined();
    expect(Object.getOwnPropertyNames(c)).not.toContain('_oauth2');
    expect(JSON.stringify(c)).not.toMatch(/FAKE-refresh|FAKE-secret/);
  });
  it('the guarded proxy does not expose googleapis internals (context / _options / auth)', () => {
    const c = ro();
    for (const walk of [
      () => c._gmail.context,
      () => c._gmail.context._options.auth,
      () => c._gmail.users.context,
      () => c._gmail.users.messages.context._options,
      () => c._gmail._options,
      () => c._gmail.auth,
    ]) {
      expect(walk).toThrow(/READ-ONLY/);
    }
    expect(errSpy).toHaveBeenCalled();
  });
  it('the non-readOnly client also no longer exposes _oauth2', () => {
    expect(new GmailClient(cfg())._oauth2).toBeUndefined();
  });
  it('a non-readOnly client still works internally (uses the private oauth2)', async () => {
    const c = new GmailClient(cfg());
    await c.getCurrentHistoryId();
    expect(transport).toHaveLength(1);
    expect(transport[0].method).toBe('GET');
  });
});

describe('L3 — readOnly cannot be switched off', () => {
  it('c.readOnly = false throws (strict mode) and the flag stays true', () => {
    const c = ro();
    expect(() => { c.readOnly = false; }).toThrow(TypeError);
    expect(c.readOnly).toBe(true);
  });
  it('defineProperty / delete of readOnly throw', () => {
    const c = ro();
    expect(() => Object.defineProperty(c, 'readOnly', { value: false })).toThrow(TypeError);
    expect(() => { delete c.readOnly; }).toThrow(TypeError);
    expect(c.readOnly).toBe(true);
  });
  it('the descriptor is non-writable, non-configurable', () => {
    const d = Object.getOwnPropertyDescriptor(ro(), 'readOnly');
    expect(d.writable).toBe(false);
    expect(d.configurable).toBe(false);
    expect(d.value).toBe(true);
  });
  it('_gmail on a readOnly client cannot be swapped for an unguarded client', () => {
    const c = ro();
    const raw = google.gmail({ version: 'v1' });
    expect(() => { c._gmail = raw; }).toThrow(TypeError);
    expect(() => Object.defineProperty(c, '_gmail', { value: raw })).toThrow(TypeError);
  });
  it('after a failed tamper the guard is still on (poll/forward checks + writes)', async () => {
    const c = ro();
    try { c.readOnly = false; } catch { /* expected */ }
    expect(c.readOnly).toBe(true);
    await expect(c.archive('m1')).rejects.toMatchObject({ code: 'READ_ONLY_ACCOUNT' });
    expect(transport).toEqual([]);
  });
  it('a default client keeps readOnly:false (non-writable too)', () => {
    const c = new GmailClient(cfg());
    expect(c.readOnly).toBe(false);
    expect(() => { c.readOnly = true; }).toThrow(TypeError);
  });
});

describe('L5 — denials reach a durable JSONL sink, address masked', () => {
  it('a denied write is appended to the entity JSONL log', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-log-'));
    const logPath = path.join(tmp, 'email-ingestor.jsonl');
    const logger = createLogger('test-entity', logPath);
    setReadOnlyDenialSink((rec) => logger.readOnlyDenial(rec));
    await ro().archive('m1').catch(() => {});
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ op: 'readonly_denied', entity: 'test-entity' });
    expect(lines[0].attempted).toMatch(/messages\.modify/);
    expect(lines[0].account).toBe('r***@example.com');
    expect(JSON.stringify(lines[0])).not.toContain(ADDR);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  it('an option-override denial is logged too', async () => {
    const seen = [];
    setReadOnlyDenialSink((rec) => seen.push(rec));
    await denied(() => ro()._gmail.users.messages.get({ userId: 'me', id: 'm1' }, { url: 'https://x/modify', method: 'POST' }));
    expect(seen).toHaveLength(1);
    expect(seen[0].account).toBe('r***@example.com');
  });
  it('a throwing sink never masks the denial', async () => {
    setReadOnlyDenialSink(() => { throw new Error('disk full'); });
    await expect(ro().archive('m1')).rejects.toMatchObject({ code: 'READ_ONLY_ACCOUNT' });
  });
  // A5 (Fable nit): a broken sink used to be swallowed silently — the operator never learned the
  // durable log was down. Warn ONCE (masked, no sink error text), keep denying.
  it('a broken sink warns ONCE via console.warn (masked), and every denial still stands', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setReadOnlyDenialSink(() => { throw new Error(`disk full for ${ADDR} SECRET-SINK-TEXT`); });
    for (let i = 0; i < 3; i++) {
      await expect(ro().archive('m1')).rejects.toMatchObject({ code: 'READ_ONLY_ACCOUNT' });
    }
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0].join(' ');
    expect(line).toMatch(/denial sink/i);
    expect(line).not.toContain(ADDR);
    expect(line).not.toContain('SECRET-SINK-TEXT');
  });
  it('re-registering a sink re-arms the one-time warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setReadOnlyDenialSink(() => { throw new Error('x'); });
    await ro().archive('m1').catch(() => {});
    setReadOnlyDenialSink(() => { throw new Error('y'); });
    await ro().archive('m1').catch(() => {});
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('L6 — README states the layered model and does not oversell', () => {
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const guardSrc = fs.readFileSync(new URL('../readonly-guard.js', import.meta.url), 'utf8');
  it('never uses the word "impossible"', () => {
    expect(readme).not.toMatch(/impossible/i);
    expect(guardSrc).not.toMatch(/impossible/i);
  });
  it('says plainly that fromTokenFile WITHOUT readOnly:true builds a WRITABLE client', () => {
    expect(readme).toMatch(/without\s+`?\{?\s*readOnly:\s*true[^\n]*writable/is);
  });
  it('is honest that patching OAuth2Client.prototype is out of scope (only the read-only token stops it)', () => {
    expect(readme).toMatch(/OAuth2Client\.prototype/);
    expect(readme).toMatch(/out of scope/i);
  });
  it('documents the copy-once argument sanitising, isolated GoogleApis instance and refresh-scope check', () => {
    expect(readme).toMatch(/copied? once|read once|single pass/i);
    expect(readme).toMatch(/GoogleApis/);
    expect(readme).toMatch(/token response|refresh response/i);
  });
  it('names each layer, with the gmail.readonly token as the real backstop', () => {
    expect(readme).toMatch(/gmail\.readonly/);
    expect(readme).toMatch(/proxy/i);
    expect(readme).toMatch(/non-writable/i);
    expect(readme).toMatch(/scope/i);
    expect(readme).toMatch(/backstop/i);
  });
});
