/**
 * poll.js — Incremental Gmail poll loop using history API
 *
 * Reads history since lastHistoryId, dedupes by message-id, calls handler for each.
 * Designed to be called by entity ingestors on a cron/interval basis.
 */

import fs from 'fs';
import path from 'path';
import { GmailClient } from './gmail.js';

/**
 * Run one poll cycle for a set of accounts.
 *
 * @param {object} config
 * @param {Array<{client: GmailClient, label: string}>} config.clients — Gmail clients to poll
 * @param {string} config.statePath — path to state.json (per-entity)
 * @param {number} [config.maxPerRun=50] — cap messages per cycle
 * @param {boolean} [config.dryRun=false] — if true, don't update state or call handler
 * @param {function} handler — async (message, client) => void, called for each new message
 * @returns {Promise<{fetched: number, processed: number, errors: number, forwarded: number}>}
 */
export async function poll(config, handler) {
  const { clients, statePath, maxPerRun = 50, dryRun = false } = config;
  const stats = { fetched: 0, processed: 0, errors: 0, forwarded: 0 };

  const state = readState(statePath);
  const seenMessageIds = new Set();

  for (const { client, label } of clients) {
    const accountKey = client.account;
    const historyId = state.accounts?.[accountKey]?.lastHistoryId;

    // First run: seed historyId and skip
    if (!historyId) {
      console.log(`  [${label}] No historyId — seeding from current mailbox state...`);
      const currentId = await client.getCurrentHistoryId();
      if (!state.accounts) state.accounts = {};
      state.accounts[accountKey] = {
        lastHistoryId: currentId,
        lastRunAt: new Date().toISOString(),
      };
      if (!dryRun) writeState(statePath, state);
      console.log(`  [${label}] Seeded historyId = ${currentId}`);
      continue;
    }

    // Fetch new message IDs
    let messageIds = await client.getHistory(historyId);

    if (messageIds === null) {
      console.warn(`  [${label}] History expired — resetting historyId`);
      const fresh = await client.getCurrentHistoryId();
      state.accounts[accountKey].lastHistoryId = fresh;
      state.accounts[accountKey].lastRunAt = new Date().toISOString();
      if (!dryRun) writeState(statePath, state);
      continue;
    }

    if (messageIds.length === 0) {
      const fresh = await client.getCurrentHistoryId();
      state.accounts[accountKey].lastHistoryId = fresh;
      state.accounts[accountKey].lastRunAt = new Date().toISOString();
      if (!dryRun) writeState(statePath, state);
      continue;
    }

    // Cap
    if (messageIds.length > maxPerRun) {
      console.warn(`  [${label}] ${messageIds.length} new — capping to ${maxPerRun}`);
      messageIds = messageIds.slice(0, maxPerRun);
    }

    stats.fetched += messageIds.length;
    console.log(`  [${label}] ${messageIds.length} new message(s)`);

    for (const id of messageIds) {
      try {
        const meta = await client.fetchMetadata(id);
        const msgId = GmailClient.getHeader(meta, 'Message-ID');

        // Dedupe across accounts (same message delivered to multiple addresses)
        if (msgId && seenMessageIds.has(msgId)) {
          continue;
        }
        if (msgId) seenMessageIds.add(msgId);

        const result = await handler(meta, client, { dryRun });
        if (result === 'forwarded') stats.forwarded++;
        stats.processed++;
      } catch (err) {
        console.error(`    Error processing ${id}: ${err.message}`);
        stats.errors++;
      }
    }

    // Update historyId for this account
    const newHistoryId = await client.getCurrentHistoryId();
    state.accounts[accountKey].lastHistoryId = newHistoryId;
    state.accounts[accountKey].lastRunAt = new Date().toISOString();
    if (!dryRun) writeState(statePath, state);
  }

  // Update global stats
  if (!dryRun) {
    state.totalProcessed = (state.totalProcessed || 0) + stats.processed;
    state.lastRunAt = new Date().toISOString();
    writeState(statePath, state);
  }

  return stats;
}

function readState(statePath) {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return { accounts: {}, totalProcessed: 0 };
  }
}

function writeState(statePath, state) {
  const dir = path.dirname(statePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = statePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, statePath);
}
