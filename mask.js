/**
 * mask.js — PII masking helpers for log sinks (SOC 2).
 *
 * Anything written to a persistent log MUST pass through these first.
 * Centralised here (not inlined per-sink) so every consumer masks the
 * same way and there is a single place to harden.
 */

// Longest input any function here will run a regex over. A real From header
// is well under 1 KB; EMAIL_RE is quadratic on long crafted input (~3s on 60k
// chars, measured 2026-09-27), so anything longer is redacted outright —
// fail closed rather than scan (tasks.db #1345).
const MAX_INPUT_LEN = 1000;

const REDACTED = '[redacted]';

// Single source of truth for the domain grammar, shared by every pattern below
// so a future widening (e.g. IDN support) cannot desync them.
const DOMAIN = '[A-Za-z0-9.-]+\\.[A-Za-z]{2,}';
const LOCAL = '[A-Za-z0-9._%+-]+';

// Matches a plain email address anywhere inside a larger string.
const EMAIL_RE = new RegExp(`${LOCAL}@${DOMAIN}`);

// Matches a string that is exactly ONE plain address and nothing else.
const SINGLE_ADDRESS_RE = new RegExp(`^${LOCAL}@${DOMAIN}$`);

// Matches maskEmail()'s own output format (e.g. "p***@gmail.com"). EMAIL_RE's
// local-part character class does not include "*", so an already-masked
// address never matches it — without this check, re-masking an
// already-masked From value falls through to the generic '[redacted]'
// branch instead of being a no-op, breaking idempotency (found while writing
// tests for tasks.db #1327; no PII ever leaked, but downstream consumers
// that re-mask a value — e.g. a retried log write — would silently see it
// mutate from a stable masked address to a different, less informative
// constant).
//
// MUST stay fully anchored (^...$): a loosened pattern would let a real
// address ride through behind a masked prefix. Pinned by the "already-masked
// short-circuit stays anchored" tests in tests/mask.test.js.
const ALREADY_MASKED_RE = new RegExp(`^.\\*\\*\\*@${DOMAIN}$`);

/**
 * Mask a bare email address.
 * Returns first char of the local part + "***@" + domain.
 * Example: paul.steinberg@gmail.com → p***@gmail.com
 *
 * Fails closed: the ENTIRE input must be exactly one plain address (or
 * maskEmail's own already-masked output, returned unchanged). Anything else —
 * a display name, a comma-separated list, "a@b@c.com", surrounding
 * whitespace, over-long input — returns '[redacted]' rather than leaving PII
 * in place (tasks.db #1345). Callers holding a full header should use
 * maskFrom(), which extracts the address first.
 *
 * @param {*} email
 * @returns {*} masked string, '[redacted]', or the original value if not a string
 */
export function maskEmail(email) {
  if (!email || typeof email !== 'string') return email;
  if (email.length > MAX_INPUT_LEN) return REDACTED;
  if (ALREADY_MASKED_RE.test(email)) return email;
  if (!SINGLE_ADDRESS_RE.test(email)) return REDACTED;
  return email[0] + '***@' + email.slice(email.indexOf('@') + 1);
}

/**
 * Mask a From / sender header. The display name is dropped entirely (it is
 * PII — a real person's name) and the embedded address is masked. If the
 * header carries no parseable address, the whole value is redacted.
 *
 * Example: "Paul Steinberg" <paul.steinberg@gmail.com> → p***@gmail.com
 *
 * Idempotent: calling this again on its own output is a no-op.
 *
 * @param {*} from — raw From header value
 * @returns {*} masked sender, or the original value if not a string
 */
export function maskFrom(from) {
  if (!from || typeof from !== 'string') return from;
  if (from.length > MAX_INPUT_LEN) return REDACTED;
  if (ALREADY_MASKED_RE.test(from)) return from;
  const m = from.match(EMAIL_RE);
  if (!m) return REDACTED;
  return maskEmail(m[0]);
}

/**
 * Redact free-text PII (subject lines, body snippets). The content is never
 * written; only a non-identifying length marker is kept for diagnostics.
 *
 * Example: "Wire transfer confirmation 88231" → [redacted:32]
 *
 * @param {*} value — raw subject / snippet
 * @returns {*} length marker, '' for empty, or the original value if not a string
 */
export function redact(value) {
  if (value == null) return value;
  if (typeof value !== 'string') return value;
  return value.length ? `[redacted:${value.length}]` : '';
}
