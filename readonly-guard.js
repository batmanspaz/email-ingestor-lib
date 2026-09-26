/**
 * readonly-guard.js — enforced read-only Gmail accounts.
 *
 * Paul's HARD RULE (2026-09-26): some mailboxes (today: emilee.stone@collagesoup.com)
 * must never be modified by ingestion — no archive, label, mark-read, move, trash,
 * forward, draft or send. Convention (archiveAfterProcess:false, empty forward rules)
 * is not enough, so the library enforces it in layers:
 *
 *   1. PROXY      — guardGmailApi() wraps the googleapis client held in
 *                   GmailClient._gmail (poll.js's batch-archive reaches for it
 *                   directly too). Only the read verbs `get`, `list`, `getProfile`
 *                   are callable; anything else throws ReadOnlyAccountError. An
 *                   allowlist, not a denylist: a Gmail method added tomorrow is
 *                   refused until someone decides it is a read. The per-call
 *                   `params` and `options` arguments are allowlisted as well —
 *                   googleapis Object.assigns caller options over the request's
 *                   url/method, so `get(params, {url: '.../modify', method: 'POST'})`
 *                   would otherwise turn an allowed read into a write.
 *   2. FLAG       — GmailClient.readOnly / ._gmail are non-writable and
 *                   non-configurable on a readOnly client, and the OAuth2 client is
 *                   a private field (#oauth2), not reachable to build a side client.
 *   3. SCOPE      — GmailClient.fromTokenFile({readOnly:true}) refuses to build
 *                   unless the token's granted scopes are EXACTLY
 *                   [gmail.readonly] (ReadOnlyScopeError).
 *   4. TOKEN      — the gmail.readonly-only refresh token itself: Google rejects any
 *                   write made with it, whatever code runs in this process. THIS is
 *                   the real backstop; layers 1-3 keep honest code honest and fail
 *                   loudly. Code running in-process with the raw token is not
 *                   something a JS proxy can contain.
 */

import { maskEmail } from './mask.js';

/** The only API verbs a read-only account may call. */
export const READ_VERBS = new Set(['get', 'list', 'getProfile']);

export class ReadOnlyAccountError extends Error {
  /**
   * @param {string} account — address of the protected mailbox (masked in the message)
   * @param {string} op — API path that was refused, e.g. "users.messages.modify"
   */
  constructor(account, op) {
    super(`READ-ONLY account (${maskEmail(account)}): refused Gmail write ${op}`);
    this.name = 'ReadOnlyAccountError';
    this.code = 'READ_ONLY_ACCOUNT';
    this.op = op;
  }
}

/** The only scope a readOnly account's token may have been granted. */
export const READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

/**
 * Thrown by GmailClient.fromTokenFile({readOnly:true}) when the token file's scopes
 * are not EXACTLY [gmail.readonly]. Per-account and typed so a runtime can skip just
 * this one account (and tell the operator to re-auth) instead of dying.
 */
export class ReadOnlyScopeError extends Error {
  /**
   * @param {string} account — address (masked in message + field)
   * @param {string[]} [unexpected] — offending scope URLs (not secret)
   * @param {string} [reason]
   */
  constructor(account, unexpected = [], reason = '') {
    const masked = maskEmail(account);
    const detail = reason || (unexpected.length
      ? `token grants scopes beyond gmail.readonly: ${unexpected.join(', ')}`
      : 'token does not grant exactly gmail.readonly');
    super(
      `READ-ONLY account (${masked}): refusing to build client — ${detail}. ` +
      'Re-authorize with gmail.readonly ONLY (scripts/reauth-readonly.py).',
    );
    this.name = 'ReadOnlyScopeError';
    this.code = 'READ_ONLY_SCOPE_MISMATCH';
    this.account = masked;
    this.unexpectedScopes = unexpected;
  }
}

let denialSink = null;
/**
 * Route every denial to a durable sink (e.g. the entity JSONL logger, dev-rules §17.1).
 * Called with a PII-free record: { op, account (masked), attempted }. A throwing sink
 * never masks the denial itself.
 * @param {((rec:{op:string,account:string,attempted:string})=>void)|null} fn
 */
export function setReadOnlyDenialSink(fn) {
  denialSink = typeof fn === 'function' ? fn : null;
}

/** Emit a masked denial record to the sink (never throws). */
export function emitDenial(op, account, attempted) {
  if (!denialSink) return;
  try { denialSink({ op, account: maskEmail(account), attempted }); } catch { /* the denial still stands */ }
}

/**
 * Log and throw the denial for a refused write. Used by the Proxy below and by
 * methods (forwardEmail) that would otherwise do wasted reads before their write.
 * @param {string} account
 * @param {string} op
 * @returns {never}
 */
export function denyWrite(account, op) {
  const err = new ReadOnlyAccountError(account, op);
  console.error(`[readonly-guard] DENIED ${err.message}`);
  emitDenial('readonly_denied', account, op);
  throw err;
}

