/**
 * producer-health.js — health status derivation + analytics event shape for
 * every entity's Sluice producer, built on the REAL @perfectcity/telemetry
 * client (schema validation + PII scanning already live in that package —
 * this module doesn't reimplement either, it just supplies the producer-
 * specific shape). Mirrors intake's own sluice-dispatch-health.js.
 */

import path from 'node:path';
import { computeQueueDepthCheck } from './queue-depth.js';

export function computeProducerStatus({ fetched, errors }) {
  if (fetched === 0 || errors === 0) return 'ok';
  if (errors === fetched) return 'down';
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
 * @param {{fetched:number, produced:number, errors:number, truncated?:number,
 *          historyExpired?:number, maxStalledRuns?:number}} stats
 * @param {{sluiceDir?:string, now?:Date}} [opts] — sluiceDir defaults to
 *   process.env.SLUICE_DIR (the same env the producer wrote envelopes with);
 *   unset/missing reports queue.depth as fail, never green (2026-08-02 rule).
 */
export async function reportProducerHealth(telemetry, stats, opts = {}) {
  const { sluiceDir = process.env.SLUICE_DIR, now = new Date() } = opts;
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
 * @param {{entityId:string, fetched:number, produced:number, skipped:number, errors:number}} params
 */
export function trackProducerRun(telemetry, { entityId, fetched, produced, skipped, errors, quarantined = 0 }) {
  telemetry.track({
    event: 'producer.run',
    props: { entity_id: entityId, fetched, produced, skipped, errors, quarantined },
  });
}
