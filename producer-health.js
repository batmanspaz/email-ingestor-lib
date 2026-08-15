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
 * @param {import('@perfectcity/telemetry').Telemetry} telemetry
 * @param {{fetched:number, produced:number, errors:number}} stats
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
  const queueStatus = HEALTH_STATUS_BY_CHECK_STATUS[queueCheck.status];
  const status = HEALTH_SEVERITY[queueStatus] > HEALTH_SEVERITY[producerStatus] ? queueStatus : producerStatus;

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
