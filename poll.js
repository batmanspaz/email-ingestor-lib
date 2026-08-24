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
 * @returns {Promise<{fetched:number, processed:number, errors:number, forwarded:number,
 *   archived:number, truncated:number, quarantined:number, historyExpired:number,
 *   maxStalledRuns:number}>}
 */
export async function poll(config, handler) {
  const { clients, statePath, maxPerRun = 50, dryRun = false, invokeHandlerInDryRun = false, archiveAfterProcess = false } = config;
  const stats = {
    fetched: 0, processed: 0, errors: 0, forwarded: 0, archived: 0,
    truncated: 0,        // history windows getHistory had to cut short
    quarantined: 0,      // messages retired after repeated deterministic failure
    historyExpired: 0,   // KNOWN-LOSS events: Gmail's ~7d history aged out
    maxStalledRuns: 0,   // worst consecutive runs an account's cursor sat still
  };

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
      continue; // first run: no prior cursor, so nothing to call a stall
    }

    // Stall bookkeeping. PROGRESS means the cursor moved OR we handled at least
    // one message — not the cursor alone. An UNtruncated overflow drain parks
    // the cursor by design while the ring drains forward, which is healthy and
    // routine (personal really saw 480/477/470-message bursts), so counting a
    // parked cursor as stalled would have failed a producer doing exactly what
    // it should. A check that reddens on healthy behaviour trains people to
    // ignore it, which is the failure this whole health effort exists to avoid.
    //
    // Declared here and called from every exit path below — the early
    // `continue` branches previously neither incremented nor reset it, so a
    // count accrued during a drain survived into a later quiet period, and the
    // wedges that manifest ONLY in those branches (an unattributable id, the
    // backward clamp) were invisible to the very check built to catch them.
    const failures = state.accounts[accountKey].messageFailures || {};
    let handledCount = 0;
    /**
     * @param {boolean} caughtUp — the window was empty and complete, i.e. there
     *   was no work to do. "Quiet" and "stuck" ARE distinguishable, by whether
     *   work remained. An idle account's cursor does not move because
     *   getCurrentHistoryId() returns the same profile historyId it was already
     *   set from — so without this every quiet run counted as a stall and a
     *   mailbox idle for three days reported DOWN. CollageSoup's normal
     *   behaviour is exactly that. A genuine wedge always presents a NON-empty
     *   enumeration, so it still counts.
     */
    const noteRun = (caughtUp = false) => {
      if (dryRun) return;
      const acct = state.accounts[accountKey];
      const advanced = acct.lastHistoryId !== historyId;
      const progress = advanced || handledCount > 0 || caughtUp;
      acct.stalledRuns = progress ? 0 : (acct.stalledRuns || 0) + 1;
      if (acct.stalledRuns > stats.maxStalledRuns) stats.maxStalledRuns = acct.stalledRuns;
    };

    // Durable processed-ring (2026-08-04 dup-storm fix): with producers no
    // longer archiving (single-writer contract), a parked cursor re-fetches
    // the SAME window every run — the ring records what was already handled
    // so overflow drains forward instead of looping on the first batch.
    const RING_MAX = 1000;
    // Attempts before a message is retired. 3 tolerates transient network and
    // API flakes across separate runs while bounding how long one bad message
    // can hold the cursor: at 2 runs/day it resolves inside two days.
    const MAX_MESSAGE_ATTEMPTS = 3;
    // Bound on the persisted failure map — see the write site below.
    const MAX_TRACKED_FAILURES = 50;
    const ringList = state.accounts?.[accountKey]?.processedIds || [];
    const ring = new Set(ringList);
    const ringAdd = (id) => {
      if (!ring.has(id)) { ring.add(id); ringList.push(id); handledCount++; }
      delete failures[id]; // every ring path clears the count; no orphans in state
    };

    // Durable per-message failure counts (declared above ringAdd, which clears
    // them). A message that fails deterministically — malformed MIME, a handler
    // crash — is never ringed, so it breaks watermark contiguity at its own
    // position FOREVER: the cursor freezes, everything past the enumeration cap
    // is never listed, and after ~7 days the history window expires and the
    // backlog is lost silently. Retiring the message after MAX_MESSAGE_ATTEMPTS
    // trades one message for the rest of the queue.
    //
    // NOTE the asymmetry: this 3-strike protection exists only inside TRUNCATED
    // windows. On the untruncated path the cursor advances to now, so an errored
    // message is never re-listed and gets zero strikes — it is simply lost, as
    // it always has been. Unifying that is a separate change (advance untruncated
    // to lastEnumeratedHistoryId too); do not read the quarantine block as a
    // universal guarantee.

    // Fetch new message IDs
    const history = await client.getHistory(historyId);

    if (history === null) {
      // KNOWN LOSS. Gmail's history window (~7 days) aged out before we drained
      // it, so whatever sat between the old cursor and now was never listed and
      // never will be — a historyId cursor cannot look backwards. Counted and
      // health-checked as a failure, not warned into a log nobody reads.
      stats.historyExpired++;
      console.error(
        `  [${label}] HISTORY EXPIRED — resetting historyId. Messages between the old` +
        ` cursor and now were never enumerated and are NOT recoverable by polling.`,
      );
      const fresh = await client.getCurrentHistoryId();
      state.accounts[accountKey].lastHistoryId = fresh;
      state.accounts[accountKey].lastRunAt = new Date().toISOString();
      noteRun();
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
     * So: advance to the last fully-handled RECORD. A ring hole stops it dead —
     * we would rather re-list a handled message (the ring absorbs it) than step
     * over an unhandled one (unrecoverable).
     *
     * RECORD granularity, not message granularity, and this distinction is the
     * whole correctness argument. A history record's `messagesAdded` is an
     * ARRAY: one record can carry several messages, and the cursor addresses
     * RECORDS. A first cut of this walked per-message, so a record holding one
     * ringed and one unringed message committed the cursor TO that record —
     * and `startHistoryId` is exclusive, so the unringed sibling was never
     * listed again. That reproduced the very bug this code exists to fix, one
     * granularity finer; two independent audits caught it on 2026-08-23.
     *
     * The result is also clamped to never move backward. Gmail documents
     * ascending record order, but the cursor is durable state and a regression
     * would enlarge the next window, re-truncate, re-derive a smaller
     * watermark, and stall on itself — so we do not take the ordering on trust.
     */
    const nextCursor = async () => {
      if (!truncated) return await client.getCurrentHistoryId();

      // Group the enumerated ids by their record, preserving first-seen order.
      const order = [];
      const byRecord = new Map();
      for (const id of enumerated) {
        const rec = historyIdById[id];
        if (rec === undefined) return null; // unattributable id — refuse to advance
        if (!byRecord.has(rec)) { byRecord.set(rec, []); order.push(rec); }
        byRecord.get(rec).push(id);
      }

      // Every comparison is BigInt — Gmail historyIds are large integers and a
      // string compare would order '9' after '100'. The WHOLE computation is
      // guarded, not just the final clamp: a non-numeric id must park, never
      // throw out of poll() and take the entire run down with it. "Refuse
      // rather than guess" is the module's stance everywhere else.
      try {
        let watermark = null;
        let lowestUnhandled = null;
        for (const rec of order) {
          if (byRecord.get(rec).every((id) => ring.has(id))) {
            if (lowestUnhandled === null) watermark = rec;
          } else if (lowestUnhandled === null || BigInt(rec) < BigInt(lowestUnhandled)) {
            lowestUnhandled = rec;
          }
        }
        if (watermark === null) return null; // nothing fully handled yet => park

        // Clamp below the LOWEST unhandled record, not merely below the first
        // one encountered. This is what makes the ascending-order assumption
        // unnecessary rather than merely documented: if records ever arrive out
        // of order, a handled record sorting above an unhandled one must not
        // carry the cursor past it.
        if (lowestUnhandled !== null && BigInt(watermark) >= BigInt(lowestUnhandled)) return null;
        if (BigInt(watermark) <= BigInt(historyId)) return null; // never regress
        return watermark;
      } catch {
        return null;
      }
    };

    if (messageIds.length === 0) {
      const fresh = await nextCursor();
      if (fresh) state.accounts[accountKey].lastHistoryId = fresh;
      state.accounts[accountKey].lastRunAt = new Date().toISOString();
      // Nothing in the window at all. `truncated` cannot be true here (it needs
      // a full page of ids), so this is genuinely caught up, not wedged.
      noteRun(true);
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
      noteRun(!truncated); // untruncated + all ringed = caught up; truncated = wedge
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
        if (!dryRun) { ringAdd(id); delete failures[id]; }
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
          if (!dryRun) {
            failures[id] = (failures[id] || 0) + 1;
            if (failures[id] >= MAX_MESSAGE_ATTEMPTS) {
              console.error(
                `    QUARANTINED ${id} after ${failures[id]} failed attempts — ` +
                `retiring it so the cursor can advance past its record. This message ` +
                `is DROPPED and will not be retried.`,
              );
              ringAdd(id); // also clears failures[id]
              const q = state.accounts[accountKey].quarantinedIds || [];
              q.push(id);
              // Capped: the drop must be auditable, not unbounded. The message
              // is still in the mailbox — recoverable, but only if its id survived.
              state.accounts[accountKey].quarantinedIds = q.slice(-200);
              stats.quarantined++;
            }
          }
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
      // Bounded like processedIds: a message that errors once and is never
      // re-listed (the untruncated path advances regardless of errors) would
      // otherwise leave its entry in state forever, and state.json is rewritten
      // in full on every run.
      state.accounts[accountKey].messageFailures = Object.fromEntries(
        Object.entries(failures).slice(-MAX_TRACKED_FAILURES),
      );
    }
    noteRun();
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
