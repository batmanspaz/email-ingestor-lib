// P0 RED — Rule 13 / Telemetry & Health Standard invariants for the redaction stage.
// Health + analytics are Phase-0 invariants: no build ships without them. Expected at end of Phase 0: E_NOT_IMPLEMENTED.
import { describe, it, expect } from 'vitest';
import { createRedactionReporter } from '../../pii-redact.js';
import { privateDigitsIn } from './support/harness.mjs';

function spyTelemetry() {
  const events = [];
  const beats = [];
  return { events, beats, track: (event, props) => events.push({ event, props }), heartbeat: (h) => beats.push(h) };
}
const redacted = (counts = {}) => ({ outcome: 'redacted', report: { counts: { ssn: 0, bank: 0, dob: 0, pin: 0, id: 0, ...counts } } });
const held = (reason) => ({ outcome: 'held', reason, report: { counts: { ssn: 0, bank: 0, dob: 0, pin: 0, id: 0 } } });
const clean = () => ({ outcome: 'clean', report: { counts: { ssn: 0, bank: 0, dob: 0, pin: 0, id: 0 } } });

describe('heartbeat (module pii-redaction)', () => {
  it('emits a heartbeat on EVERY run, even with zero files (missing = healthy is banned)', () => {
    const t = spyTelemetry();
    const rep = createRedactionReporter({ telemetry: t });
    rep.beginRun();
    rep.endRun();
    expect(t.beats).toHaveLength(1);
    expect(t.beats[0]).toMatchObject({ module: 'pii-redaction', status: 'ok' });
    expect(t.beats[0].ttl_seconds).toBeGreaterThan(0);
  });

  it('endRun is safe to call after an error and reports degraded with the error name only', () => {
    const t = spyTelemetry();
    const rep = createRedactionReporter({ telemetry: t });
    rep.beginRun();
    rep.endRun({ error: Object.assign(new Error('boom 123-45-6789'), { name: 'RangeError' }) });
    expect(t.beats[0].status).toBe('degraded');
    expect(JSON.stringify(t.beats)).not.toContain('123-45-6789');
    expect(JSON.stringify(t.beats)).toContain('RangeError');
  });

  it('a verification failure or held file makes the run degraded (never silently ok)', () => {
    const t = spyTelemetry();
    const rep = createRedactionReporter({ telemetry: t });
    rep.beginRun();
    rep.fileResult(held('verify_failed'));
    rep.endRun();
    expect(t.beats[0].status).toBe('degraded');
    expect(t.beats[0].checks.some((c) => /held|verify/i.test(c.id ?? c.name ?? ''))).toBe(true);
  });

  it('ttl is longer than the producer cadence (12h runs) so one missed run alerts only after two', () => {
    const t = spyTelemetry();
    const rep = createRedactionReporter({ telemetry: t });
    rep.beginRun();
    rep.endRun();
    expect(t.beats[0].ttl_seconds).toBeGreaterThan(12 * 3600);
    expect(t.beats[0].ttl_seconds).toBeLessThan(40 * 3600);
  });
});

describe('analytics events', () => {
  it('pii.redaction.applied is emitted once per run with summed counts {files, ssn, bank, dob, pin, id}', () => {
    const t = spyTelemetry();
    const rep = createRedactionReporter({ telemetry: t });
    rep.beginRun();
    rep.fileResult(redacted({ ssn: 3, bank: 2, dob: 1, pin: 1, id: 1 }));
    rep.fileResult(redacted({ ssn: 2 }));
    rep.fileResult(clean());
    rep.endRun();
    const e = t.events.filter((x) => x.event === 'pii.redaction.applied');
    expect(e).toHaveLength(1);
    expect(e[0].props).toEqual({ files: 2, ssn: 5, bank: 2, dob: 1, pin: 1, id: 1 });
  });

  it('pii.redaction.held is emitted per held file with a reason from the closed set', () => {
    const t = spyTelemetry();
    const rep = createRedactionReporter({ telemetry: t });
    rep.beginRun();
    rep.fileResult(held('encrypted'));
    rep.fileResult(held('ocr_unavailable'));
    rep.endRun();
    const e = t.events.filter((x) => x.event === 'pii.redaction.held');
    expect(e.map((x) => x.props)).toEqual([{ reason: 'encrypted' }, { reason: 'ocr_unavailable' }]);
  });

  it('pii.redaction.verify_failed is emitted (in addition to held) when a verifier rejects the output', () => {
    const t = spyTelemetry();
    const rep = createRedactionReporter({ telemetry: t });
    rep.beginRun();
    rep.fileResult(held('verify_failed'));
    rep.endRun();
    expect(t.events.map((x) => x.event)).toEqual(expect.arrayContaining(['pii.redaction.held', 'pii.redaction.verify_failed']));
  });

  it('shadow mode emits pii.redaction.shadow_detected {files, ssn, bank, dob, pin, id} and NOT applied', () => {
    const t = spyTelemetry();
    const rep = createRedactionReporter({ telemetry: t });
    rep.beginRun();
    rep.fileResult({ outcome: 'detected', report: { counts: { ssn: 4, bank: 0, dob: 0, pin: 0, id: 0 } } });
    rep.endRun();
    expect(t.events.filter((x) => x.event === 'pii.redaction.applied')).toHaveLength(0);
    expect(t.events.find((x) => x.event === 'pii.redaction.shadow_detected').props).toEqual({ files: 1, ssn: 4, bank: 0, dob: 0, pin: 0, id: 0 });
  });

  it('a run with only clean files emits no applied/held event (just the heartbeat)', () => {
    const t = spyTelemetry();
    const rep = createRedactionReporter({ telemetry: t });
    rep.beginRun();
    rep.fileResult(clean());
    rep.endRun();
    expect(t.events).toEqual([]);
    expect(t.beats).toHaveLength(1);
  });

  it('every event and heartbeat is PII-free (no private value, no SSN pattern, no filename, no long digit run)', () => {
    const t = spyTelemetry();
    const rep = createRedactionReporter({ telemetry: t });
    rep.beginRun();
    rep.fileResult(redacted({ ssn: 3, bank: 2 }));
    rep.fileResult(held('corrupt'));
    rep.endRun();
    expect(privateDigitsIn({ events: t.events, beats: t.beats })).toEqual([]);
  });

  it('canonical event names only', () => {
    const t = spyTelemetry();
    const rep = createRedactionReporter({ telemetry: t });
    rep.beginRun();
    rep.fileResult(redacted({ ssn: 1 }));
    rep.fileResult(held('verify_failed'));
    rep.fileResult({ outcome: 'detected', report: { counts: { ssn: 1, bank: 0, dob: 0, pin: 0, id: 0 } } });
    rep.endRun();
    const allowed = new Set(['pii.redaction.applied', 'pii.redaction.held', 'pii.redaction.verify_failed', 'pii.redaction.shadow_detected']);
    for (const e of t.events) expect(allowed.has(e.event), e.event).toBe(true);
  });
});
