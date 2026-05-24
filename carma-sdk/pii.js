/**
 * pii.js — consolidates 4 copies of maskEmail / maskName / maskPhone
 * (worker/src/pii.js, wayfinder-bot, email-ingestor, pathfinder).
 *
 * Single source of truth for SOC 2-compliant log scrubbing.
 */

export function maskEmail(email) {
  if (!email || typeof email !== 'string') return '[EMAIL]';
  const at = email.indexOf('@');
  if (at < 1) return '[EMAIL]';
  return email[0] + '***@' + email.slice(at + 1);
}

export function maskName(name) {
  if (!name || typeof name !== 'string') return '[NAME]';
  return '[NAME]';
}

export function maskPhone(phone) {
  if (!phone || typeof phone !== 'string') return '[PHONE]';
  return '[PHONE]';
}

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_RE = /(?:\+?1[-.\s]?)?\(?[2-9][0-9]{2}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}\b/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;

/**
 * Scrub a free-form text blob — masks emails, phones, SSNs in place.
 * Used for log lines that might contain user content.
 */
export function scrubText(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    .replace(EMAIL_RE, (m) => maskEmail(m))
    .replace(PHONE_RE, '[PHONE]')
    .replace(SSN_RE, '[SSN]');
}
