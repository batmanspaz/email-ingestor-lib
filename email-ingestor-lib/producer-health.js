/**
 * producer-health.js — health status derivation + analytics event shape for
 * every entity's Sluice producer, built on the REAL @perfectcity/telemetry
 * client (schema validation + PII scanning already live in that package —
 * this module doesn't reimplement either, it just supplies the producer-
 * specific shape). Mirrors intake's own sluice-dispatch-health.js.
 */

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

/**
 * @param {import('@perfectcity/telemetry').Telemetry} telemetry
 * @param {{fetched:number, produced:number, errors:number}} stats
 */
export async function reportProducerHealth(telemetry, stats) {
  const status = computeProducerStatus(stats);
  await telemetry.reportHealth({
    status,
    checks: [
      {
        id: 'producer_run',
        status: CHECK_STATUS_BY_HEALTH_STATUS[status],
        metric: stats.produced,
        unit: 'count',
      },
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
