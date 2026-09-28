/**
 * tasks.db #1400 follow-ups to the read-only guard (items 1-3). Synthetic values only; no
 * network — the guarded object is a local spy, or real googleapis with the transport stubbed.
 *
 *  1  signal: on Node the AbortSignal `aborted` getter is a JS-level brand check, so a Proxy
 *     around a real signal PASSES it. Harmless (the signal only aborts), but the guard must not
 *     hand the caller's object on: googleapis receives a fresh AbortSignal.any([v]) instead.
 *  2  timeout: -1 / NaN / ±Infinity / beyond the setTimeout ceiling used to be accepted and then
 *     blow up (RangeError) or silently fire after 1 ms inside the transport. Only a finite number
 *     in [0, MAX_TIMEOUT_MS] is allowed.
 *  3  the scope strings echoed into a ReadOnlyScopeError come from a file or from Google's refresh
 *     response: each is length-capped, odd characters are replaced, and only the first few are
 *     listed, so an error message / log line cannot be flooded or carry control sequences.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { types } from 'node:util';
import { google } from 'googleapis';
import { GmailClient } from '../gmail.js';
import {
  guardGmailApi, ReadOnlyScopeError, MAX_TIMEOUT_MS, MAX_ECHOED_SCOPES, MAX_ECHOED_SCOPE_LEN,
} from '../readonly-guard.js';

const ADDR = 'read.only.person@example.com';
const READONLY = 'https://www.googleapis.com/auth/gmail.readonly';
const OK_RES = { data: {}, headers: {}, status: 200, statusText: 'OK', config: {} };

let seen;
const spied = () => {
  seen = [];
  return guardGmailApi(
    { users: { messages: { get: (...a) => { seen.push(a); return Promise.resolve(OK_RES); } } } },
    ADDR,
  );
};
const get = (options) => spied().users.messages.get({ userId: 'me', id: 'm1' }, options);

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

async function expectDenied(fn) {
  let err;
  try { await fn(); } catch (e) { err = e; }
  expect(err?.code).toBe('READ_ONLY_ACCOUNT');
  expect(seen).toEqual([]);
}

describe('#1400 item 2 — timeout must be a finite number in [0, MAX_TIMEOUT_MS]', () => {
  it('MAX_TIMEOUT_MS is the setTimeout ceiling (2^31 - 1 ms)', () => {
    expect(MAX_TIMEOUT_MS).toBe(2 ** 31 - 1);
  });

  it.each([
    ['-1', -1],
    ['-0.5', -0.5],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['one past the ceiling', 2 ** 31],
    ['1e12', 1e12],
  ])('refuses timeout %s', async (_n, timeout) => {
    await expectDenied(() => get({ timeout }));
  });

  it.each([
    ['0', 0],
    ['1', 1],
    ['5000', 5000],
    ['the ceiling itself', 2 ** 31 - 1],
  ])('accepts timeout %s and passes it through unchanged', async (_n, timeout) => {
    await get({ timeout });
    expect(seen).toHaveLength(1);
    expect(seen[0][1].timeout).toBe(timeout);
  });
});

describe('#1400 item 1 — the caller\'s signal object is never handed to googleapis', () => {
  it('a real signal is replaced by a fresh AbortSignal that follows it', async () => {
    const ac = new AbortController();
    await get({ signal: ac.signal });
    const passed = seen[0][1].signal;
    expect(passed).toBeInstanceOf(AbortSignal);
    expect(passed).not.toBe(ac.signal);
    expect(passed.aborted).toBe(false);
    ac.abort();
    expect(passed.aborted).toBe(true);
  });

  it('an already-aborted signal stays aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await get({ signal: ac.signal });
    expect(seen[0][1].signal.aborted).toBe(true);
  });

  it('a Proxy around a real signal (passes Node\'s JS-level brand check) is not passed on', async () => {
    const ac = new AbortController();
    const proxy = new Proxy(ac.signal, {});
    let err;
    try { await get({ signal: proxy }); } catch (e) { err = e; }
    if (err) {
      // Refusing it outright is also acceptable.
      expect(err.code).toBe('READ_ONLY_ACCOUNT');
      return;
    }
    const passed = seen[0][1].signal;
    expect(passed).not.toBe(proxy);
    expect(passed).toBeInstanceOf(AbortSignal);
    expect(types.isProxy(passed)).toBe(false);
    ac.abort();
    expect(passed.aborted).toBe(true);
  });

  it('a look-alike object is still refused', async () => {
    await expectDenied(() => get({ signal: { aborted: false, addEventListener() {} } }));
  });

  it('the source comment no longer claims a Proxy fails the brand check', () => {
    const src = fs.readFileSync(new URL('../readonly-guard.js', import.meta.url), 'utf8');
    expect(src).not.toMatch(/a Proxy or look-alike throws/);
    expect(src).toMatch(/AbortSignal\.any\(\[/);
  });
});

describe('#1400 item 3 — echoed scope strings are capped and cleaned', () => {
  const ESC = '\u001b[31m';
  const HUGE = `https://evil.example/${'x'.repeat(5000)}`;
  const NASTY = `https://evil.example/a${ESC}b\nFAKE-LOG-LINE\r\u0000c`;

  const checkBounded = (err) => {
    expect(err).toBeInstanceOf(ReadOnlyScopeError);
    const text = `${err.message}\n${JSON.stringify(err.unexpectedScopes)}`;
    expect(err.message.length).toBeLessThan(1200);
    // eslint-disable-next-line no-control-regex
    expect(err.message).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(text).not.toContain('x'.repeat(MAX_ECHOED_SCOPE_LEN + 1));
    expect(text).not.toContain(ESC);
    expect(err.unexpectedScopes.length).toBeLessThanOrEqual(MAX_ECHOED_SCOPES + 1);
    for (const s of err.unexpectedScopes) expect(s.length).toBeLessThanOrEqual(MAX_ECHOED_SCOPE_LEN + 1);
  };

  it('the caps are small and sane', () => {
    expect(MAX_ECHOED_SCOPES).toBeGreaterThan(0);
    expect(MAX_ECHOED_SCOPES).toBeLessThanOrEqual(10);
    expect(MAX_ECHOED_SCOPE_LEN).toBeGreaterThanOrEqual(60); // real scope URLs still fit whole
    expect(MAX_ECHOED_SCOPE_LEN).toBeLessThanOrEqual(200);
  });

  it('constructor: an over-long scope is truncated', () => {
    checkBounded(new ReadOnlyScopeError(ADDR, [HUGE]));
  });

  it('constructor: control characters / newlines / ANSI escapes are replaced', () => {
    const err = new ReadOnlyScopeError(ADDR, [NASTY]);
    checkBounded(err);
    expect(err.message).toContain('https://evil.example/a');
  });

  it('constructor: only the first MAX_ECHOED_SCOPES are listed, plus a count of the rest', () => {
    const many = Array.from({ length: 300 }, (_, i) => `https://evil.example/s${i}`);
    const err = new ReadOnlyScopeError(ADDR, many);
    checkBounded(err);
    expect(err.message).toContain(`+${300 - MAX_ECHOED_SCOPES} more`);
    expect(err.message).not.toContain(`s${MAX_ECHOED_SCOPES + 1}`);
  });

  it('a normal scope URL is echoed whole and unchanged', () => {
    const err = new ReadOnlyScopeError(ADDR, ['https://www.googleapis.com/auth/gmail.modify']);
    expect(err.message).toContain('https://www.googleapis.com/auth/gmail.modify');
    expect(err.unexpectedScopes).toEqual(['https://www.googleapis.com/auth/gmail.modify']);
  });

  describe('end to end through the token REFRESH response (real googleapis, stubbed transport)', () => {
    const respond = (scope) => {
      const Transporter = Object.getPrototypeOf(new google.auth.OAuth2('probe-id', 'probe-secret').transporter);
      vi.spyOn(Transporter, 'request').mockImplementation(async (opts) => {
        const url = String(opts.url);
        if (url.includes('oauth2.googleapis.com/token')) {
          return {
            data: { access_token: 'FAKE-ACCESS', expires_in: 3600, token_type: 'Bearer', scope },
            status: 200, statusText: 'OK', headers: {}, config: opts,
          };
        }
        throw new Error('no Gmail request expected');
      });
    };
    const refuse = async (scope) => {
      respond(scope);
      const c = new GmailClient({
        account: ADDR, refreshToken: 'FAKE-refresh', clientId: 'FAKE-id', clientSecret: 'FAKE-secret', readOnly: true,
      });
      let err;
      try { await c._gmail.users.getProfile({ userId: 'me' }); } catch (e) { err = e; }
      return err;
    };

    it('a 5000-char scope from Google is capped', async () => {
      checkBounded(await refuse(`${READONLY} ${HUGE}`));
    });
    it('hundreds of scopes from Google are capped', async () => {
      const many = Array.from({ length: 300 }, (_, i) => `https://evil.example/s${i}`).join(' ');
      const err = await refuse(`${READONLY} ${many}`);
      checkBounded(err);
      expect(err.message).toMatch(/\+\d+ more/);
    });
    it('control characters from Google never reach the message', async () => {
      checkBounded(await refuse(`${READONLY} https://evil.example/a${ESC}b\u0007c`));
    });
  });
});
