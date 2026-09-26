/**
 * Read-only guard, final fix pass (Opus review of PR #66) — REAL googleapis, transport spy,
 * no network, synthetic values only.
 *
 *  A1  TOCTOU: the guard used to validate the caller's params/options objects and then hand
 *      the SAME objects to googleapis, so a Proxy / getter that changes after the check
 *      smuggled url/method/headers/requestBody through. The guard now copies each argument
 *      ONCE into a fresh null-prototype object of allowlisted keys and passes ONLY the copy.
 *  A2  isolation: readOnly clients come from their own `new GoogleApis()`, so
 *      `google.options(...)` on the shared singleton no longer changes their requests.
 *  A4  the scope Google returns on the token refresh is checked too (not just the file).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { google } from 'googleapis';
import { GmailClient } from '../gmail.js';
import { ReadOnlyScopeError, setReadOnlyDenialSink } from '../readonly-guard.js';

const ADDR = 'read.only.person@example.com';
const READONLY = 'https://www.googleapis.com/auth/gmail.readonly';
const MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const cfg = (extra = {}) => ({
  account: ADDR, refreshToken: 'FAKE-refresh', clientId: 'FAKE-id', clientSecret: 'FAKE-secret', ...extra,
});
const OK_RES = { data: {}, headers: {}, status: 200, statusText: 'OK', config: {} };
const ro = () => new GmailClient(cfg({ readOnly: true }));

let transport;
beforeEach(() => {
  transport = [];
  vi.spyOn(google.auth.OAuth2.prototype, 'request').mockImplementation(async (opts) => {
    transport.push({
      method: opts.method, url: String(opts.url), headers: opts.headers, data: opts.data,
      params: opts.params, timeout: opts.timeout,
    });
    return OK_RES;
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => {
    transport.push({ method: 'FETCH', url: String(u) });
    throw new Error('network blocked in test');
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); setReadOnlyDenialSink(null); google.options({}); });

/** Everything that reached the transport must be a plain, un-smuggled GET on a read URL. */
const expectNothingSmuggled = () => {
  for (const t of transport) {
    expect(t.method).toBe('GET');
    expect(t.url).not.toMatch(/modify|trash|send|evil\.example/i);
    expect(JSON.stringify(t.headers ?? {})).not.toMatch(/method-override|x-evil/i);
    expect(t.data).toBeUndefined();
  }
};

/** A Proxy over `base` whose ownKeys/get/gOPD are honest for the first `honest` ownKeys calls
 *  and then also show `evil` keys/values — the classic check-then-use swap. */
const shiftyProxy = (base, evil, honest) => {
  let ownKeysCalls = 0;
  const evilNow = () => ownKeysCalls > honest;
  const handler = {
    ownKeys(t) { ownKeysCalls++; return [...Reflect.ownKeys(t), ...(evilNow() ? Object.keys(evil) : [])]; },
    getOwnPropertyDescriptor(t, k) {
      if (evilNow() && k in evil) return { value: evil[k], enumerable: true, configurable: true, writable: true };
      return Reflect.getOwnPropertyDescriptor(t, k);
    },
    get(t, k) { return evilNow() && k in evil ? evil[k] : Reflect.get(t, k); },
    has(t, k) { return (evilNow() && k in evil) || Reflect.has(t, k); },
  };
  return { proxy: new Proxy({ ...base }, handler), calls: () => ownKeysCalls };
};

