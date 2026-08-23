/**
 * producer-health.js — health status derivation + analytics event shape for
 * every entity's Sluice producer, built on the REAL @perfectcity/telemetry
 * client (schema validation + PII scanning already live there — see
 * intake/src/lib/sluice-dispatch-health.js for the equivalent dispatcher-side
 * module this mirrors). TEST-FIRST, red before impl.
 *
 * Every sent body is validated against the package's own exported Zod schemas
 * (HealthReportSchema / AnalyticsBatchSchema) rather than a hand-guessed shape.
 * intake's own sluice-dispatch-health.test.js originally hand-guessed the
 * analytics wire shape as `{ events: [...] }` and got it wrong (the real wire
 * body is a BARE array of events) — validating against the real schema here
 * makes that class of drift impossible to miss.
 *
 * Phase-0 invariant (dev-rules.md Sec28): every new producer module must
 * self-report health (ok/degraded/down, heartbeat-driven staleness) and emit
 * canonical PII-free analytics for its key run event. This is a from-scratch
 * shared module per the "rebuild, don't patch" standing preference — not a
 * retrofit onto any single entity's existing producer code.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTelemetry, HealthReportSchema, AnalyticsBatchSchema } from '@perfectcity/telemetry';
import { computeProducerStatus, reportProducerHealth, trackProducerRun, computeTruncationCheck } from '../producer-health.js';
import { HealthCheckSchema } from '@perfectcity/telemetry';

// Healthy on-disk sluice fixture (empty inbox) so reportProducerHealth's
// queue.depth check is deterministic — never dependent on the shell's
// SLUICE_DIR or the machine's real queue state.
let sluiceDir;
beforeEach(() => {
  sluiceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'producer-health-sluice-'));
  fs.mkdirSync(path.join(sluiceDir, 'inbox'));
});
afterEach(() => {
  fs.rmSync(sluiceDir, { recursive: true, force: true });
});

function fakeTransport() {
  const sent = { health: [], analytics: [] };
  return {
    sent,
    transport: {
      async send(path, body) {
        if (path.includes('health')) sent.health.push(body);
        else sent.analytics.push(body);
      },
    },
  };
}

describe('computeProducerStatus', () => {
  it('is ok when nothing errored', () => {
    expect(computeProducerStatus({ fetched: 5, produced: 5, errors: 0 })).toBe('ok');
  });
  it('is ok when there was simply nothing new to fetch', () => {
    expect(computeProducerStatus({ fetched: 0, produced: 0, errors: 0 })).toBe('ok');
  });
  it('is degraded when some but not all fetched items errored', () => {
    expect(computeProducerStatus({ fetched: 4, produced: 2, errors: 2 })).toBe('degraded');
  });
  it('is down when every fetched item errored', () => {
    expect(computeProducerStatus({ fetched: 3, produced: 0, errors: 3 })).toBe('down');
  });
});

describe('reportProducerHealth', () => {
  it('sends a passing health report tagged with the entity as the module name, valid against the real schema', async () => {
    const { sent, transport } = fakeTransport();
    const telemetry = createTelemetry({
      product: 'sluice',
      module: 'producer.collagesoup',
      version: 'test',
      transport,
      heartbeatMs: 0,
      batchIntervalMs: 0,
      autoStart: false,
    });
    // truncated: 0 is REQUIRED for an 'ok' report as of 2026-08-23 — a caller that
    // cannot attest zero truncation gets 'warn', because "missing = healthy" is
    // banned (dev-rules Sec28.1) and an absent counter is not evidence of absence.
    await reportProducerHealth(telemetry, { fetched: 3, produced: 3, errors: 0, truncated: 0 }, { sluiceDir });

    expect(sent.health.length).toBe(1);
    const report = sent.health[0];
    expect(() => HealthReportSchema.parse(report)).not.toThrow();
    expect(report.status).toBe('ok');
    expect(report.module).toBe('producer.collagesoup');
    const runCheck = report.checks.find((c) => c.id === 'producer_run');
    expect(runCheck.status).toBe('pass');
    expect(runCheck.metric).toBe(3);
    // 2026-08-02 outage lesson: the report must ALWAYS carry queue.depth,
    // not just producer_run.
    const queueCheck = report.checks.find((c) => c.id === 'queue.depth');
    expect(queueCheck.status).toBe('pass');
    expect(queueCheck.metric).toBe(0);
  });

  it('sends a failing health report when every item errored', async () => {
    const { sent, transport } = fakeTransport();
    const telemetry = createTelemetry({
      product: 'sluice',
      module: 'producer.perfectcity',
      version: 'test',
      transport,
      heartbeatMs: 0,
      batchIntervalMs: 0,
      autoStart: false,
    });
    await reportProducerHealth(telemetry, { fetched: 2, produced: 0, errors: 2 }, { sluiceDir });
    const report = sent.health[0];
    expect(() => HealthReportSchema.parse(report)).not.toThrow();
    expect(report.status).toBe('down');
    expect(report.checks.find((c) => c.id === 'producer_run').status).toBe('fail');
  });

  it('degrades the OVERALL status when the producer ran fine but the queue is stalled (the 2026-08-02 outage shape)', async () => {
    // Reconstruct the outage: producer runs green, but the oldest queued
    // envelope is >24h old because nothing consumes. The old report said
    // status:"ok" here for ten days straight.
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const staleEnv = path.join(sluiceDir, 'inbox', 'stale-envelope');
    fs.mkdirSync(staleEnv);
    fs.utimesSync(staleEnv, stale, stale);

    const { sent, transport } = fakeTransport();
    const telemetry = createTelemetry({
      product: 'sluice',
      module: 'producer.perfectcity',
      version: 'test',
      transport,
      heartbeatMs: 0,
      batchIntervalMs: 0,
      autoStart: false,
    });
    // truncated: 0 is REQUIRED for an 'ok' report as of 2026-08-23 — a caller that
    // cannot attest zero truncation gets 'warn', because "missing = healthy" is
    // banned (dev-rules Sec28.1) and an absent counter is not evidence of absence.
    await reportProducerHealth(telemetry, { fetched: 3, produced: 3, errors: 0, truncated: 0 }, { sluiceDir });

    const report = sent.health[0];
    expect(() => HealthReportSchema.parse(report)).not.toThrow();
    expect(report.checks.find((c) => c.id === 'producer_run').status).toBe('pass');
    expect(report.checks.find((c) => c.id === 'queue.depth').status).toBe('fail');
    expect(report.status).toBe('down');
  });

  it('reports queue.depth as fail — never green — when the sluice dir is unconfigured', async () => {
    // HOUSE RULE: an unconfigured dependency must degrade a health check.
    const { sent, transport } = fakeTransport();
    const telemetry = createTelemetry({
      product: 'sluice',
      module: 'producer.collagesoup',
      version: 'test',
      transport,
      heartbeatMs: 0,
      batchIntervalMs: 0,
      autoStart: false,
    });
    await reportProducerHealth(telemetry, { fetched: 1, produced: 1, errors: 0 }, { sluiceDir: null });

    const report = sent.health[0];
    expect(() => HealthReportSchema.parse(report)).not.toThrow();
    expect(report.checks.find((c) => c.id === 'queue.depth').status).toBe('fail');
    expect(report.status).toBe('down');
  });
});

describe('trackProducerRun', () => {
  it('emits exactly one producer.run event with the entity id and counts, valid against the real schema', async () => {
    const { sent, transport } = fakeTransport();
    const telemetry = createTelemetry({
      product: 'sluice',
      module: 'producer.collagesoup',
      version: 'test',
      transport,
      heartbeatMs: 0,
      batchIntervalMs: 0,
      autoStart: false,
      batchSize: 1,
    });
    trackProducerRun(telemetry, { entityId: 'collagesoup', fetched: 4, produced: 3, skipped: 1, errors: 0 });
    await telemetry.flush();

    expect(sent.analytics.length).toBe(1);
    // The wire body IS the batch array — no { events: [...] } wrapper.
    const batch = sent.analytics[0];
    expect(() => AnalyticsBatchSchema.parse(batch)).not.toThrow();
    expect(batch.length).toBe(1);
    const event = batch[0];
    expect(event.event).toBe('producer.run');
    expect(event.props).toEqual({ entity_id: 'collagesoup', fetched: 4, produced: 3, skipped: 1, errors: 0 });
  });

  it('never includes raw email addresses, subjects, or message bodies in props', async () => {
    const { sent, transport } = fakeTransport();
    const telemetry = createTelemetry({
      product: 'sluice',
      module: 'producer.personal',
      version: 'test',
      transport,
      heartbeatMs: 0,
      batchIntervalMs: 0,
      autoStart: false,
      batchSize: 1,
    });
    trackProducerRun(telemetry, { entityId: 'personal', fetched: 1, produced: 1, skipped: 0, errors: 0 });
    await telemetry.flush();

    const props = sent.analytics[0][0].props;
    const serialized = JSON.stringify(props);
    expect(serialized).not.toMatch(/@/); // no email addresses
    expect(Object.keys(props).sort()).toEqual(['entity_id', 'errors', 'fetched', 'produced', 'skipped']);
  });
});

// ── history.truncation — reported even at zero (dev-rules Sec28.1) ──────────
// Until 2026-08-23 a truncated history window was a console.warn into a file
// nothing reads. It fired 44 times on personal while messages fell behind the
// cursor, and surfaced only via an unrelated audit. "missing = healthy" is
// banned: absence of truncation must be an asserted zero, not silence.

describe('computeTruncationCheck', () => {
  it('passes with metric 0 when no window was truncated — an ASSERTED zero, not silence', () => {
    expect(computeTruncationCheck(0)).toMatchObject({
      id: 'history.truncation', status: 'pass', metric: 0, unit: 'count',
    });
  });

  it('WARNS when any window was truncated — the producer is behind, not broken', () => {
    const c = computeTruncationCheck(3);
    expect(c.status).toBe('warn');
    expect(c.metric).toBe(3);
  });

  it('is accepted by the real strict HealthCheckSchema in both states', () => {
    // HealthCheckSchema is .strict(): an extra top-level key does not drop this
    // check, it makes telemetry.js discard the ENTIRE health report silently.
    for (const n of [0, 7]) {
      const r = HealthCheckSchema.safeParse(computeTruncationCheck(n));
      expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
    }
  });

  it('treats a missing count as unknown-and-not-green rather than zero', () => {
    // An absent counter must never render as a clean pass — that is exactly the
    // "missing = healthy" the rule bans.
    expect(computeTruncationCheck(undefined).status).not.toBe('pass');
  });
});

describe('reportProducerHealth — truncation is always in the report', () => {
  function telemetryFor() {
    const { sent, transport } = fakeTransport();
    return {
      sent,
      telemetry: createTelemetry({
        product: 'sluice', module: 'producer.test', version: 'test',
        transport, heartbeatMs: 0, batchIntervalMs: 0, autoStart: false,
      }),
    };
  }

  it('includes history.truncation even when nothing was truncated', async () => {
    const { sent, telemetry } = telemetryFor();
    await reportProducerHealth(telemetry, { fetched: 5, produced: 5, errors: 0, truncated: 0 }, { sluiceDir });
    const ids = sent.health[0].checks.map((c) => c.id);
    expect(ids).toContain('history.truncation');
    expect(() => HealthReportSchema.parse(sent.health[0])).not.toThrow();
  });

  it('drags overall status off ok when a window was truncated', async () => {
    const { sent, telemetry } = telemetryFor();
    await reportProducerHealth(telemetry, { fetched: 5, produced: 5, errors: 0, truncated: 2 }, { sluiceDir });
    expect(sent.health[0].status).not.toBe('ok');
    expect(() => HealthReportSchema.parse(sent.health[0])).not.toThrow();
  });
});
