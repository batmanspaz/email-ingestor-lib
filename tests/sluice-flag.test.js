/**
 * sluice-flag.js — shared intake-gate resolver for every entity's producer.
 * TEST-FIRST, red before impl.
 *
 * Finding (2026-07-04, Sluice entity-cutover plan, Phase 1): SLUICE_INTAKE is
 * currently read as a bare boolean (`process.env.SLUICE_INTAKE === '1'`)
 * independently in each entity's own index.js. Since master.env is shared
 * across every entity's ingestor process, the instant a second entity's
 * producer exists and checks that same bare boolean, setting SLUICE_INTAKE=1
 * to cut personal over would ALSO switch on any other entity's producer that
 * happens to already be merged — with no way to stage a controlled,
 * single-entity rollout. This mirrors the comma-list convention SLUICE_OWN_POLL
 * already uses (see intake/src/lib/own-poll.js's shouldSkipOwnPoll).
 *
 * 2026-08-23 (M1, dual-read): SLUICE_INTAKE is the last surviving SLUICE_* key
 * in master.env; the other three were removed 2026-08-23. This adds the
 * INTAKE_ENTITIES dual-read + deprecation warning that unblocks removing it,
 * mirroring the producers' own resolveDropDir (INTAKE_DIR || SLUICE_DIR) shim.
 *
 * 2026-08-23 (M4, silent-failure signal): the gate previously returned a bare
 * `false` with no log, no reason and no health signal. Because each consumer
 * does `const runner = SLUICE_INTAKE ? sluiceMain : main`, an unset flag does
 * NOT stop the process — it silently reverts all three entities to the LEGACY
 * drop/forward/classify path, which emits normal-looking activity while the
 * intake pipeline receives nothing. Absence of a heartbeat would at least have
 * been detectable; this was not. resolveSluiceGate() makes the decision and
 * its reason explicit, and computeSluiceGateCheck() turns it into a telemetry
 * check that is never green-by-absence (dev-rules.md Sec28: "missing = healthy"
 * is BANNED).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { HealthCheckSchema } from '@perfectcity/telemetry';
import {
  shouldRunSluiceProducer,
  resolveSluiceGate,
  computeSluiceGateCheck,
} from '../sluice-flag.js';

/**
 * Every gate state, so status/metric can be asserted for ALL of them rather
 * than only flag_unset — a mutation that reported not_listed as pass/1 survived
 * the first cut of this suite (2026-08-23 audit).
 */