describe('A1 — TOCTOU: only a sanitised COPY of params/options ever reaches googleapis', () => {
  const MODIFY = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/m1/modify';

  it('options Proxy that adds url/method/headers/data AFTER the check cannot smuggle them', async () => {
    const evil = { url: MODIFY, method: 'POST', headers: { 'X-HTTP-Method-Override': 'POST' }, data: { addLabelIds: ['TRASH'] } };
    // Old guard read the keys twice (for..in + symbols) before googleapis read them a third time.
    const { proxy } = shiftyProxy({ timeout: 5000 }, evil, 2);
    try { await ro()._gmail.users.messages.get({ userId: 'me', id: 'm1' }, proxy); } catch (e) {
      expect(e.code).toBe('READ_ONLY_ACCOUNT'); // denying is also acceptable — smuggling is not
    }
    expectNothingSmuggled();
  });

  it.each([1, 2, 3, 5])('options Proxy turning evil after %i ownKeys reads: never a POST/override on the wire', async (honest) => {
    const evil = { url: MODIFY, method: 'POST', headers: { 'X-HTTP-Method-Override': 'POST' } };
    const { proxy } = shiftyProxy({ timeout: 5000 }, evil, honest);
    try { await ro()._gmail.users.messages.get({ userId: 'me', id: 'm1' }, proxy); } catch { /* denied is fine */ }
    expectNothingSmuggled();
  });

  it('params Proxy that adds headers/requestBody/auth AFTER the check cannot smuggle them', async () => {
    const evil = {
      headers: { 'X-HTTP-Method-Override': 'POST', 'X-Evil': '1' },
      requestBody: { addLabelIds: ['TRASH'] },
      $httpMethod: 'POST',
    };
    for (const honest of [1, 2, 3, 5]) {
      transport.length = 0;
      const { proxy } = shiftyProxy({ userId: 'me', id: 'm1' }, evil, honest);
      try { await ro()._gmail.users.messages.get(proxy); } catch { /* denied is fine */ }
      expectNothingSmuggled();
    }
  });

  it('a params Proxy that is honest on every read still works, and the wire request is the copy', async () => {
    const { proxy } = shiftyProxy({ userId: 'me', id: 'm1', format: 'metadata' }, {}, 99);
    await ro()._gmail.users.messages.get(proxy, { timeout: 4000 });
    expect(transport).toHaveLength(1);
    expect(transport[0].method).toBe('GET');
    expect(transport[0].url).toContain('/messages/m1');
    expect(transport[0].timeout).toBe(4000);
  });

  it('a params getter that changes its value after the check is neutralised: read exactly ONCE', async () => {
    let reads = 0;
    const params = { userId: 'me' };
    Object.defineProperty(params, 'id', { enumerable: true, get() { reads++; return reads === 1 ? 'm1' : 'm1/modify'; } });
    await ro()._gmail.users.messages.get(params);
    expect(reads).toBe(1);
    expect(transport).toHaveLength(1);
    expect(transport[0].url).toMatch(/\/messages\/m1$/);
    expectNothingSmuggled();
  });

  it('a getter that first returns a primitive then an object cannot swap in an object', async () => {
    let reads = 0;
    const params = { userId: 'me', id: 'm1' };
    Object.defineProperty(params, 'q', {
      enumerable: true, get() { reads++; return reads === 1 ? 'is:unread' : { toString: () => 'x' }; },
    });
    await ro()._gmail.users.messages.list(params);
    expect(reads).toBe(1);
    expect(transport[0].params.q).toBe('is:unread');
  });

  it('array-valued params are copied once too (element getter read once, array length read once)', async () => {
    let elementReads = 0;
    const labelIds = ['INBOX'];
    Object.defineProperty(labelIds, 0, { enumerable: true, get() { elementReads++; return elementReads === 1 ? 'INBOX' : 'TRASH'; } });
    await ro()._gmail.users.messages.list({ userId: 'me', labelIds });
    expect(elementReads).toBe(1);
    expect(transport[0].params.labelIds).toEqual(['INBOX']);
    expect(JSON.stringify(transport[0])).not.toContain('TRASH');
  });

  it('what googleapis receives is a fresh null-prototype object, not the caller\'s', async () => {
    const seen = [];
    const gmail = google.gmail({ version: 'v1' });
    const spied = { users: { messages: { get: (...a) => { seen.push(a); return Promise.resolve(OK_RES); } } } };
    const { guardGmailApi } = await import('../readonly-guard.js');
    const g = guardGmailApi(spied, ADDR);
    const params = { userId: 'me', id: 'm1' };
    const options = { timeout: 1 };
    await g.users.messages.get(params, options);
    expect(seen).toHaveLength(1);
    const [p, o] = seen[0];
    expect(p).not.toBe(params);
    expect(o).not.toBe(options);
    expect(Object.getPrototypeOf(p)).toBeNull();
    expect(Object.getPrototypeOf(o)).toBeNull();
    expect(p).toEqual(expect.objectContaining({ userId: 'me', id: 'm1' }));
    expect(Object.keys(o)).toEqual(['timeout']);
    void gmail;
  });

  it('the copy holds only allowlisted keys with validated values (signal must be a real AbortSignal)', async () => {
    await denyOrThrow(() => ro()._gmail.users.messages.get({ userId: 'me', id: 'm1' }, { signal: { aborted: false, addEventListener() {} } }));
    const ac = new AbortController();
    await ro()._gmail.users.messages.get({ userId: 'me', id: 'm1' }, { signal: ac.signal });
    expect(transport).toHaveLength(1);
  });

  it('non-primitive option values are rejected (timeout as an object)', async () => {
    await denyOrThrow(() => ro()._gmail.users.messages.get({ userId: 'me', id: 'm1' }, { timeout: { valueOf: () => 1 } }));
  });

  async function denyOrThrow(fn) {
    let err;
    try { await fn(); } catch (e) { err = e; }
    expect(err?.code).toBe('READ_ONLY_ACCOUNT');
    expect(transport).toEqual([]);
  }
});