// ── per-call argument allowlists (L1) ─────────────────────────────────────────

/** Request options a read may carry. Everything else (url, method, rootUrl, baseUrl,
 *  data, body, headers, auth, params, http2, adapter, agent, ...) can redirect or
 *  re-verb the request and is refused. */
export const SAFE_OPTION_KEYS = new Set(['signal', 'timeout', 'responseType', 'retry']);

/** Query/path parameters the Gmail read methods take. `auth`, `headers`, `requestBody`,
 *  `resource`, `media`, `$`-prefixed and unknown keys are refused. */
export const SAFE_PARAM_KEYS = new Set([
  'userId', 'id', 'messageId', 'threadId', 'format', 'metadataHeaders', 'startHistoryId',
  'historyTypes', 'maxResults', 'pageToken', 'labelId', 'labelIds', 'q', 'includeSpamTrash', 'fields',
]);

const isPrimitive = (v) => v === null || v === undefined || ['string', 'number', 'boolean'].includes(typeof v);

/** Every enumerable key, own AND inherited (googleapis deep-extends with for..in), plus symbols. */
function allKeys(obj) {
  const keys = [];
  for (const k in obj) keys.push(k); // eslint-disable-line guard-for-in
  return { keys, symbols: Object.getOwnPropertySymbols(obj) };
}

/** @returns {string|null} the reason the arguments are unsafe for a read, or null */
function unsafeReadArgs(args) {
  const [params, second, third, ...rest] = args;
  if (rest.length) return 'unexpected extra arguments';
  if (params !== undefined) {
    if (typeof params !== 'object' || params === null || Array.isArray(params)) return 'params is not an object';
    const { keys, symbols } = allKeys(params);
    if (symbols.length) return 'symbol-keyed params';
    for (const k of keys) {
      if (!SAFE_PARAM_KEYS.has(k)) return `params.${k} is not an allowed read parameter`;
      const v = params[k];
      const ok = isPrimitive(v) || (Array.isArray(v) && v.every(isPrimitive));
      if (!ok) return `params.${k} is not a plain value`;
    }
  }
  // Signatures: (params), (params, cb), (params, options), (params, options, cb)
  let options = second;
  let cb = third;
  if (typeof second === 'function') { options = undefined; cb = second; if (third !== undefined) return 'callback must be last'; }
  if (cb !== undefined && typeof cb !== 'function') return 'third argument is not a callback';
  if (options !== undefined) {
    if (typeof options !== 'object' || options === null || Array.isArray(options)) return 'options is not an object';
    const { keys, symbols } = allKeys(options);
    if (symbols.length) return 'symbol-keyed options';
    for (const k of keys) {
      if (!SAFE_OPTION_KEYS.has(k)) return `option "${k}" can redirect or re-verb the request`;
      const d = Object.getOwnPropertyDescriptor(options, k);
      if (!d || 'get' in d || 'set' in d) return `option "${k}" is not a plain data property`;
    }
  }
  return null;
}

/** googleapis internals that hold the OAuth2 client / request config — never exposed. */
const BLOCKED_PROPS = new Set(['context', '_options', 'auth', 'google', 'options', '__proto__', 'constructor', 'prototype']);

/**
 * Wrap a googleapis gmail client so only read verbs can be invoked.
 *
 * @param {object} gmail — google.gmail({version:'v1'}) client
 * @param {string} account — the address it belongs to (for the error/log line)
 * @returns {object} a Proxy with the same shape as `gmail`
 */
export function guardGmailApi(gmail, account) {
  // The Proxy target is an empty shell, NOT the real object: googleapis defines e.g.
  // `users` as a read-only non-configurable property, and a get-trap may not return a
  // different value for such a property on its target (TypeError). Reads are routed
  // to the real object `obj` inside the trap instead.
  const wrap = (obj, pathParts) =>
    new Proxy(Object.create(null), {
      get(_shell, prop) {
        if (typeof prop === 'symbol') return Reflect.get(obj, prop, obj);
        const here = [...pathParts, prop];
        if (BLOCKED_PROPS.has(prop)) denyWrite(account, `${here.join('.')} (googleapis internals)`);
        const value = Reflect.get(obj, prop, obj);
        if (typeof value === 'function') {
          return (...args) => {
            if (!READ_VERBS.has(prop)) {
              denyWrite(account, here.join('.'));
            }
            const why = unsafeReadArgs(args);
            if (why) denyWrite(account, `${here.join('.')} with unsafe arguments (${why})`);
            // Resource methods rely on `this` (e.g. this.context) — call on the real object.
            return value.apply(obj, args);
          };
        }
        if (value && typeof value === 'object') return wrap(value, here);
        return value;
      },
    });
  return wrap(gmail, []);
}
