/**
 * producer-health.js — health status derivation + analytics event shape for
 * every entity's Sluice producer, built on the REAL @perfectcity/telemetry
 * client (schema validation + PII scanning already live in that package —
 * this module doesn't reimplement either, it just supplies the producer-
 * specific shape). Mirrors intake's own sluice-dispatch-health.js.
 */

import path from 'node:path';
import { computeQueueDepthCheck } from './queue-depth.js';

export function computeProducerStatus({ fetched, errors, messageErrors, accountErrors }) {
  // TWO UNITS, not one number (tasks.db #1056). poll() counts a message the handler could not
  // process and a whole account that threw before listing anything in SEPARATE counters, because
  // they mean different things:
  //
  //   messageErrors — n of the fetched items had trouble. Partial, usually transient.
  //   accountErrors — an entity's mail has stopped arriving at all. Not partial, not transient.
  //
  // Summed, the second hides inside the first on any busy run: a dead account alongside four
  // healthy ones is {fetched: 5, errors: 2}, which reads as "2 of 5 items had trouble" and lands
  // on 'degraded'. The more mail the healthy accounts carry, the better the dead one hides. That
  // was the shape of the emilee.stone@collagesoup.com auth-dead incident (tasks.db #1056,
  // diagnosed 2026-09-14; the account was re-seeded that day and has been fetching mail normally
  // on every run since — see ~/claude/shared/logs/email-ingestor-collagesoup.log. Historical
  // example of the failure class, not a live account issue).
  //
  // So: any account error is 'down' on its own, regardless of how well everything else went.
  // A message error is weighed against fetched, as before.
  if (validCount(accountErrors) && accountErrors > 0) return 'down';

  if (validCount(accountErrors) && validCount(messageErrors)) {
    // Coherence guard (tasks.db #1056 defect 2b, Opus — 3-model audit of PR #59). accountErrors
    // is already excluded above when it is a valid > 0, so reaching here means accountErrors is
    // 0. A caller can still hand in a valid, ZEROED split (messageErrors:0, accountErrors:0)
    // beside a summed `errors` that disagrees with it — {errors:2, messageErrors:0,
    // accountErrors:0} is structurally impossible on pre-PR main (there was only one number to
    // report) and must never be trusted into 'ok' just because the split says nothing happened.
    // An incoherent split is evidence the split itself is wrong (a bug in poll(), or a hand-built
    // stats object), not evidence of health, so it falls through to the legacy summed comparator
    // below, which reads `errors` directly and cannot go green on a nonzero count.
    const splitIsCoherent = !validCount(errors) || errors === messageErrors + accountErrors;
    if (splitIsCoherent) {
      if (messageErrors === 0) return 'ok';
      // Round 3 fix (tasks.db #1056, verified by execution). `fetched === 0` used to short-circuit
      // straight to 'down' on the premise that fetched:0 with a messageError is arithmetically
      // impossible garbage input — true before the `listed`-flag fix to poll.js, false now: a
      // quiet account (getHistory succeeds, 0 new mail) whose subsequent
      // getCurrentHistoryId()/writeState() throws legitimately counts as a messageError with
      // fetched still 0. accountErrors is already confirmed valid-and-zero to reach this branch,
      // so that shape is one quiet-but-healthy account having a real transient blip — 'degraded',
      // not a full outage. Gating on `fetched > 0` instead of dropping the check outright keeps
      // the real "every fetched item failed" case ('down' when messageErrors >= fetched > 0)
      // intact.
      //
      // `fetched` guard (tasks.db #1070, defense-in-depth). It is the one count this branch reads,
      // and round 3 left it as the only one WITHOUT a validCount() check. Note what the `fetched >
      // 0` gate actually does: it DE-ESCALATES — it is the sole reason the "every fetched item
      // failed" verdict ever softens from 'down' to 'degraded'. So an unusable fetched bought the
      // lenient answer for free ({fetched:-1, messageErrors:1, accountErrors:0} returned
      // 'degraded'), which is "missing = healthy" rebuilt in the denominator instead of the
      // numerator (dev-rules §28.1). Only a trustworthy fetched can establish that a failure was
      // partial, so an untrustworthy one may not claim it — same convention validCount() already
      // enforces on messageErrors/accountErrors, and the same asymmetry as honouring a valid
      // accountErrors when messageErrors is missing: the bad news is never the optional half.
      //
      // validCount(0) is true, so the quiet-account shape round 3 was written for is untouched.
      // Structurally unreachable via poll.js — stats.fetched is initialized to 0 and only ever
      // incremented — so this is here to make a malformed caller fail loud rather than silently
      // shift severity as a side effect of some future unrelated refactor.
      if (!validCount(fetched)) return 'down';
      if (fetched > 0 && messageErrors >= fetched) return 'down';
      return 'degraded';
    }
  }

  // LEGACY SUMMED SHAPE. The three consumer repos pin this lib by git SHA and upgrade
  // independently, so a caller on an older poll() keeps sending only `errors` for a while. That
  // path must not change meaning, so it is preserved verbatim, including its own history:
  //
  // `fetched === 0` must NOT short-circuit to 'ok' — a quiet error-free run and a fully-failed
  // run both have fetched === 0, and only errors tells them apart (tasks.db #1054, the Rule-13
  // "missing = healthy" banned pattern). `errors >= fetched` (not `===`) because the summed count
  // can legitimately exceed fetched: one account fetches 1 message that errors, a second account
  // throws outright -> fetched:1, errors:2.
  //
  // Coherence guard (tasks.db #1056 round 2, M-5, Opus). A split field that is PRESENT but not a
  // usable number (a string, NaN, negative) is different from one that is simply ABSENT — absent
  // means "this caller is on the legacy shape", present-but-invalid means a caller tried to report
  // a split and the value is garbage. validCount()'s own docblock already says an invalid count
  // must never stand in for zero, but reaching this branch at all meant BOTH validCount() checks
  // above already failed silently on that garbage value — nothing stopped it from falling all the
  // way through to `errors === 0` and reporting a clean 'ok'
  // (computeProducerStatus({fetched:0, errors:0, messageErrors:0, accountErrors:'3'}) did exactly
  // that). Floors the result at 'degraded' when garbage is present: never promotes an already-worse
  // legacy verdict, only ever prevents a false 'ok'.
  const accountErrorsPresentButInvalid = accountErrors !== undefined && !validCount(accountErrors);
  const messageErrorsPresentButInvalid = messageErrors !== undefined && !validCount(messageErrors);
  const splitFieldPresentButInvalid = accountErrorsPresentButInvalid || messageErrorsPresentButInvalid;

  if (errors === 0) return splitFieldPresentButInvalid ? 'degraded' : 'ok';
  if (fetched === 0 || errors >= fetched) return 'down';
  return 'degraded';
}