describe('A2 — readOnly clients are isolated from the shared `google` singleton', () => {
  it('google.options({params, timeout}) on the singleton does not change a readOnly client\'s request', async () => {
    const c = ro();
    google.options({ params: { fields: 'POISON' }, timeout: 1234 });
    await c._gmail.users.messages.get({ userId: 'me', id: 'm1' });
    expect(transport).toHaveLength(1);
    expect(transport[0].timeout).not.toBe(1234);
    expect(JSON.stringify(transport[0].params ?? {})).not.toContain('POISON');
    expect(transport[0].url).not.toContain('POISON');
  });
  it('control: the same poison DOES change a non-readOnly client (proves the probe can see it)', async () => {
    const c = new GmailClient(cfg());
    google.options({ params: { fields: 'POISON' }, timeout: 1234 });
    await c._gmail.users.messages.get({ userId: 'me', id: 'm1' });
    expect(transport[0].timeout).toBe(1234);
    expect(JSON.stringify(transport[0].params ?? {})).toContain('POISON');
  });
  it('options set BEFORE construction are not inherited either', async () => {
    google.options({ timeout: 1234 });
    await ro()._gmail.users.messages.get({ userId: 'me', id: 'm1' });
    expect(transport[0].timeout).not.toBe(1234);
  });
});

describe('A4 — the scope in the token REFRESH response is verified (refuse anything wider than exactly gmail.readonly)', () => {
  let tokenCalls;
  let gmailCalls;
  // Intercept at the Gaxios transporter (the layer BELOW OAuth2Client.request), so the real
  // refresh logic + real token-response parsing run, but nothing can leave the process.
  const respond = (scope) => {
    tokenCalls = 0; gmailCalls = 0;
    google.auth.OAuth2.prototype.request.mockRestore();
    const Transporter = Object.getPrototypeOf(new google.auth.OAuth2('probe-id', 'probe-secret').transporter);
    vi.spyOn(Transporter, 'request').mockImplementation(async (opts) => {
      const url = String(opts.url);
      if (url.includes('oauth2.googleapis.com/token')) {
        tokenCalls++;
        const data = { access_token: 'SECRET-ACCESS-TOKEN-VALUE', expires_in: 3600, token_type: 'Bearer' };
        if (scope !== undefined) data.scope = scope;
        return { data, status: 200, statusText: 'OK', headers: {}, config: opts };
      }
      if (!url.startsWith('https://gmail.googleapis.com/')) throw new Error(`unexpected transport url ${url}`);
      gmailCalls++;
      return { data: {}, status: 200, statusText: 'OK', headers: {}, config: opts };
    });
  };
  const read = (c) => c._gmail.users.getProfile({ userId: 'me' });

  it('scope == exactly gmail.readonly: the read goes through', async () => {
    respond(READONLY);
    await read(ro());
    expect(tokenCalls).toBe(1);
    expect(gmailCalls).toBe(1);
  });

  it.each([
    ['readonly + modify', `${READONLY} ${MODIFY_SCOPE}`],
    ['modify only', MODIFY_SCOPE],
    ['full mail', 'https://mail.google.com/'],
    ['readonly + openid', `${READONLY} openid`],
    ['readonly listed twice', `${READONLY} ${READONLY}`],
    ['metadata (a different read scope)', 'https://www.googleapis.com/auth/gmail.metadata'],
    ['empty string', ''],
    ['scope absent from the response (cannot prove it)', undefined],
  ])('refuses on the first refresh when Google returns: %s', async (_n, scope) => {
    respond(scope);
    const c = ro();
    let err;
    try { await read(c); } catch (e) { err = e; }
    expect(err, 'expected ReadOnlyScopeError').toBeInstanceOf(ReadOnlyScopeError);
    expect(err.code).toBe('READ_ONLY_SCOPE_MISMATCH');
    expect(err.message).toContain('r***@example.com');
    expect(err.message).not.toContain(ADDR);
    expect(`${err.message}\n${err.stack}`).not.toMatch(/SECRET-ACCESS-TOKEN-VALUE|FAKE-refresh|FAKE-secret/);
    expect(gmailCalls).toBe(0); // no Gmail request was ever made with the wider token
    // Sticky: the wider token was not kept, so a retry re-checks (and re-refuses) rather than sending.
    await expect(read(c)).rejects.toBeInstanceOf(ReadOnlyScopeError);
    expect(gmailCalls).toBe(0);
  });

  it('the refusal is logged to the durable sink, masked', async () => {
    const seen = [];
    setReadOnlyDenialSink((r) => seen.push(r));
    respond(`${READONLY} ${MODIFY_SCOPE}`);
    await read(ro()).catch(() => {});
    expect(seen.some(r => r.op === 'readonly_scope_rejected' && r.account === 'r***@example.com')).toBe(true);
    expect(JSON.stringify(seen)).not.toContain(ADDR);
  });

  it('a NON-readOnly client is unaffected by a wider refresh scope', async () => {
    respond(`${READONLY} ${MODIFY_SCOPE}`);
    await read(new GmailClient(cfg()));
    expect(gmailCalls).toBe(1);
  });
});
