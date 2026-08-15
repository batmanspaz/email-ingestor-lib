/**
 * mask.js — PII masking helpers for log sinks (SOC 2).
 *
 * Anything written to a persistent log MUST pass through these first.
 * Centralised here (not inlined per-sink) so every consumer masks the
 * same way and there is a single place to harden.
 */

// Matches a plain email address anywhere inside a larger string.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/**
 * Mask a bare email address.
 * Returns first char of the local part + "***@" + domain.
 * Example: paul.steinberg@gmail.com → p***@gmail.com
 *
 * @param {*} email
 * @returns {*} masked string, or the original value if not a maskable string
 */
export function maskEmail(email) {
  if (!email || typeof email !== 'string') return email;
  const atIdx = email.indexOf('@');
  if (atIdx < 1) return email;
  return email[0] + '***@' + email.slice(atIdx + 1);
}

/**
 * Mask a From / sender header. The display name is dropped entirely (it is
 * PII — a real person's name) and the embedded address is masked. If the
 * header carries no parseable address, the whole value is redacted.
 *
 * Example: "Paul Steinberg" <paul.steinberg@gmail.com> → p***@gmail.com
 *
 * @param {*} from — raw From header value
 * @returns {*} masked sender, or the original value if not a string
 */
export function maskFrom(from) {
  if (!from || typeof from !== 'string') return from;
  const m = from.match(EMAIL_RE);
  if (!m) return '[redacted]';
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
