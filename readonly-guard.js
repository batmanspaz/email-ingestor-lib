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
 *                   would otherwise turn an allowed read into a write. Each is
 *                   COPIED ONCE into a fresh null-prototype object holding only
 *                   allowlisted keys and primitive/validated values (every caller
 *                   property is read exactly once); googleapis is handed ONLY the
 *                   copy, so a Proxy or getter that changes after the check
 *                   (TOCTOU) has nothing left to change.
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

/** An optional caller-supplied account label is cut to this many characters. */
export const MAX_ACCOUNT_LABEL_LEN = 64;

/**
 * Normalise an optional, NON-PII account label (callers pass their config label, e.g.
 * 'emilee-stone'). Two different mailboxes can mask to the same string, so the masked address alone
 * does not say WHICH mailbox needs attention. Anything that is not a non-empty string is treated as
 * absent; the rest is cut to MAX_ACCOUNT_LABEL_LEN (+ '…') and every character outside
 * [A-Za-z0-9 ._:@/…-] becomes '?' (so it is idempotent), so caller text cannot inject control characters into a log line.
 * @param {unknown} label
 * @returns {string|undefined}
 */
export function safeAccountLabel(label) {
  if (typeof label !== 'string' || label.length === 0) return undefined;
  const clean = label.slice(0, MAX_ACCOUNT_LABEL_LEN).replace(/[^A-Za-z0-9 ._:@/…-]/g, '?');
  return label.length > MAX_ACCOUNT_LABEL_LEN ? `${clean}…` : clean;
}

/** 'a***@x.com' or, with a label, 'a***@x.com, label pc-billing'. */
function describeAccount(account, label) {
  return label ? `${maskEmail(account)}, label ${label}` : maskEmail(account);
}

/** Set err.accountLabel only when a label was given (property stays absent otherwise). */
function attachLabel(err, label) {
  if (label) err.accountLabel = label;
}

/** The only API verbs a read-only account may call. */
export const READ_VERBS = new Set(['get', 'list', 'getProfile']);

export class ReadOnlyAccountError extends Error {
  /**
   * @param {string} account — address of the protected mailbox (masked in the message)
   * @param {string} op — API path that was refused, e.g. "users.messages.modify"
   * @param {string} [accountLabel] — optional non-PII label (see safeAccountLabel)
   */
  constructor(account, op, accountLabel) {
    const label = safeAccountLabel(accountLabel);
    super(`READ-ONLY account (${describeAccount(account, label)}): refused Gmail write ${op}`);
    this.name = 'ReadOnlyAccountError';
    this.code = 'READ_ONLY_ACCOUNT';
    this.op = op;
    attachLabel(this, label);
  }
}

/** The only scope a readOnly account's token may have been granted. */
export const READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

/** At most this many offending scopes are echoed into an error (the rest are counted). */
export const MAX_ECHOED_SCOPES = 5;
/** Each echoed scope is cut to this many characters (real scope URLs are well under it). */
export const MAX_ECHOED_SCOPE_LEN = 100;

/**
 * Make offending scope strings safe to put in an error message / log line. They come from a
 * token file or from Google's refresh response — not from this code — so: each is cut to
 * MAX_ECHOED_SCOPE_LEN (+ '…'), every character outside the URL-ish set a scope uses is
 * replaced with '?' (no control characters, newlines or terminal escapes), and only the first
 * MAX_ECHOED_SCOPES are kept, followed by a '(+N more)' count.
 * @param {unknown} scopes
 * @returns {string[]}
 */