const CHECK_STATUS_BY_HEALTH_STATUS = {
  ok: 'pass',
  degraded: 'warn',
  down: 'fail',
};

const HEALTH_STATUS_BY_CHECK_STATUS = {
  pass: 'ok',
  warn: 'degraded',
  fail: 'down',
};

const HEALTH_SEVERITY = { ok: 0, degraded: 1, down: 2 };

/** A count is only trustworthy if it is a finite, non-negative number. */
function invalidCount(n) {
  return typeof n !== 'number' || !Number.isFinite(n) || n < 0;
}

/** Inverse of invalidCount, for the places that read better in the positive. NaN from a
 *  Number(...) coercion and a string from a hand-wired consumer are both rejected: neither is
 *  evidence of anything, so neither may quietly stand in for zero (dev-rules §28.1). */
function validCount(n) {
  return !invalidCount(n);
}

/**
 * history.truncation — how many history windows getHistory had to truncate.
 *
 * Emitted on EVERY report, including at zero. Before 2026-08-23 truncation was
 * a console.warn into a log nothing reads; it fired 44 times on personal while
 * messages fell behind the cursor and surfaced only via an unrelated audit.
 * dev-rules §28.1 bans "missing = healthy", so no-truncation must be an
 * asserted 0, not an absent check.
 *
 * `warn`, never `fail`: with the contiguous-handled watermark in poll.js a
 * truncated window is no longer lossy — it means the producer is BEHIND and
 * draining over several runs, which is worth seeing and is not an outage.
 * An absent/undefined count is treated as unknown and is deliberately not green.
 *
 * Shape is constrained by HealthCheckSchema (.strict()): {id, status, detail?,
 * metric?, unit?} only. An extra key makes telemetry.js discard the WHOLE report.
 */