const GATE_STATES = [
  ['enabled',      'personal', { INTAKE_ENTITIES: 'personal' }],
  ['not_listed',   'perfectcity', { INTAKE_ENTITIES: 'personal' }],
  ['flag_unset',   'personal', {}],
  ['no_entity_id', undefined, { INTAKE_ENTITIES: 'personal' }],
  ['deprecated',   'personal', { SLUICE_INTAKE: 'personal' }],
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function spyWarn() {
  return vi.spyOn(console, 'warn').mockImplementation(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// Existing behaviour — must survive the dual-read unchanged.
// ─────────────────────────────────────────────────────────────────────────────
describe('shouldRunSluiceProducer — legacy SLUICE_INTAKE behaviour (unchanged)', () => {
  it('is off by default (unset)', () => {
    spyWarn();
    expect(shouldRunSluiceProducer('personal', {})).toBe(false);
  });

  it('is off for "0"', () => {
    spyWarn();
    expect(shouldRunSluiceProducer('personal', { SLUICE_INTAKE: '0' })).toBe(false);
  });

  it('back-compat: SLUICE_INTAKE=1 means "personal only" (today\'s live behavior)', () => {
    spyWarn();
    expect(shouldRunSluiceProducer('personal', { SLUICE_INTAKE: '1' })).toBe(true);
    expect(shouldRunSluiceProducer('collagesoup', { SLUICE_INTAKE: '1' })).toBe(false);
    expect(shouldRunSluiceProducer('perfectcity', { SLUICE_INTAKE: '1' })).toBe(false);
  });

  it('a comma-list enables exactly the listed entities', () => {
    spyWarn();
    const env = { SLUICE_INTAKE: 'personal,collagesoup' };
    expect(shouldRunSluiceProducer('personal', env)).toBe(true);
    expect(shouldRunSluiceProducer('collagesoup', env)).toBe(true);
    expect(shouldRunSluiceProducer('perfectcity', env)).toBe(false);
  });

  it('trims whitespace around comma-list entries', () => {
    spyWarn();
    const env = { SLUICE_INTAKE: 'personal, collagesoup ,  perfectcity' };
    expect(shouldRunSluiceProducer('perfectcity', env)).toBe(true);
  });

  it('returns false when entityId is missing', () => {
    spyWarn();
    expect(shouldRunSluiceProducer(undefined, { SLUICE_INTAKE: '1' })).toBe(false);
  });

  it('defaults to process.env when no env arg is given', () => {
    spyWarn();
    // vi.stubEnv, not raw process.env mutation: vitest runs test FILES
    // concurrently in a worker pool and raw writes leaked across them,
    // making the suite ~20% flaky (2026-08-23 ops audit).
    vi.stubEnv('INTAKE_ENTITIES', undefined); // else the new var wins post-migration
    vi.stubEnv('SLUICE_INTAKE', 'personal');
    expect(shouldRunSluiceProducer('personal')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// M1 — INTAKE_ENTITIES dual-read
// ─────────────────────────────────────────────────────────────────────────────
describe('shouldRunSluiceProducer — INTAKE_ENTITIES (new var)', () => {
  it('INTAKE_ENTITIES=1 means "personal only", same back-compat rule as the old var', () => {
    const env = { INTAKE_ENTITIES: '1' };
    expect(shouldRunSluiceProducer('personal', env)).toBe(true);
    expect(shouldRunSluiceProducer('collagesoup', env)).toBe(false);
    expect(shouldRunSluiceProducer('perfectcity', env)).toBe(false);
  });

  it('INTAKE_ENTITIES comma-list enables exactly the listed entities', () => {
    const env = { INTAKE_ENTITIES: 'personal,collagesoup' };
    expect(shouldRunSluiceProducer('personal', env)).toBe(true);
    expect(shouldRunSluiceProducer('collagesoup', env)).toBe(true);
    expect(shouldRunSluiceProducer('perfectcity', env)).toBe(false);
  });

  it('INTAKE_ENTITIES trims whitespace around entries', () => {
    const env = { INTAKE_ENTITIES: 'personal, collagesoup ,  perfectcity' };
    expect(shouldRunSluiceProducer('perfectcity', env)).toBe(true);
  });

  it('returns false when entityId is missing, even with the new var set', () => {
    expect(shouldRunSluiceProducer(undefined, { INTAKE_ENTITIES: '1' })).toBe(false);
  });

  it('defaults to process.env when no env arg is given (new var)', () => {
    vi.stubEnv('SLUICE_INTAKE', undefined);
    vi.stubEnv('INTAKE_ENTITIES', 'perfectcity');
    expect(shouldRunSluiceProducer('perfectcity')).toBe(true);
  });
});

describe('shouldRunSluiceProducer — precedence and deprecation', () => {
  it('the new var WINS outright when both are set and they conflict', () => {
    const env = { INTAKE_ENTITIES: 'collagesoup', SLUICE_INTAKE: 'personal' };
    expect(shouldRunSluiceProducer('collagesoup', env)).toBe(true);
    expect(shouldRunSluiceProducer('personal', env)).toBe(false);
  });

  it('does NOT warn about deprecation when only the new var is set', () => {
    const warn = spyWarn();
    shouldRunSluiceProducer('personal', { INTAKE_ENTITIES: '1' });
    const deprecationWarnings = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('SLUICE_INTAKE') && m.includes('deprecated'));
    expect(deprecationWarnings).toHaveLength(0);
  });

  it('does NOT warn about deprecation when both are set (new var is the one used)', () => {
    const warn = spyWarn();
    shouldRunSluiceProducer('personal', { INTAKE_ENTITIES: '1', SLUICE_INTAKE: '1' });
    const deprecationWarnings = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('deprecated'));
    expect(deprecationWarnings).toHaveLength(0);
  });

  it('WARNS naming both vars when the deprecated var is the one being used', () => {
    const warn = spyWarn();
    expect(shouldRunSluiceProducer('personal', { SLUICE_INTAKE: '1' })).toBe(true);
    const msg = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(msg).toContain('SLUICE_INTAKE');
    expect(msg).toContain('deprecated');
    expect(msg).toContain('INTAKE_ENTITIES');
  });

  it('does NOT emit a deprecation warning when NEITHER var is set (absence is not deprecation)', () => {
    const warn = spyWarn();
    shouldRunSluiceProducer('personal', {});
    const deprecationWarnings = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('deprecated'));
    expect(deprecationWarnings).toHaveLength(0);
  });

  it('D3: an EMPTY new var falls back to the deprecated var (matches resolveDropDir)', () => {
    const warn = spyWarn();
    const env = { INTAKE_ENTITIES: '', SLUICE_INTAKE: '1' };
    expect(shouldRunSluiceProducer('personal', env)).toBe(true);
    const msg = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(msg).toContain('deprecated');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// M4 — the decision must stop being silent
// ─────────────────────────────────────────────────────────────────────────────
describe('resolveSluiceGate — the decision is explicit and carries its reason', () => {
  it('reports enabled + which var supplied the answer (new var)', () => {
    expect(resolveSluiceGate('personal', { INTAKE_ENTITIES: '1' })).toEqual({
      run: true,
      reason: 'enabled',
      source: 'INTAKE_ENTITIES',
      deprecated: false,
      entityId: 'personal',
    });
  });

  it('reports enabled via the deprecated var, flagged as deprecated', () => {
    spyWarn();
    expect(resolveSluiceGate('personal', { SLUICE_INTAKE: '1' })).toEqual({
      run: true,
      reason: 'enabled',
      source: 'SLUICE_INTAKE',
      deprecated: true,
      entityId: 'personal',
    });
  });

  it('distinguishes "flag_unset" from "not_listed" — the two silent failures', () => {
    expect(resolveSluiceGate('personal', {})).toMatchObject({
      run: false,
      reason: 'flag_unset',
      source: null,
    });
    expect(resolveSluiceGate('personal', { INTAKE_ENTITIES: 'collagesoup' })).toMatchObject({
      run: false,
      reason: 'not_listed',
      source: 'INTAKE_ENTITIES',
    });
  });

  it('reports "no_entity_id" distinctly from a disabled flag', () => {
    expect(resolveSluiceGate(undefined, { INTAKE_ENTITIES: '1' })).toMatchObject({
      run: false,
      reason: 'no_entity_id',
    });
  });

  it('is PURE — resolving never logs, so callers control the noise', () => {
    const warn = spyWarn();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    resolveSluiceGate('personal', {});
    resolveSluiceGate('personal', { SLUICE_INTAKE: '1' });
    resolveSluiceGate('personal', { INTAKE_ENTITIES: 'collagesoup' });
    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});

describe('shouldRunSluiceProducer — announces WHY it disabled a producer', () => {
  it('warns, naming the entity and the reason, when the flag is unset', () => {
    const warn = spyWarn();
    shouldRunSluiceProducer('personal', {});
    const msg = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(msg).toContain('personal');
    expect(msg).toContain('INTAKE_ENTITIES');
    // must say the legacy path is what runs instead — the actual consequence
    expect(msg.toLowerCase()).toContain('legacy');
  });

  it('warns when the entity is simply not in the list', () => {
    const warn = spyWarn();
    shouldRunSluiceProducer('perfectcity', { INTAKE_ENTITIES: 'personal' });
    const msg = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(msg).toContain('perfectcity');
    expect(msg.toLowerCase()).toContain('legacy');
  });

  it('stays QUIET on the happy path — an enabled producer logs no warning', () => {
    const warn = spyWarn();
    shouldRunSluiceProducer('personal', { INTAKE_ENTITIES: 'personal' });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('computeSluiceGateCheck — never green by absence (dev-rules Sec28)', () => {
  it('is ACCEPTED by the real strict HealthCheckSchema in every gate state', () => {
    // The house pattern (see tests/producer-health.test.js): validate against
    // the package's own exported schema, never a hand-guessed shape. The first
    // cut of this file guessed, and emitted reason/entity_id as top-level keys
    // — HealthCheckSchema is .strict(), so telemetry.js would have dropped the
    // ENTIRE health report (producer_run and queue.depth with it), silently.
    for (const [label, entity, env] of GATE_STATES) {
      const check = computeSluiceGateCheck(resolveSluiceGate(entity, env));
      const parsed = HealthCheckSchema.safeParse(check);
      expect(parsed.success, `${label}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });

  it('passes with metric 1 when the producer is enabled', () => {
    const check = computeSluiceGateCheck(resolveSluiceGate('personal', { INTAKE_ENTITIES: '1' }));
    expect(check).toMatchObject({ id: 'intake.gate', status: 'pass', metric: 1, unit: 'count' });
  });

  it('WARNS with metric 0 for EVERY disabled reason, not just flag_unset', () => {
    // Guards the surviving mutation found 2026-08-23: keying status off
    // flag_unset alone let not_listed — the likeliest real disabled state —
    // report pass/1 while the producer sat on the legacy path.
    for (const [label, entity, env] of GATE_STATES.filter(([l]) => l !== 'enabled' && l !== 'deprecated')) {
      const check = computeSluiceGateCheck(resolveSluiceGate(entity, env));
      expect(check.status, label).toBe('warn');
      expect(check.metric, label).toBe(0);
    }
  });

  it('carries the reason in detail so a dashboard can tell unset from not-listed', () => {
    expect(computeSluiceGateCheck(resolveSluiceGate('personal', {})).detail).toContain('flag_unset');
    expect(
      computeSluiceGateCheck(resolveSluiceGate('personal', { INTAKE_ENTITIES: 'x' })).detail,
    ).toContain('not_listed');
  });

  it('detail names WHICH var answered, so telemetry can find stragglers on the old key', () => {
    // This work exists to unblock deleting SLUICE_INTAKE from master.env. A
    // check that cannot answer "is anyone still reading the deprecated key?"
    // leaves that removal blind.
    expect(computeSluiceGateCheck(resolveSluiceGate('personal', { SLUICE_INTAKE: '1' })).detail)
      .toContain('source=SLUICE_INTAKE');
    expect(computeSluiceGateCheck(resolveSluiceGate('personal', { INTAKE_ENTITIES: '1' })).detail)
      .toContain('source=INTAKE_ENTITIES');
    expect(computeSluiceGateCheck(resolveSluiceGate('personal', {})).detail)
      .toContain('source=none');
  });

  it('emits no PII — only the schema-legal keys, entity id inside detail', () => {
    const check = computeSluiceGateCheck(resolveSluiceGate('personal', { INTAKE_ENTITIES: '1' }));
    expect(Object.keys(check).sort()).toEqual(['detail', 'id', 'metric', 'status', 'unit']);
    expect(check.detail).toContain('personal');
  });

  it('never emits a null entity id — the no_entity_id path stays schema-legal', () => {
    const check = computeSluiceGateCheck(resolveSluiceGate(undefined, { INTAKE_ENTITIES: '1' }));
    expect(HealthCheckSchema.safeParse(check).success).toBe(true);
    expect(check.detail).toContain('none');
  });
});

describe('operator foot-guns — pinned deliberately', () => {
  it('INTAKE_ENTITIES=0 IS a working force-disable kill switch during migration', () => {
    spyWarn();
    expect(shouldRunSluiceProducer('personal', { INTAKE_ENTITIES: '0', SLUICE_INTAKE: '1' })).toBe(false);
  });

  it('a whitespace-only new var is truthy, so it WINS and disables everything', () => {
    spyWarn();
    expect(shouldRunSluiceProducer('personal', { INTAKE_ENTITIES: ' ', SLUICE_INTAKE: '1' })).toBe(false);
  });

  it('entity matching is case-sensitive — PERSONAL does not enable personal', () => {
    spyWarn();
    expect(shouldRunSluiceProducer('personal', { INTAKE_ENTITIES: 'PERSONAL' })).toBe(false);
  });
});

describe('robustness — the gate must never throw where the old code returned false', () => {
  it('survives a Symbol entityId instead of throwing on string coercion', () => {
    spyWarn();
    expect(() => shouldRunSluiceProducer(Symbol('personal'), { INTAKE_ENTITIES: '1' })).not.toThrow();
  });

  it('survives console.warn being unavailable — the old gate had no console dependency', () => {
    const real = console.warn;
    // eslint-disable-next-line no-global-assign
    console.warn = undefined;
    try {
      expect(() => shouldRunSluiceProducer('personal', {})).not.toThrow();
    } finally {
      console.warn = real;
    }
  });

  it('survives a console.warn that THROWS — logging must never take a producer down', () => {
    const real = console.warn;
    console.warn = () => { throw new Error('logger blew up'); };
    try {
      expect(() => shouldRunSluiceProducer('personal', {})).not.toThrow();
      expect(shouldRunSluiceProducer('personal', { INTAKE_ENTITIES: 'personal' })).toBe(true);
    } finally {
      console.warn = real;
    }
  });

  it('a falsy-but-defined entityId can never be opened by an empty list element', () => {
    // 'personal,' puts '' in the list; without the falsy guard, an entity with
    // no id would match it and the gate would open.
    expect(resolveSluiceGate('', { INTAKE_ENTITIES: 'personal,' })).toMatchObject({
      run: false,
      reason: 'no_entity_id',
    });
  });

  it('names the var that is ACTUALLY set in the no_entity_id warning', () => {
    const warn = spyWarn();
    shouldRunSluiceProducer(undefined, { SLUICE_INTAKE: '1' });
    const msg = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(msg).toContain('SLUICE_INTAKE is set');
    expect(msg).not.toContain('INTAKE_ENTITIES is set');
  });
});
