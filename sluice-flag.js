/**
 * sluice-flag.js — shared intake gate for every entity's Sluice producer.
 *
 * Mirrors intake's own SLUICE_OWN_POLL/shouldSkipOwnPoll comma-list
 * convention (see intake/src/lib/own-poll.js) so a second entity's producer
 * can be staged independently of personal's already-live one, instead of
 * both reading the same shared master.env boolean.
 *
 *   INTAKE_ENTITIES=1          → back-compat: personal only
 *   INTAKE_ENTITIES=a,b,c      → enable exactly the listed entity ids
 *
 * `SLUICE_INTAKE` is the deprecated spelling and is still read, with a warning,
 * so producer and consumer repos can migrate without a lockstep deploy — the
 * same dual-read shape the producers' own resolveDropDir (INTAKE_DIR ||
 * SLUICE_DIR) already uses. An EMPTY new var falls through to the old one,
 * deliberately consistent with that shim.
 *
 * WHY THE GATE IS LOUD (2026-08-23). Each consumer does
 * `const runner = <gate> ? sluiceMain : main`, so a disabled gate does not stop
 * the process — it silently reverts that entity to the LEGACY
 * drop/forward/classify path, which keeps emitting normal-looking activity
 * while the intake pipeline receives nothing. Absence of a heartbeat would have
 * been detectable; this was not. So resolveSluiceGate() carries the reason,
 * shouldRunSluiceProducer() says out loud why it turned a producer off, and
 * computeSluiceGateCheck() reports a disabled producer as `warn`, never green
 * by absence (dev-rules.md §28).
 */

const NEW_VAR = 'INTAKE_ENTITIES';
const OLD_VAR = 'SLUICE_INTAKE';

/**
 * The pre-2026-08-23 gate had no console dependency at all and could not throw.
 * Keep that property: a missing/oddly-shaped console must never take a producer
 * down at startup.
 */
function warn(message) {
  try {
    if (typeof console !== 'undefined' && typeof console.warn === 'function') {
      console.warn(message);
    }
  } catch {
    // A wrapped/instrumented console that THROWS must not take a producer down
    // either — the typeof guard alone did not deliver the invariant above.
  }
}

/** String() coerces a Symbol; a template literal throws on one. */
function label(entityId) {
  return entityId === undefined || entityId === null ? '(no entity id)' : String(entityId);
}

function listMatches(value, entityId) {
  if (value === '1') return entityId === 'personal';
  return value
    .split(',')
    .map((s) => s.trim())
    .includes(entityId);
}

/**
 * Pure. Resolves the gate and WHY, without logging — callers own the noise.
 *
 * @param {*} entityId — normally a string; any truthy non-string (a Symbol
 *   included) passes through untouched and is coerced only for display.
 * @returns {{run:boolean, reason:'enabled'|'not_listed'|'flag_unset'|'no_entity_id',
 *            source:'INTAKE_ENTITIES'|'SLUICE_INTAKE'|null, deprecated:boolean,
 *            entityId:*|null}}
 */
export function resolveSluiceGate(entityId, env = process.env) {
  const fromNew = env[NEW_VAR];
  const value = fromNew || env[OLD_VAR];
  const source = fromNew ? NEW_VAR : env[OLD_VAR] ? OLD_VAR : null;
  const deprecated = source === OLD_VAR;
  const id = entityId === undefined || entityId === null ? null : entityId;

  if (!value) {
    return { run: false, reason: 'flag_unset', source: null, deprecated: false, entityId: id };
  }
  if (!entityId) {
    return { run: false, reason: 'no_entity_id', source, deprecated, entityId: id };
  }
  const run = listMatches(value, entityId);
  return {
    run,
    reason: run ? 'enabled' : 'not_listed',
    source,
    deprecated,
    entityId: id,
  };
}

/**
 * Consumer-facing gate. Same boolean contract as before, but it now explains
 * itself on the way out. Called once per process at startup, so "warn on every
 * call" is in practice "warn once per run" — no module state, no test-order
 * coupling.
 */
export function shouldRunSluiceProducer(entityId, env = process.env) {
  const gate = resolveSluiceGate(entityId, env);

  if (gate.deprecated) {
    warn(`[sluice-flag] ${OLD_VAR} is deprecated — set ${NEW_VAR} instead.`);
  }

  if (!gate.run) {
    const who = label(gate.entityId);
    const why =
      gate.reason === 'flag_unset'
        ? `neither ${NEW_VAR} nor ${OLD_VAR} is set`
        : gate.reason === 'no_entity_id'
          ? `no entity id was supplied to the gate (${gate.source} is set)`
          : `${who} is not listed in ${gate.source}`;
    warn(
      `[sluice-flag] Intake producer DISABLED for ${who}: ${why}. ` +
        `Falling back to the legacy drop/forward/classify path — this entity ` +
        `will produce NO intake envelopes. Set ${NEW_VAR} to enable it.`,
    );
  }

  return gate.run;
}

/**
 * Telemetry check for the gate. A disabled producer reports `warn` for EVERY
 * disabled reason — never `pass`, and never nothing at all: "missing = healthy"
 * is banned (dev-rules.md §28).
 *
 * SHAPE IS NOT NEGOTIABLE. `HealthCheckSchema` in @perfectcity/telemetry is
 * `.strict()` and permits only {id, status, detail?, metric?, unit?}. An extra
 * top-level key does not merely drop this check — `telemetry.js` fails the whole
 * `HealthReportSchema.safeParse` and discards the ENTIRE report (producer_run
 * and queue.depth with it) via `bumpDropped('health')`, with nothing thrown.
 * A first cut of this function emitted `reason`/`entity_id` as top-level keys
 * and would have blacked out the health of the first module to adopt it — the
 * exact silent failure this module exists to abolish. Diagnostics therefore go
 * in `detail`, the one free-text field, as queue-depth.js already does.
 *
 * PII-free by construction: an entity id and an enum reason, nothing free-form.
 *
 * WHERE TO REPORT IT FROM. This check only earns its keep if it is emitted on a
 * path that RUNS WHEN THE GATE IS OFF. Every consumer's `reportProducerHealth`
 * call currently sits inside `sluiceMain`, which the gate skips — wiring it
 * there reproduces exactly the blind spot it exists to close. Report it from
 * the legacy path too, or from a top-level reporter that runs either way.
 */
export function computeSluiceGateCheck(gate) {
  return {
    id: 'intake.gate',
    status: gate.run ? 'pass' : 'warn',
    metric: gate.run ? 1 : 0,
    unit: 'count',
    // `source` is in here deliberately: this work exists to unblock deleting
    // SLUICE_INTAKE from master.env, and that removal is blind unless telemetry
    // can answer "is any entity still being enabled by the deprecated key?"
    detail:
      `reason=${gate.reason} source=${gate.source ?? 'none'} ` +
      `entity_id=${gate.entityId === null ? 'none' : String(gate.entityId)}`,
  };
}