export function computeTruncationCheck(truncatedCount) {
  // Anything that is not a finite, non-negative number is UNKNOWN, never green.
  // NaN reaches here from Number(process.env.X) or from summing an undefined; a
  // string from a consumer wiring this by hand. Both previously rendered as
  // `pass` — "missing = healthy" rebuilt one layer up — and NaN was additionally
  // schema-invalid, which makes telemetry.js discard the WHOLE report.
  if (invalidCount(truncatedCount)) {
    return {
      id: 'history.truncation',
      status: 'warn',
      unit: 'count',
      detail:
        truncatedCount === undefined || truncatedCount === null
          ? 'truncation count not reported by poll() — cannot assert zero'
          : 'truncation count is not a valid non-negative number — cannot assert zero',
    };
  }
  return {
    id: 'history.truncation',
    status: truncatedCount > 0 ? 'warn' : 'pass',
    metric: truncatedCount,
    unit: 'count',
    detail:
      truncatedCount > 0
        ? `${truncatedCount} history window(s) truncated — producer is behind, draining across runs`
        : 'no truncated history windows',
  };
}

/**
 * history.expired — Gmail's ~7-day history window aged out before the producer
 * drained it. Everything between the old cursor and now was never enumerated
 * and CANNOT be recovered by polling: a historyId cursor does not look
 * backwards. That is known, unrecoverable loss, so this is `fail`, not `warn`.
 * Emitted at zero like the others — silence is not evidence of absence.
 */
export function computeHistoryExpiredCheck(count) {
  if (invalidCount(count)) {
    return {
      id: 'history.expired',
      status: 'warn',
      unit: 'count',
      detail: 'history-expiry count not reported by poll() — cannot assert zero',
    };
  }
  return {
    id: 'history.expired',
    status: count > 0 ? 'fail' : 'pass',
    metric: count,
    unit: 'count',
    detail:
      count > 0
        ? `${count} history window(s) expired before draining — mail in the gap was never enumerated and is NOT recoverable by polling`
        : 'no history windows expired',
  };
}

/**
 * message.quarantined — messages this producer DELIBERATELY dropped after
 * repeated failure, to stop one bad message wedging the cursor until Gmail's
 * history aged out and took the whole backlog with it.
 *
 * `fail`, like history.expired: this is intentional, permanent loss. Counting
 * it and writing a console.error would be the exact posture this module
 * condemns two docblocks up. The message is still in the mailbox and its id is
 * persisted in account state, so it is recoverable — but only by someone who
 * knows it happened.
 */
export function computeQuarantineCheck(count) {
  if (invalidCount(count)) {
    return {
      id: 'message.quarantined',
      status: 'warn',
      unit: 'count',
      detail: 'quarantine count not reported by poll() — cannot assert zero',
    };
  }
  return {
    id: 'message.quarantined',
    status: count > 0 ? 'fail' : 'pass',
    metric: count,
    unit: 'count',
    detail:
      count > 0
        ? `${count} message(s) deliberately dropped after repeated failure — ids are in account state under quarantinedIds`
        : 'no messages quarantined',
  };
}

/**
 * cursor.stalled — consecutive runs in which an account's cursor did not move.
 * Every wedge this module can suffer takes this shape, and "quiet" and "stuck"
 * are indistinguishable without it. Threshold is 6 runs: at the deployed
 * 2-runs-a-day cadence that is three days of no forward progress, comfortably
 * inside Gmail's ~7-day history retention so it fires while recovery is still
 * possible rather than after the window has aged out.
 */
const STALL_FAIL_RUNS = 6;

