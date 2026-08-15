/**
 * queue-depth.js — the queue.depth health check, born from the 2026-08-02
 * consumer outage: producers archived mail out of Gmail into
 * <SLUICE_DIR>/inbox for ten days while nothing consumed it, and the
 * harness-bound health report stayed green because only producer_run was
 * checked. HOUSE RULE: an unconfigured or stalled dependency must degrade a
 * health check, never report green — so a missing/unconfigured inbox is a
 * fail, not a skip.
 *
 * Thresholds:
 *   pass — depth <= DEPTH_WARN_THRESHOLD and oldest envelope < AGE_WARN_MS
 *   warn — depth >  DEPTH_WARN_THRESHOLD or  oldest > AGE_WARN_MS
 *   fail — oldest > AGE_FAIL_MS, or inbox missing/unreadable/unconfigured
 *
 * DEPTH_WARN_THRESHOLD = 200: observed volume is ~130–155 envelopes/day,
 * arriving in two producer waves (08:00 and 18:00, ~65–78 each). With the
 * consumer scheduled 30 minutes after each wave, a healthy queue peaks well
 * under 100; 200 is more than a full day's volume and is only reachable if at
 * least one consume cycle was missed outright. The age thresholds (6h warn /
 * 24h fail) are the primary signal — on the twice-daily cadence a >6h-old
 * envelope means the last consume run didn't happen, and >24h means a full
 * day of missed runs.
 */

import fs from 'node:fs';
import path from 'node:path';

export const DEPTH_WARN_THRESHOLD = 200;
export const AGE_WARN_MS = 6 * 60 * 60 * 1000;
export const AGE_FAIL_MS = 24 * 60 * 60 * 1000;

/**
 * @param {object} opts — { inboxDir, now, depthThreshold, warnAgeMs, failAgeMs }
 *   inboxDir — the envelope inbox itself (<SLUICE_DIR>/inbox)
 * Returned shape obeys the strict HealthCheckSchema ({id, status, detail?,
 * metric?, unit?}) — the oldest-envelope age travels in `detail`, and metric
 * is OMITTED (not null) when the inbox is unreadable.
 * @returns {{id:'queue.depth', status:'pass'|'warn'|'fail', metric?:number, unit:'count', detail:string}}
 */
export function computeQueueDepthCheck(opts = {}) {
  const {
    inboxDir,
    now = new Date(),
    depthThreshold = DEPTH_WARN_THRESHOLD,
    warnAgeMs = AGE_WARN_MS,
    failAgeMs = AGE_FAIL_MS,
  } = opts;

  if (!inboxDir) {
    return { id: 'queue.depth', status: 'fail', unit: 'count', detail: 'inbox dir not configured' };
  }

  let entries;
  try {
    entries = fs.readdirSync(inboxDir).filter((f) => f !== '.tmp');
  } catch {
    return { id: 'queue.depth', status: 'fail', unit: 'count', detail: 'inbox dir missing or unreadable' };
  }

  let oldestAgeMs = null;
  for (const name of entries) {
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(path.join(inboxDir, name)).mtimeMs;
    } catch {
      continue; // consumed out from under us mid-scan — not this check's concern
    }
    const ageMs = now.getTime() - mtimeMs;
    if (oldestAgeMs === null || ageMs > oldestAgeMs) oldestAgeMs = ageMs;
  }

  let status = 'pass';
  if (oldestAgeMs !== null && oldestAgeMs > failAgeMs) status = 'fail';
  else if (entries.length > depthThreshold || (oldestAgeMs !== null && oldestAgeMs > warnAgeMs)) status = 'warn';

  const oldestHours = oldestAgeMs === null ? null : oldestAgeMs / (60 * 60 * 1000);
  return {
    id: 'queue.depth',
    status,
    metric: entries.length,
    unit: 'count',
    detail: oldestHours === null ? 'empty' : `oldest_envelope_age_hours=${oldestHours.toFixed(1)}`,
  };
}
