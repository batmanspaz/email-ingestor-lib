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
import { computeProducerStatus, reportProducerHealth, trackProducerRun, computeTruncationCheck, computeHistoryExpiredCheck, computeStallCheck, computeQuarantineCheck } from '../producer-health.js';
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
    await reportProducerHealth(telemetry, { fetched: 3, produced: 3, errors: 0, truncated: 0, historyExpired: 0, maxStalledRuns: 0, quarantined: 0 }, { sluiceDir });

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
    await reportProducerHealth(telemetry, { fetched: 2, produced: 0, errors: 2, truncated: 0, historyExpired: 0, maxStalledRuns: 0, quarantined: 0 }, { sluiceDir });
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
    await reportProducerHealth(telemetry, { fetched: 3, produced: 3, errors: 0, truncated: 0, historyExpired: 0, maxStalledRuns: 0, quarantined: 0 }, { sluiceDir });

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
    await reportProducerHealth(telemetry, { fetched: 1, produced: 1, errors: 0, truncated: 0, historyExpired: 0, maxStalledRuns: 0, quarantined: 0 }, { sluiceDir: null });

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
    expect(event.props).toEqual({ entity_id: 'collagesoup', fetched: 4, produced: 3, skipped: 1, errors: 0, quarantined: 0 });
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
    expect(Object.keys(props).sort()).toEqual(['entity_id', 'errors', 'fetched', 'produced', 'quarantined', 'skipped']);
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

  it('WARNS at exactly 1 — the commonest value, and the one the tests missed', () => {
    // Surviving mutation: `> 0` -> `> 1` stayed green because every test used
    // 0, 2, 3 or 7. Most producers poll a single account, so 1 is the value
    // that matters most and it reported fully green under the mutant.
    expect(computeTruncationCheck(1).status).toBe('warn');
    expect(computeTruncationCheck(1).metric).toBe(1);
  });

  it('never reports green for a nonsense count — NaN, negative, or a string', () => {
    // NaN arrives from Number(process.env.X) or from summing an undefined; a
    // string arrives from any consumer wiring this by hand. Both previously
    // rendered as pass, rebuilding "missing = healthy" one layer up, and NaN
    // was additionally schema-INVALID, which discards the entire report.
    for (const bad of [NaN, -1, '2']) {
      expect(computeTruncationCheck(bad).status, String(bad)).not.toBe('pass');
    }
  });

  it('is accepted by the real strict HealthCheckSchema in EVERY branch', () => {
    for (const n of [undefined, null, 0, 1, 7, NaN, -1, '2']) {
      const r = HealthCheckSchema.safeParse(computeTruncationCheck(n));
      expect(r.success, `${String(n)}: ${JSON.stringify(r.error?.issues)}`).toBe(true);
    }
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
    await reportProducerHealth(telemetry, { fetched: 5, produced: 5, errors: 0, truncated: 0, historyExpired: 0, maxStalledRuns: 0, quarantined: 0 }, { sluiceDir });
    const ids = sent.health[0].checks.map((c) => c.id);
    expect(ids).toContain('history.truncation');
    expect(() => HealthReportSchema.parse(sent.health[0])).not.toThrow();
  });

  it('drags overall status off ok when a window was truncated', async () => {
    const { sent, telemetry } = telemetryFor();
    await reportProducerHealth(telemetry, { fetched: 5, produced: 5, errors: 0, truncated: 2, historyExpired: 0, maxStalledRuns: 0, quarantined: 0 }, { sluiceDir });
    expect(sent.health[0].status).not.toBe('ok');
    expect(() => HealthReportSchema.parse(sent.health[0])).not.toThrow();
  });
});

// ── history.expired / cursor.stalled ────────────────────────────────────────
// Both are silent-loss shapes. A history-expiry reset means mail between the
// old cursor and now was never enumerated and is unrecoverable by polling; a
// cursor that stops advancing while work remains is every wedge this module
// can suffer. Neither was counted before 2026-08-23 — both were a console.warn
// into a log nothing reads, which is how a 3-day CollageSoup outage and 44
// truncation events both went unnoticed.

describe('computeHistoryExpiredCheck', () => {
  it('passes with an asserted zero when no window expired', () => {
    expect(computeHistoryExpiredCheck(0)).toMatchObject({
      id: 'history.expired', status: 'pass', metric: 0,
    });
  });

  it('FAILS — not warns — when history expired: it is known, unrecoverable loss', () => {
    expect(computeHistoryExpiredCheck(1).status).toBe('fail');
  });

  it('never reports green for an unreported or nonsense count', () => {
    for (const bad of [undefined, null, NaN, -1, 'x']) {
      expect(computeHistoryExpiredCheck(bad).status, String(bad)).not.toBe('pass');
    }
  });

  it('is schema-valid in every branch', () => {
    for (const n of [undefined, null, 0, 1, NaN, -1, 'x']) {
      expect(HealthCheckSchema.safeParse(computeHistoryExpiredCheck(n)).success, String(n)).toBe(true);
    }
  });
});