export function computeStallCheck(consecutiveRuns) {
  if (invalidCount(consecutiveRuns)) {
    return {
      id: 'cursor.stalled',
      status: 'warn',
      unit: 'count',
      detail: 'stall count not reported by poll() — cannot assert the cursor is moving',
    };
  }
  return {
    id: 'cursor.stalled',
    status: consecutiveRuns >= STALL_FAIL_RUNS ? 'fail' : 'pass',
    metric: consecutiveRuns,
    unit: 'count',
    detail:
      consecutiveRuns >= STALL_FAIL_RUNS
        ? `cursor has not advanced for ${consecutiveRuns} consecutive runs — the producer is stuck, not quiet`
        : `cursor advancing (${consecutiveRuns} quiet run(s))`,
  };
}

/**
 * @param {import('@perfectcity/telemetry').Telemetry} telemetry
 * @param {{fetched:number, produced:number, errors:number, truncated:number,
 *          historyExpired:number, maxStalledRuns:number, quarantined:number}} stats
 *   — all seven fields are REQUIRED, not optional. Each of the last four is
 *   read through an invalidCount() guard that treats an absent/undefined
 *   count as UNKNOWN and reports `warn` for it (missing = healthy is banned,
 *   dev-rules Sec28.1) — marking them `?` here is exactly what licensed every
 *   call site to hand-build a three-field object and drop the other four,
 *   which pinned producer.* to a permanent `degraded` (tasks.db #948). Build
 *   this object with producerHealthStats() below, not by hand.
 * @param {{sluiceDir?:string, now?:Date}} [opts] — sluiceDir defaults to
 *   process.env.INTAKE_DIR, falling back to the deprecated process.env.SLUICE_DIR
 *   (the Aug 2026 Intake rename — mirrors src/sluice-config.js:resolveDropDir()
 *   in every consumer repo, so a caller that doesn't pass opts.sluiceDir
 *   explicitly still resolves the real drop dir instead of reporting a false
 *   queue.depth failure); unset/missing (neither var set) reports queue.depth
 *   as fail, never green (2026-08-02 rule).
 */
export async function reportProducerHealth(telemetry, stats, opts = {}) {
  const { sluiceDir = process.env.INTAKE_DIR || process.env.SLUICE_DIR, now = new Date() } = opts;
  const producerStatus = computeProducerStatus(stats);

  const queueCheck = computeQueueDepthCheck({
    inboxDir: sluiceDir ? path.join(sluiceDir, 'inbox') : null,
    now,
  });

  const truncationCheck = computeTruncationCheck(stats.truncated);
  const expiredCheck = computeHistoryExpiredCheck(stats.historyExpired);
  const stallCheck = computeStallCheck(stats.maxStalledRuns);
  const quarantineCheck = computeQuarantineCheck(stats.quarantined);

  // Overall status is the WORST of EVERY check, not just the producer's own run.
  // A green producer filling a queue nothing drains is an outage (the 2026-08-02
  // lesson); one that keeps truncating its window is behind; one whose cursor
  // has stopped moving is stuck; one that let its history expire has already
  // lost mail. None of those may be reported as ok.
  const status = [
    producerStatus,
    HEALTH_STATUS_BY_CHECK_STATUS[queueCheck.status],
    HEALTH_STATUS_BY_CHECK_STATUS[truncationCheck.status],
    HEALTH_STATUS_BY_CHECK_STATUS[expiredCheck.status],
    HEALTH_STATUS_BY_CHECK_STATUS[stallCheck.status],
    HEALTH_STATUS_BY_CHECK_STATUS[quarantineCheck.status],
  ].reduce((worst, s) => (HEALTH_SEVERITY[s] > HEALTH_SEVERITY[worst] ? s : worst));

  await telemetry.reportHealth({
    status,
    checks: [
      {
        id: 'producer_run',
        status: CHECK_STATUS_BY_HEALTH_STATUS[producerStatus],
        metric: stats.produced,
        unit: 'count',
      },
      queueCheck,
      truncationCheck,
      expiredCheck,
      stallCheck,
      quarantineCheck,
    ],
  });
}

