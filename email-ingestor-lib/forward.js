/**
 * forward.js — Forward misrouted emails to the correct entity account
 *
 * Uses GmailClient.forwardEmail() under the hood. Applies forward rules
 * (defined per-entity) to determine if a message should be forwarded.
 */

import { GmailClient } from './gmail.js';

/**
 * Check forward rules and forward if matched.
 *
 * @param {object} message — Gmail message metadata (from fetchMetadata)
 * @param {GmailClient} client — the source account's client
 * @param {Array<{patterns: string[], target: string, label: string}>} rules — forward rules
 * @returns {Promise<{forwarded: boolean, target?: string, rule?: string}>}
 */
export async function checkAndForward(message, client, rules) {
  const subject = GmailClient.getHeader(message, 'Subject') || '';
  const from = GmailClient.getHeader(message, 'From') || '';
  const snippet = message.snippet || '';
  const haystack = `${subject} ${from} ${snippet}`.toLowerCase();

  for (const rule of rules) {
    const matched = rule.patterns.some(p => haystack.includes(p.toLowerCase()));
    if (matched) {
      console.log(`    → Forwarding to ${rule.target} (rule: ${rule.label})`);
      await client.forwardEmail(message.id, rule.target);
      return { forwarded: true, target: rule.target, rule: rule.label };
    }
  }

  return { forwarded: false };
}
