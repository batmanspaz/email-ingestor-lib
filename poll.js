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
 * @param {boolean} [config.dryRun=false] — if true, don't update state or call handler;
 *   each new message is logged as "[DRY] would process" instead
 * @param {boolean} [config.invokeHandlerInDryRun=false] — opt-in: call the handler even in
 *   dry-run, passing { dryRun: true } as its third argument. Only set this if the handler
 *   gates ALL of its side effects (forwards, file/DB/queue writes) on that flag.
 * @param {boolean} [config.archiveAfterProcess=false] — remove INBOX label for every
 *   processed message after the per-account loop. Keeps entity inboxes thin.
 *   Forwarded messages are also archived (already handled at destination).
 *   Has no effect in dryRun mode.
 * @param {function} handler — async (message, client, { dryRun }) => void, called for each new message
 * @returns {Promise<{fetched: number, processed: number, errors: number, forwarded: number, archived: number}>}
 */
export async function poll(config, handler) {
  const { clients, statePath, maxPerRun = 50, dryRun = false, invokeHandlerInDryRun = false, archiveAfterProcess = false } = config;
  const stats = { fetched: 0, processed: 0, errors: 0, forwarded: 0, archived: 0, truncated: 0 };

  const state = readState(statePath);
  const seenMessageIds = new Set();

  for (const clientEntry of clients) {
    const { client, label } = clientEntry;
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

    // Durable processed-ring (2026-08-04 dup-storm fix): with producers no
    // longer archiving (single-writer contract), a parked cursor re-fetches
    // the SAME window every run — the ring records what was already handled
    // so overflow drains forward instead of looping on the first batch.
    const RING_MAX = 1000;
    const ringList = state.accounts?.[accountKey]?.processedIds || [];
    const ring = new Set(ringList);
    const ringAdd = (id) => { if (!ring.has(id)) { ring.add(id); ringList.push(id); } };

    // Fetch new message IDs
    const history = await client.getHistory(historyId);

    if (history === null) {
      console.warn(`  [${label}] History expired — resetting historyId`);
      const fresh = await client.getCurrentHistoryId();
      state.accounts[accountKey].lastHistoryId = fresh;
      state.accounts[accountKey].lastRunAt = new Date().toISOString();
      if (!dryRun) writeState(statePath, state);
      continue;
    }

    const { ids: enumerated, truncated, historyIdById } = history;
    let messageIds = enumerated;

    // Counted, not just warned. A truncated window is no longer lossy (see the
    // watermark below) but it means this account is behind, and that must reach
    // the health report rather than a log file nobody reads.
    if (truncated) stats.truncated++;

    /**
     * Where the cursor may safely move to.
     *
     * UNtruncated: the whole window was enumerated, so "now" is correct — this
     * is the long-proven path and is deliberately unchanged.
     *
     * TRUNCATED (getHistory hit its cap with more pages pending): "now" would
     * orphan every message past the cap — they were never listed, never ringed,
     * and a historyId cursor cannot look backwards. That is the 2026-08-23 mail
     * loss, 44 occurrences on personal.
     *
     * But simply PARKING on a truncated window deadlocks the producer:
     * getHistory(startId) is deterministic, so the identical window returns
     * every run, and once all of it is ringed the filter yields empty forever
     * and the cursor never moves again. Neither "advance to now" nor "never
     * advance" is correct.
     *
     * So: advance to the last CONTIGUOUSLY handled message. Everything at or
     * before it is in the ring; nothing after it is skipped. Gmail returns
     * history records in ascending historyId order, which is what makes a
     * prefix watermark meaningful. A ring hole stops the watermark dead — we
     * would rather re-list a handled message (the ring absorbs it) than step
     * over an unhandled one (unrecoverable).
     */
    const nextCursor = async () => {
      if (!truncated) return await client.getCurrentHistoryId();
      let watermark = null;
      for (const id of enumerated) {
        if (!ring.has(id)) break;
        watermark = historyIdById?.[id] ?? watermark;
      }
      return watermark; // null => nothing handled yet => park
    };

    if (messageIds.length === 0) {
      const fresh = await nextCursor();
      if (fresh) state.accounts[accountKey].lastHistoryId = fresh;
      state.accounts[accountKey].lastRunAt = new Date().toISOString();
      if (!dryRun) writeState(statePath, state);
      continue;
    }

    // Skip everything the ring already handled, THEN cap. When there's
    // overflow we must NOT advance the cursor past the messages we didn't
    // process this run, or they're lost forever; the parked cursor plus the
    // ring re-surfaces exactly the unhandled remainder next run.
    messageIds = messageIds.filter(id => !ring.has(id));
    const capped = messageIds.length > maxPerRun;
    if (capped) {
      console.warn(`  [${label}] ${messageIds.length} new — capping to ${maxPerRun}; ${messageIds.length - maxPerRun} deferred to next run`);
      messageIds = messageIds.slice(0, maxPerRun);
    }
    if (messageIds.length === 0) {
      // Everything listed is already ringed. Untruncated that genuinely means
      // caught up; truncated it means "caught up with the part we could see",
      // which is exactly where the old code jumped to now and lost the rest.
      const fresh = await nextCursor();
      if (fresh) state.accounts[accountKey].lastHistoryId = fresh;
      state.accounts[accountKey].lastRunAt = new Date().toISOString();
      if (!dryRun) writeState(statePath, state);
      continue;
    }

    stats.fetched += messageIds.length;
    console.log(`  [${label}] ${messageIds.length} new message(s)`);

    const toArchive = []; // collect processed IDs for inbox cleanup

    for (const id of messageIds) {
      try {
        const meta = await client.fetchMetadata(id);

        // getHistory no longer filters by INBOX label (a current-state filter
        // hid triage-archived mail from producers entirely) — screen the
        // non-mail classes here instead. Screened ids join the ring so they
        // are never refetched. Archived-but-real mail IS processed.
        const labels = meta.labelIds || [];
        if (labels.some(l => l === 'SENT' || l === 'DRAFT' || l === 'SPAM' || l === 'TRASH')) {
          if (!dryRun) ringAdd(id);
          continue;
        }

        const msgId = GmailClient.getHeader(meta, 'Message-ID');

        // Dedupe across accounts (same message delivered to multiple addresses)
        if (msgId && seenMessageIds.has(msgId)) {
          if (!dryRun) ringAdd(id);
          continue;
        }
        if (msgId) seenMessageIds.add(msgId);

        if (dryRun && !invokeHandlerInDryRun) {
          const from = GmailClient.getHeader(meta, 'From') || '(unknown sender)';
          const subject = GmailClient.getHeader(meta, 'Subject') || '(no subject)';
          console.log(`    [DRY] would process: ${from.slice(0, 40)} — ${subject.slice(0, 60)}`);
          stats.processed++;
          continue;
        }

        const result = await handler(meta, client, { dryRun });
        if (result === 'forwarded') stats.forwarded++;
        stats.processed++;
        if (!dryRun) ringAdd(id);
        // Per-client archiveAfterProcess overrides the global setting.
        // Set noArchive: true on a client entry to keep that account's inbox intact.
        const shouldArchive = !dryRun && (clientEntry.noArchive ? false : archiveAfterProcess);
        if (shouldArchive) toArchive.push(id);
      } catch (err) {
        // Gmail 404: message deleted before fetch — skip silently, not an error
        if (err.message?.includes('Requested entity was not found')) {
          stats.processed++;
          if (!dryRun) ringAdd(id);
        } else {
          console.error(`    Error processing ${id}: ${err.message}`);
          stats.errors++;
        }
      }
    }

    // Archive all processed messages in one batch (keeps inbox thin)
    if (toArchive.length > 0) {
      const gmail = client._gmail;
      const CHUNK = 1000;
      for (let i = 0; i < toArchive.length; i += CHUNK) {
        const ids = toArchive.slice(i, i + CHUNK);
        try {
          await gmail.users.messages.batchModify({ userId: 'me', requestBody: { ids, removeLabelIds: ['INBOX'] } });
          stats.archived += ids.length;
        } catch (err) {
          console.warn(`  [${label}] archive batch failed: ${err.message}`);
        }
      }
      console.log(`  [${label}] archived ${toArchive.length} from inbox`);
    }

    // Update historyId for this account.
    //
    // Untruncated: only when the whole batch was processed. On overflow the
    // cursor stays parked and the ring re-surfaces the deferred remainder.
    //
    // Truncated: always move to the contiguous-handled watermark, capped or
    // not. Parking would deadlock (same window forever); "now" would orphan
    // everything past the cap. Note this fires even when !capped — a late run
    // draining the last 20 of a truncated 500 is precisely when the old code
    // jumped to now and lost messages 501+.
    if (truncated) {
      const watermark = await nextCursor();
      if (watermark) state.accounts[accountKey].lastHistoryId = watermark;
    } else if (!capped) {
      const newHistoryId = await client.getCurrentHistoryId();
      state.accounts[accountKey].lastHistoryId = newHistoryId;
    }
    if (!dryRun) {
      state.accounts[accountKey].processedIds = ringList.slice(-RING_MAX);
    }
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