describe('computeStallCheck', () => {
  it('passes while the cursor is moving', () => {
    expect(computeStallCheck(0)).toMatchObject({ id: 'cursor.stalled', status: 'pass', metric: 0 });
  });

  it('tolerates a couple of quiet runs without crying wolf', () => {
    expect(computeStallCheck(1).status).toBe('pass');
  });

  it('FAILS once the cursor has sat still long enough to mean stuck, not quiet', () => {
    expect(computeStallCheck(99).status).toBe('fail');
  });

  it('never reports green for an unreported or nonsense count', () => {
    for (const bad of [undefined, null, NaN, -1, 'x']) {
      expect(computeStallCheck(bad).status, String(bad)).not.toBe('pass');
    }
  });

  it('is schema-valid in every branch', () => {
    for (const n of [undefined, null, 0, 1, 99, NaN, -1, 'x']) {
      expect(HealthCheckSchema.safeParse(computeStallCheck(n)).success, String(n)).toBe(true);
    }
  });
});

describe('reportProducerHealth — every silent-loss shape reaches the report', () => {
  function telemetryFor() {
    const { sent, transport } = fakeTransport();
    return { sent, telemetry: createTelemetry({
      product: 'sluice', module: 'producer.test', version: 'test',
      transport, heartbeatMs: 0, batchIntervalMs: 0, autoStart: false,
    }) };
  }

  it('always carries history.truncation, history.expired and cursor.stalled', async () => {
    const { sent, telemetry } = telemetryFor();
    await reportProducerHealth(telemetry,
      { fetched: 1, produced: 1, errors: 0, truncated: 0, historyExpired: 0, maxStalledRuns: 0 },
      { sluiceDir });
    const ids = sent.health[0].checks.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['history.truncation', 'history.expired', 'cursor.stalled']));
    expect(() => HealthReportSchema.parse(sent.health[0])).not.toThrow();
  });

  it('reports DOWN when history expired — the worst-of must not swallow a fail', async () => {
    const { sent, telemetry } = telemetryFor();
    await reportProducerHealth(telemetry,
      { fetched: 1, produced: 1, errors: 0, truncated: 0, historyExpired: 1, maxStalledRuns: 0 },
      { sluiceDir });
    expect(sent.health[0].status).toBe('down');
    expect(() => HealthReportSchema.parse(sent.health[0])).not.toThrow();
  });
});

describe('computeStallCheck — the threshold itself', () => {
  it('passes one run BELOW the fail threshold and fails AT it', () => {
    // Untested constants are how `> 0` -> `> 1` survived earlier. At 60 instead
    // of 6 the check would fire 30 days in — three weeks after the mail is
    // unrecoverable — while every existing test stayed green.
    expect(computeStallCheck(5).status).toBe('pass');
    expect(computeStallCheck(6).status).toBe('fail');
  });
});

describe('computeQuarantineCheck', () => {
  it('passes with an asserted zero when nothing was dropped', () => {
    expect(computeQuarantineCheck(0)).toMatchObject({
      id: 'message.quarantined', status: 'pass', metric: 0,
    });
  });

  it('FAILS when a message was quarantined — it is deliberate, permanent loss', () => {
    // Quarantine intentionally DROPS mail to unwedge the cursor. Counting it
    // and console.error-ing it is the exact posture this module condemns
    // elsewhere; it must reach the health report like history.expired does.
    expect(computeQuarantineCheck(1).status).toBe('fail');
  });

  it('never reports green for an unreported or nonsense count', () => {
    for (const bad of [undefined, null, NaN, -1, 'x']) {
      expect(computeQuarantineCheck(bad).status, String(bad)).not.toBe('pass');
    }
  });

  it('is schema-valid in every branch', () => {
    for (const n of [undefined, null, 0, 1, NaN, -1, 'x']) {
      expect(HealthCheckSchema.safeParse(computeQuarantineCheck(n)).success, String(n)).toBe(true);
    }
  });

  it('reaches the health report and drags the overall status down', async () => {
    const { sent, transport } = fakeTransport();
    const telemetry = createTelemetry({
      product: 'sluice', module: 'producer.test', version: 'test',
      transport, heartbeatMs: 0, batchIntervalMs: 0, autoStart: false,
    });
    await reportProducerHealth(telemetry,
      { fetched: 1, produced: 1, errors: 0, truncated: 0, historyExpired: 0, maxStalledRuns: 0, quarantined: 1 },
      { sluiceDir });
    expect(sent.health[0].checks.map((c) => c.id)).toContain('message.quarantined');
    expect(sent.health[0].status).toBe('down');
    expect(() => HealthReportSchema.parse(sent.health[0])).not.toThrow();
  });
});
