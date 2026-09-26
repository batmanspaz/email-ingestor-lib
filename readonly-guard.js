/**
 * readonly-guard.js — enforced read-only Gmail accounts.
 *
 * Paul's HARD RULE (2026-09-26): some mailboxes (today: emilee.stone@collagesoup.com)
 * must never be modified by ingestion — no archive, label, mark-read, move, trash,
 * forward, draft or send. Convention (archiveAfterProcess:false, empty forward rules)
 * is not enough; this makes it impossible.
 *
 * Every Gmail write in this library goes through the googleapis client held in
 * GmailClient._gmail (including poll.js's batch-archive, which reaches for it
 * directly). guardGmailApi() wraps that one object in a Proxy that allows only the
 * read verbs `get`, `list` and `getProfile` and throws ReadOnlyAccountError for
 * anything else. An allowlist, not a denylist: a Gmail method added tomorrow is
 * refused until someone decides it is a read.
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
  throw err;
}

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
        const value = Reflect.get(obj, prop, obj);
        if (typeof prop === 'symbol') return value;
        const here = [...pathParts, prop];
        if (typeof value === 'function') {
          return (...args) => {
            if (!READ_VERBS.has(prop)) {
              denyWrite(account, here.join('.'));
            }
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