/**
 * @param {import('@perfectcity/telemetry').Telemetry} telemetry
 * @param {{entityId:string, fetched:number, produced:number, skipped:number, errors:number,
 *          messageErrors:number, accountErrors:number, quarantined:number}} params
 *
 * `message_errors` / `account_errors` are emitted alongside the summed `errors`, not instead of
 * it (tasks.db #1056). Health status is only one consumer of these counts — a dashboard
 * reasoning over a single summed column is equally unable to tell "3 of 40 messages had trouble"
 * from "an entity's mail stopped arriving", and Rule 13 makes analytics a Phase-0 invariant
 * alongside health. Both are emitted AT ZERO on a clean run: an absent counter is not evidence
 * of absence (dev-rules §28.1).
 */
export function trackProducerRun(
  telemetry,
  { entityId, fetched, produced, skipped, errors, messageErrors = 0, accountErrors = 0, quarantined = 0 },
) {
  telemetry.track({
    event: 'producer.run',
    props: {
      entity_id: entityId,
      fetched,
      produced,
      skipped,
      errors,
      message_errors: messageErrors,
      account_errors: accountErrors,
      quarantined,
    },
  });
}

/**
 * Adapter from poll()'s return shape to reportProducerHealth()'s stats
 * contract — the ONE definition every consumer repo should call, instead of
 * hand-building `{ fetched, produced, errors }` (tasks.db #948) or pasting an
 * identical copy of this function into each repo's own src/sluice-config.js
 * (tasks.db #958 — collagesoup's local copy was the first of what would have
 * become three).
 *
 * poll()'s result is passed THROUGH, with only the one rename the two
 * contracts disagree on (`processed` -> `produced`), so a count poll() adds
 * tomorrow reaches the health report without an edit at every call site.
 * `errors` is passed through, NOT defaulted — computeProducerStatus() reads
 * it WITHOUT an invalidCount() guard, so a laundered zero would silently
 * report 'ok'.
 *
 * @param {{fetched:number, processed:number, errors:number, truncated?:number,
 *   historyExpired?:number, maxStalledRuns?:number, quarantined?:number}} stats
 *   — poll()'s return value.
 * @returns {object} stats shaped for reportProducerHealth() above.
 */
export function producerHealthStats(stats) {
  return { ...stats, produced: stats.processed };
}

/**
 * Adapter from poll()'s return shape to trackProducerRun()'s params contract
 * — the analytics twin of producerHealthStats() above, and here for the same
 * reason (tasks.db #948's 3-model review): trackProducerRun() declares
 * `quarantined = 0` as a DEFAULT PARAMETER, so an omitted field reads as
 * "none", not "unknown" — the producer.run event would claim zero quarantined
 * messages on precisely the run whose health report says otherwise.
 *
 * `skipped` is genuinely 0 and not a dropped field: poll() has no separate
 * skipped counter — an idempotent re-run (envelope already exists) still
 * counts as `processed` from poll()'s point of view.
 *
 * `messageErrors` / `accountErrors` are forwarded the same way (tasks.db #1056 defect 1, 3-model
 * audit of PR #59): this function used to hand-enumerate its return object and silently dropped
 * both fields, so trackProducerRun()'s own `= 0` default parameters replaced a REAL dead-account
 * run with a laundered zero on the wire — the exact metric a dashboard would filter on to catch
 * this class of incident never arrived. Forwarded directly, not through `|| 0`: poll() always
 * initializes both to a real number, so there is nothing to default, and defaulting here would
 * silently reintroduce the same masking one layer up if that ever stopped being true.
 *
 * @param {string} entityId
 * @param {{fetched:number, processed:number, errors:number, messageErrors?:number,
 *   accountErrors?:number, quarantined?:number}} stats — poll()'s return value.
 */
export function producerRunStats(entityId, stats) {
  return {
    entityId,
    fetched: stats.fetched,
    produced: stats.processed,
    skipped: 0,
    errors: stats.errors || 0,
    messageErrors: stats.messageErrors,
    accountErrors: stats.accountErrors,
    quarantined: stats.quarantined ?? 0,
  };
}
