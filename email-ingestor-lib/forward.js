/**
 * forward.js — Forward misrouted emails to the correct entity account
 *
 * Uses GmailClient.forwardEmail() under the hood. Applies forward rules
 * (defined per-entity) to determine if a message should be forwarded.
 */

import { GmailClient } from './gmail.js';

/**
 * Compile a rule pattern into a case-insensitive whole-word regex.
 *
 * Patterns are literal strings, not regexes — special chars are escaped.
 * Word boundaries are only asserted where the pattern edge is a word
 * character, so patterns like 'perfect city' or 'perfectcity.com' match
 * naturally while short patterns like 'ruc' no longer match inside
 * unrelated words ("truck", "instructions", "crucial").
 *
 * @param {string} pattern — literal pattern from a forward rule
 * @returns {RegExp}
 */
export function compilePattern(pattern) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lead = /^\w/.test(pattern) ? '\\b' : '';
  const trail = /\w$/.test(pattern) ? '\\b' : '';
  return new RegExp(`${lead}${escaped}${trail}`, 'i');
}

/**
 * Check forward rules and forward if matched.
 *
 * @param {object} message — Gmail message metadata (from fetchMetadata)
 * @param {GmailClient} client — the source account's client
 * @param {Array<{patterns: string[], target: string, label: string}>} rules — forward rules
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false] — if true, log the matched rule but do NOT forward;
 *   the result carries dryRun: true so callers can skip their own follow-up writes
 * @returns {Promise<{forwarded: boolean, target?: string, rule?: string, dryRun?: boolean}>}
 */
export async function checkAndForward(message, client, rules, opts = {}) {
  const { dryRun = false } = opts;
  const subject = GmailClient.getHeader(message, 'Subject') || '';
  const from = GmailClient.getHeader(message, 'From') || '';
  const snippet = message.snippet || '';
  const haystack = `${subject} ${from} ${snippet}`;

  for (const rule of rules) {
    const matched = rule.patterns.some(p => compilePattern(p).test(haystack));
    if (matched) {
      if (dryRun) {
        console.log(`    [DRY] would forward to ${rule.target} (rule: ${rule.label})`);
        return { forwarded: true, target: rule.target, rule: rule.label, dryRun: true };
      }
      console.log(`    → Forwarding to ${rule.target} (rule: ${rule.label})`);
      await client.forwardEmail(message.id, rule.target);
      return { forwarded: true, target: rule.target, rule: rule.label };
    }
  }

  return { forwarded: false };
}
