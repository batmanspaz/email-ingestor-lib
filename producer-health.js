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
  if (truncatedCount === undefined || truncatedCount === null) {
    return {
      id: 'history.truncation',
      status: 'warn',
      unit: 'count',
      detail: 'truncation count not reported by poll() — cannot assert zero',
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
 * @param {import('@perfectcity/telemetry').Telemetry} telemetry
 * @param {{fetched:number, produced:number, errors:number, truncated?:number}} stats
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

  // Overall status is the WORST of the producer's own run and the queue it
  // feeds — a green producer filling a queue nothing drains is an outage,
  // which is exactly what the pre-2026-08-02 report failed to say.
  const truncationCheck = computeTruncationCheck(stats.truncated);

  // Overall status is the WORST of every check, not just the producer's own run
  // — a green producer that keeps truncating its window is behind, and a green
  // producer filling a queue nothing drains is an outage.
  const queueStatus = HEALTH_STATUS_BY_CHECK_STATUS[queueCheck.status];
  const truncationStatus = HEALTH_STATUS_BY_CHECK_STATUS[truncationCheck.status];
  const status = [producerStatus, queueStatus, truncationStatus].reduce((worst, s) =>
    HEALTH_SEVERITY[s] > HEALTH_SEVERITY[worst] ? s : worst,
  );

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
    ],
  });
}

/**
 * @param {import('@perfectcity/telemetry').Telemetry} telemetry
 * @param {{entityId:string, fetched:number, produced:number, skipped:number, errors:number}} params
 */
export function trackProducerRun(telemetry, { entityId, fetched, produced, skipped, errors }) {
  telemetry.track({
    event: 'producer.run',
    props: { entity_id: entityId, fetched, produced, skipped, errors },
  });
}
