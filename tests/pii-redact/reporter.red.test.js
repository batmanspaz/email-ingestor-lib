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

  it('every event and heartbeat is PII-free (no private value, no SSN pattern, no filename, no long digit run, no sha256) — R2: satisfiable now (ttl_seconds allow-listed, Opus D8)', () => {
    const t = spyTelemetry();
    const rep = createRedactionReporter({ telemetry: t });
    rep.beginRun();
    // results carry the full report, incl. hashes and a hostile filename: none of it may be forwarded
    rep.fileResult({ ...redacted({ ssn: 3, bank: 2 }), filename: 'Jane Q Tester 123-45-6789.pdf', report: { counts: { ssn: 3, bank: 2, dob: 0, pin: 0, id: 0 }, original_sha256: 'a'.repeat(64), redacted_sha256: 'b'.repeat(64) } });
    rep.fileResult(held('corrupt'));
    rep.endRun();
    expect(privateDigitsIn({ events: t.events, beats: t.beats })).toEqual([]);
    expect(JSON.stringify({ events: t.events, beats: t.beats })).not.toMatch(/Jane|Tester|a{64}|b{64}/);
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

// ---------------------------------------------------------------------------------------------------------------
// ROUND 2 (red-team fold-in, 2026-10-14)
// ---------------------------------------------------------------------------------------------------------------
describe('[Opus D15/M7] mode is part of health: a silent fall-back from enforce is degraded, not ok', () => {
  it('the heartbeat carries the mode', () => {
    const t = spyTelemetry();
    const rep = createRedactionReporter({ telemetry: t, mode: 'shadow' });
    rep.beginRun();
    rep.endRun();
    expect(t.beats[0].mode).toBe('shadow');
  });

  it('after enforceSince, a run in shadow/off is degraded with check mode_regressed', () => {
    for (const mode of ['shadow', 'off']) {
      const t = spyTelemetry();
      const rep = createRedactionReporter({ telemetry: t, mode, enforceSince: '2026-11-01T00:00:00Z', now: () => '2026-11-02T08:00:00Z' });
      rep.beginRun();
      rep.endRun();
      expect(t.beats[0].status, mode).toBe('degraded');
      expect(t.beats[0].checks.map((c) => c.id ?? c.name), mode).toContain('mode_regressed');
    }
  });

  it('before enforceSince, shadow is ok (the planned soak)', () => {
    const t = spyTelemetry();
    const rep = createRedactionReporter({ telemetry: t, mode: 'shadow', enforceSince: '2026-11-01T00:00:00Z', now: () => '2026-10-20T08:00:00Z' });
    rep.beginRun();
    rep.endRun();
    expect(t.beats[0].status).toBe('ok');
  });
});

describe('[Sonnet M7] stale / no-input are distinguishable', () => {
  it('a zero-file run reports files_seen = 0 (no input is not the same as stalled)', () => {
    const t = spyTelemetry();
    const rep = createRedactionReporter({ telemetry: t, mode: 'enforce' });
    rep.beginRun();
    rep.endRun();
    const c = t.beats[0].checks.find((x) => (x.id ?? x.name) === 'files_seen');
    expect(c).toBeTruthy();
    expect(c.value).toBe(0);
  });

  it('endRun is idempotent: calling it twice emits ONE heartbeat', () => {
    const t = spyTelemetry();
    const rep = createRedactionReporter({ telemetry: t, mode: 'enforce' });
    rep.beginRun();
    rep.endRun();
    rep.endRun();
    expect(t.beats).toHaveLength(1);
  });

  it('[Sonnet H8] an attacker-controlled error NAME is not echoed: only built-in Error class names pass the allow-list', () => {
    const t = spyTelemetry();
    const rep = createRedactionReporter({ telemetry: t, mode: 'enforce' });
    rep.beginRun();
    rep.endRun({ error: Object.assign(new Error('x'), { name: 'SSN 123456789 Jane' }) });
    const s = JSON.stringify(t.beats);
    expect(s).not.toMatch(/123456789|Jane/);
    expect(t.beats[0].status).toBe('degraded');
  });
});
