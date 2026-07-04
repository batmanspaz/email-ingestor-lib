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

import { describe, it, expect } from 'vitest';
import { createTelemetry, HealthReportSchema, AnalyticsBatchSchema } from '@perfectcity/telemetry';
import { computeProducerStatus, reportProducerHealth, trackProducerRun } from '../producer-health.js';

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
    await reportProducerHealth(telemetry, { fetched: 3, produced: 3, errors: 0 });

    expect(sent.health.length).toBe(1);
    const report = sent.health[0];
    expect(() => HealthReportSchema.parse(report)).not.toThrow();
    expect(report.status).toBe('ok');
    expect(report.module).toBe('producer.collagesoup');
    const runCheck = report.checks.find((c) => c.id === 'producer_run');
    expect(runCheck.status).toBe('pass');
    expect(runCheck.metric).toBe(3);
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
    await reportProducerHealth(telemetry, { fetched: 2, produced: 0, errors: 2 });
    const report = sent.health[0];
    expect(() => HealthReportSchema.parse(report)).not.toThrow();
    expect(report.status).toBe('down');
    expect(report.checks.find((c) => c.id === 'producer_run').status).toBe('fail');
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