export function safeScopeList(scopes) {
  const list = Array.isArray(scopes) ? scopes : [];
  const out = list.slice(0, MAX_ECHOED_SCOPES).map((s) => {
    if (typeof s !== 'string') return '?';
    const clean = s.slice(0, MAX_ECHOED_SCOPE_LEN).replace(/[^A-Za-z0-9:/._~+=&%?#@-]/g, '?');
    return s.length > MAX_ECHOED_SCOPE_LEN ? `${clean}…` : clean;
  });
  if (list.length > MAX_ECHOED_SCOPES) out.push(`(+${list.length - MAX_ECHOED_SCOPES} more)`);
  return out;
}

/**
 * Thrown by GmailClient.fromTokenFile({readOnly:true}) when the token file's scopes
 * are not EXACTLY [gmail.readonly]. Per-account and typed so a runtime can skip just
 * this one account (and tell the operator to re-auth) instead of dying.
 */
export class ReadOnlyScopeError extends Error {
  /**
   * @param {string} account — address (masked in message + field)
   * @param {string[]} [unexpected] — offending scope URLs (not secret, but not ours either:
   *   capped + cleaned by safeScopeList before they reach the message or the field)
   * @param {string} [reason] — fixed text; a caller that echoes scopes in it must pass them
   *   through safeScopeList first
   * @param {string} [accountLabel] — optional non-PII label (see safeAccountLabel)
   */
  constructor(account, unexpected = [], reason = '', accountLabel) {
    const masked = maskEmail(account);
    const label = safeAccountLabel(accountLabel);
    const shown = safeScopeList(unexpected);
    const detail = reason || (shown.length
      ? `token grants scopes beyond gmail.readonly: ${shown.join(', ')}`
      : 'token does not grant exactly gmail.readonly');
    super(
      `READ-ONLY account (${describeAccount(account, label)}): refusing to build client — ${detail}. ` +
      'Re-authorize with gmail.readonly ONLY (scripts/reauth-readonly.py).',
    );
    this.name = 'ReadOnlyScopeError';
    this.code = 'READ_ONLY_SCOPE_MISMATCH';
    this.account = masked;
    // DISPLAY-ONLY: capped, cleaned, and possibly ending in a synthetic '(+N more)' entry — never a
    // parseable scope list. The true number of offending scopes is unexpectedScopeCount.
    this.unexpectedScopes = shown;
    this.unexpectedScopeCount = Array.isArray(unexpected) ? unexpected.length : 0;
    attachLabel(this, label);
  }
}

/**
 * Thrown by GmailClient.fromTokenFile() when a credentials file cannot be parsed. Deliberately
 * carries NO parser text and NO `cause`: a JSON.parse SyntaxError quotes part of the malformed
 * input, which can include a bare token / client-secret value. Only the masked address and a
 * fixed reason ever appear in the message, stack or any log line built from them.
 */
export class TokenFileInvalidError extends Error {
  /**
   * @param {string} account — address (masked in message)
   * @param {string} reason — fixed, secret-free text, e.g. 'token file is not valid JSON'
   * @param {string} [accountLabel] — optional non-PII label (see safeAccountLabel)
   */
  constructor(account, reason, accountLabel) {
    const label = safeAccountLabel(accountLabel);
    super(`${describeAccount(account, label)}: ${reason} — re-run the OAuth flow for this account`);
    this.name = 'TokenFileInvalidError';
    this.code = 'TOKEN_FILE_INVALID';
    this.account = maskEmail(account);
    attachLabel(this, label);
  }
}

/**
 * Thrown by GmailClient.fromTokenFile() when the account's token file does not exist.
 * Per-account. The message names only the masked address — never the path (it embeds the
 * unmasked address).
 */
export class TokenFileMissingError extends Error {
  /**
   * @param {string} account — address (masked in message + field)
   * @param {string} [accountLabel] — optional non-PII label (see safeAccountLabel)
   */
  constructor(account, accountLabel) {
    const label = safeAccountLabel(accountLabel);
    super(`${describeAccount(account, label)}: token file not found — run the OAuth flow for this account`);
    this.name = 'TokenFileMissingError';
    this.code = 'TOKEN_FILE_MISSING';
    this.account = maskEmail(account);
    attachLabel(this, label);
  }
}

/**
 * Thrown by GmailClient.fromTokenFile() when the account's token file parses but carries no
 * refresh_token. Per-account; masked address only, no path.
 */
export class RefreshTokenMissingError extends Error {
  /**
   * @param {string} account — address (masked in message + field)
   * @param {string} [accountLabel] — optional non-PII label (see safeAccountLabel)
   */
  constructor(account, accountLabel) {
    const label = safeAccountLabel(accountLabel);
    super(`${describeAccount(account, label)}: token file has no refresh_token — re-run the OAuth flow for this account`);
    this.name = 'RefreshTokenMissingError';
    this.code = 'REFRESH_TOKEN_MISSING';
    this.account = maskEmail(account);
    attachLabel(this, label);
  }
}

/**
 * Thrown by GmailClient.fromTokenFile() when the SHARED OAuth client file (used by every token
 * that names no client of its own) is missing, unparseable or lacks a client_id/client_secret
 * pair. NOT per-account: every account relying on it is equally broken, so it carries its own
 * code rather than TOKEN_FILE_INVALID (which a runtime may treat as "skip this one account").
 * Like TokenFileInvalidError it carries no parser text, no `cause` and no path.
 */
export class OAuthClientFileError extends Error {
  /**
   * @param {string} reason — fixed, secret-free text, e.g. 'is not valid JSON'
   * @param {string} [accountLabel] — optional non-PII label of the account whose load hit it
   *   (see safeAccountLabel); the failure itself is shared, but the log should say who tripped it
   */
  constructor(reason, accountLabel) {
    const label = safeAccountLabel(accountLabel);
    super(
      `shared OAuth client file ${reason}${label ? ` (hit while loading account label ${label})` : ''} — ` +
      'every account without its own OAuth client is affected',
    );
    this.name = 'OAuthClientFileError';
    this.code = 'OAUTH_CLIENT_FILE_INVALID';
    attachLabel(this, label);
  }
}

/**
 * fromTokenFile() error codes that concern ONE account (its token file / its scopes), which a
 * multi-account runtime may choose to skip while the others continue. OAUTH_CLIENT_FILE_INVALID
 * is deliberately absent: it is shared.
 */
export const PER_ACCOUNT_TOKEN_ERROR_CODES = Object.freeze([
  'TOKEN_FILE_MISSING', 'REFRESH_TOKEN_MISSING', 'TOKEN_FILE_INVALID', 'READ_ONLY_SCOPE_MISMATCH',
]);

let denialSink = null;
let sinkWarned = false;
/**
 * Route every denial to a durable sink (e.g. the entity JSONL logger, dev-rules §17.1).
 * Called with a PII-free record: { op, account (masked), attempted }. A throwing sink
 * never masks the denial itself.
 * @param {((rec:{op:string,account:string,attempted:string})=>void)|null} fn
 */
export function setReadOnlyDenialSink(fn) {
  denialSink = typeof fn === 'function' ? fn : null;
  sinkWarned = false; // a freshly registered sink gets its own one-time warning
}

/** Emit a masked denial record to the sink (never throws). */
export function emitDenial(op, account, attempted) {
  if (!denialSink) return;
  try {
    denialSink({ op, account: maskEmail(account), attempted });
  } catch {
    // The denial still stands, but the operator must learn the durable log is down — ONCE, and
    // without the sink's own error text (it may quote a path or a record).
    if (!sinkWarned) {
      sinkWarned = true;
      console.warn(
        `[readonly-guard] WARNING: the denial sink threw for ${maskEmail(account)} — denials are ` +
        'still enforced and logged to the console, but NOT to the durable log (further sink errors suppressed).',
      );
    }
  }
}

/**
 * Log and throw the denial for a refused write. Used by the Proxy below and by
 * methods (forwardEmail) that would otherwise do wasted reads before their write.
 * @param {string} account
 * @param {string} op
 * @param {string} [accountLabel] — optional non-PII label
 * @returns {never}
 */
export function denyWrite(account, op, accountLabel) {
  const err = new ReadOnlyAccountError(account, op, accountLabel);
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

/** Upper bound on an array-valued param (labelIds / metadataHeaders / historyTypes are tiny). */
const MAX_ARRAY_PARAM = 100;

/**
 * An AbortSignal (brand-checked through the `aborted` getter: a look-alike object throws).
 * NOT proof the value is un-proxied: Node implements that getter in JS, so a Proxy around a
 * real signal passes. Harmless (a signal can only abort), but the caller's object is still never
 * handed on — copyOptions stores a fresh AbortSignal.any([v]) that follows it (OPTION_COPY).
 */
function isRealAbortSignal(v) {
  try {
    const desc = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted');
    desc.get.call(v);
    return true;
  } catch {
    return false;
  }
}

/** Largest timeout a read may carry: the setTimeout ceiling (2^31 - 1 ms, ~24.8 days). Beyond
 *  it Node fires after 1 ms instead; negative / NaN / Infinity make the transport throw. */
export const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** Per-option value validators — anything else is refused. */
const OPTION_VALUE_OK = {
  signal: isRealAbortSignal,
  timeout: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_TIMEOUT_MS,
  responseType: (v) => typeof v === 'string',
  retry: (v) => typeof v === 'boolean' || typeof v === 'number',
};

/** Per-option transform applied to the validated value before it goes into the copy. */
const OPTION_COPY = {
  // A fresh signal this module creates, following the caller's — never the caller's object.
  signal: (v) => AbortSignal.any([v]),
};

/** Every enumerable key, own AND inherited (googleapis deep-extends with for..in), plus symbols. */
function allKeys(obj) {
  const keys = [];
  for (const k in obj) keys.push(k); // eslint-disable-line guard-for-in
  return { keys, symbols: Object.getOwnPropertySymbols(obj) };
}

/**
 * Copy `params` ONCE into a fresh null-prototype object. Every property is read exactly once
 * (`v = src[k]`) and the value validated on the very value that is stored, so nothing the caller
 * controls (Proxy traps, getters, mutated-after-check objects) is consulted again.
 * @returns {{copy:object}|{why:string}}
 */
function copyParams(src) {
  if (typeof src !== 'object' || src === null || Array.isArray(src)) return { why: 'params is not an object' };
  const { keys, symbols } = allKeys(src);
  if (symbols.length) return { why: 'symbol-keyed params' };
  const copy = Object.create(null);
  for (const k of keys) {
    if (!SAFE_PARAM_KEYS.has(k)) return { why: `params.${k} is not an allowed read parameter` };
    const v = src[k]; // the ONE read
    if (isPrimitive(v)) {
      copy[k] = v;
    } else if (Array.isArray(v)) {
      const len = v.length; // read once
      if (typeof len !== 'number' || !(len >= 0) || len > MAX_ARRAY_PARAM) return { why: `params.${k} is not a plain value` };
      const arr = [];
      for (let i = 0; i < len; i++) {
        const item = v[i]; // read once
        if (!isPrimitive(item)) return { why: `params.${k} is not a plain value` };
        arr.push(item);
      }
      copy[k] = arr;
    } else {
      return { why: `params.${k} is not a plain value` };
    }
  }
  return { copy };
}

/** Same idea for the per-call options: allowlisted keys, one read, validated value. */
function copyOptions(src) {
  if (typeof src !== 'object' || src === null || Array.isArray(src)) return { why: 'options is not an object' };
  const { keys, symbols } = allKeys(src);
  if (symbols.length) return { why: 'symbol-keyed options' };
  const copy = Object.create(null);
  for (const k of keys) {
    if (!SAFE_OPTION_KEYS.has(k)) return { why: `option "${k}" can redirect or re-verb the request` };
    const d = Object.getOwnPropertyDescriptor(src, k);
    if (!d || 'get' in d || 'set' in d) return { why: `option "${k}" is not a plain data property` };
    const v = src[k]; // the ONE read
    if (v !== undefined && !OPTION_VALUE_OK[k](v)) return { why: `option "${k}" has an unsafe value` };
    if (v !== undefined && OPTION_COPY[k]) {
      try {
        copy[k] = OPTION_COPY[k](v);
      } catch {
        return { why: `option "${k}" has an unsafe value` };
      }
    } else {
      copy[k] = v;
    }
  }
  return { copy };
}

/**
 * Validate AND sanitise the arguments of a read call.
 * @returns {{why:string}|{args:any[]}} the reason they are unsafe, or the arguments googleapis
 *   may receive — fresh copies only; the caller's own objects are never passed on.
 */
function sanitizeReadArgs(args) {
  const [params, second, third, ...rest] = args;
  if (rest.length) return { why: 'unexpected extra arguments' };
  let paramsCopy;
  if (params !== undefined) {
    const r = copyParams(params);
    if (r.why) return r;
    paramsCopy = r.copy;
  }
  // Signatures: (params), (params, cb), (params, options), (params, options, cb)
  let optionsCopy;
  let cb = third;
  if (typeof second === 'function') {
    if (third !== undefined) return { why: 'callback must be last' };
    cb = second;
  } else if (second !== undefined) {
    const r = copyOptions(second);
    if (r.why) return r;
    optionsCopy = r.copy;
  }
  if (cb !== undefined && typeof cb !== 'function') return { why: 'third argument is not a callback' };

  const out = [];
  if (args.length >= 1) out.push(paramsCopy);
  if (args.length >= 2) out.push(typeof second === 'function' ? cb : optionsCopy);
  if (args.length >= 3) out.push(cb);
  return { args: out };
}

/** googleapis internals that hold the OAuth2 client / request config — never exposed. */
const BLOCKED_PROPS = new Set(['context', '_options', 'auth', 'google', 'options', '__proto__', 'constructor', 'prototype']);

/**
 * Wrap a googleapis gmail client so only read verbs can be invoked.
 *
 * @param {object} gmail — google.gmail({version:'v1'}) client
 * @param {string} account — the address it belongs to (for the error/log line)
 * @param {string} [accountLabel] — optional non-PII label included in denial errors
 * @returns {object} a Proxy with the same shape as `gmail`
 */
export function guardGmailApi(gmail, account, accountLabel) {
  // The Proxy target is an empty shell, NOT the real object: googleapis defines e.g.
  // `users` as a read-only non-configurable property, and a get-trap may not return a
  // different value for such a property on its target (TypeError). Reads are routed
  // to the real object `obj` inside the trap instead.
  const wrap = (obj, pathParts) =>
    new Proxy(Object.create(null), {
      get(_shell, prop) {
        if (typeof prop === 'symbol') return Reflect.get(obj, prop, obj);
        const here = [...pathParts, prop];
        if (BLOCKED_PROPS.has(prop)) denyWrite(account, `${here.join('.')} (googleapis internals)`, accountLabel);
        const value = Reflect.get(obj, prop, obj);
        if (typeof value === 'function') {
          return (...args) => {
            if (!READ_VERBS.has(prop)) {
              denyWrite(account, here.join('.'), accountLabel);
            }
            const safe = sanitizeReadArgs(args);
            if (safe.why) denyWrite(account, `${here.join('.')} with unsafe arguments (${safe.why})`, accountLabel);
            // Resource methods rely on `this` (e.g. this.context) — call on the real object,
            // with the sanitised COPIES only (never the caller's objects: TOCTOU).
            return value.apply(obj, safe.args);
          };
        }
        if (value && typeof value === 'object') return wrap(value, here);
        return value;
      },
    });
  return wrap(gmail, []);
}
