/**
 * producer-health.js — health status derivation + analytics event shape for
 * every entity's Sluice producer, built on the REAL @perfectcity/telemetry
 * client (schema validation + PII scanning already live there — see
 * intake/src/lib/sluice-dispatch-health.js for the equivalent dispatcher-side
 * module this mirrors). TEST-FIRST, red before impl.
 *
 * Phase-0 invariant (dev-rules.md §28): every new producer module must
 * self-report health (ok/degraded/down, heartbeat-driven staleness) and emit
 * canonical PII-free analytics for its key run event. This is a from-scratch
 * shared module per the "rebuild, don't patch" standing preference — not a
 * retrofit onto any single entity's existing producer code.
 */

import { describe, it, expect, vi } from 'vitest';
import { createTelemetry } from '@perfectcity/telemetry';
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
  it('sends a passing health report tagged with the entity as the module name', async () => {
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
    expect(sent.health[0].status).toBe('ok');
    expect(sent.health[0].module).toBe('producer.collagesoup');
    const runCheck = sent.health[0].checks.find((c) => c.id === 'producer_run');
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
    expect(sent.health[0].status).toBe('down');
    expect(sent.health[0].checks.find((c) => c.id === 'producer_run').status).toBe('fail');
  });
});

describe('trackProducerRun', () => {
  it('emits a canonical run event with the entity id and counts, no PII', () => {
    const track = vi.fn();
    trackProducerRun({ track }, { entityId: 'collagesoup', fetched: 4, produced: 3, skipped: 1, errors: 0 });
    expect(track).toHaveBeenCalledWith({
      event: 'producer.run',
      props: { entity_id: 'collagesoup', fetched: 4, produced: 3, skipped: 1, errors: 0 },
    });
  });

  it('never includes raw email addresses, subjects, or message bodies in props', () => {
    const track = vi.fn();
    trackProducerRun({ track }, { entityId: 'personal', fetched: 1, produced: 1, skipped: 0, errors: 0 });
    const [{ props }] = track.mock.calls[0];
    const serialized = JSON.stringify(props);
    expect(serialized).not.toMatch(/@/); // no email addresses
    expect(Object.keys(props).sort()).toEqual(['entity_id', 'errors', 'fetched', 'produced', 'skipped']);
  });
});
