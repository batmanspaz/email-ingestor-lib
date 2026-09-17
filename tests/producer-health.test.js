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
import { computeProducerStatus, reportProducerHealth, trackProducerRun, computeTruncationCheck, computeHistoryExpiredCheck, computeStallCheck, computeQuarantineCheck, producerHealthStats, producerRunStats } from '../producer-health.js';
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
  // tasks.db #1054: poll.js's outer per-account try/catch (PR #55) increments
  // stats.errors when an ENTIRE account throws (e.g. an auth failure) before
  // it ever lists a message — that account contributes 0 to stats.fetched.
  // If that happens on a run where no OTHER account fetched anything either
  // (a quiet mailbox, or the only configured account), the aggregate is
  // {fetched: 0, errors: 1}. The old `fetched === 0 || errors === 0` check
  // short-circuited on fetched===0 and reported 'ok' — a real account error
  // reported healthy purely because nothing happened to fetch. Rule-13
  // "missing = healthy" banned pattern.
  it('is down (not just non-ok) when an account errored outright even though nothing was fetched', () => {
    expect(computeProducerStatus({ fetched: 0, produced: 0, errors: 1 })).toBe('down');
  });
  // errors mixes per-message failures with whole-account throws (poll.js's
  // outer try/catch, PR #55), so it can legitimately exceed fetched: one
  // account fetches 1 message that then errors, a second account throws
  // outright -> fetched:1, errors:2. Every fetched item failed AND an
  // account is dead -- that's 'down', not 'degraded'. `errors === fetched`
  // alone would miss this; needs `errors >= fetched`.
  it('is down when errors exceed fetched (a fetched item failed and a whole other account threw)', () => {
    expect(computeProducerStatus({ fetched: 1, produced: 0, errors: 2 })).toBe('down');
  });
});

// ── tasks.db #1056: per-message and per-account errors are different units ──
//
// PR #58 (#1054) patched the comparator to `errors >= fetched`, which closed ONE cell of the
// mis-report table. The conflation itself survived: poll.js increments a single `errors` for
// BOTH a message that failed to process (poll.js ~324) and a whole account that threw before it
// listed anything (the per-account try/catch from PR #55, poll.js ~399). computeProducerStatus
// then has to GUESS the unit from one summed number.
//
// The cell that guess still gets wrong is the dangerous one, and it was a REAL incident shape:
// one dead account on a BUSY run — emilee.stone@collagesoup.com went auth-dead while the other
// accounts kept fetching fine (diagnosed 2026-09-14; re-seeded that day and fetching normally on
// every run since — this is a historical example of the failure class, not a current account
// issue). {fetched: 5, errors: 2} reads as "2 of 5 items had trouble" => degraded, and a whole
// entity's mail silently stops being collected behind a green-ish status. The more mail the
// healthy accounts carry, the more thoroughly the dead one hides.
//
// Fix: poll() reports messageErrors and accountErrors separately (keeping `errors` as their sum
// for every existing caller), and the status derives DOWN from any accountErrors > 0 rather than
// reasoning over one field whose unit is ambiguous. Recommended independently by Sonnet, Opus and
// Fable reviewing PR #58.
describe('computeProducerStatus — split account vs message error counts (#1056)', () => {
  it('is down when a whole account threw, even on a busy run where errors < fetched', () => {
    // THE BUG. Summed alone this is `{fetched: 5, errors: 2}` -> 'degraded'.
    expect(
      computeProducerStatus({ fetched: 5, produced: 4, errors: 2, messageErrors: 1, accountErrors: 1 }),
    ).toBe('down');
  });

  it('is down for a dead account even when every other account had a perfect run', () => {
    expect(
      computeProducerStatus({ fetched: 20, produced: 20, errors: 1, messageErrors: 0, accountErrors: 1 }),
    ).toBe('down');
  });

  it('is still only degraded when the SAME error count is all per-message — the split must not just escalate everything', () => {
    expect(
      computeProducerStatus({ fetched: 5, produced: 3, errors: 2, messageErrors: 2, accountErrors: 0 }),
    ).toBe('degraded');
  });

  it('is down when every fetched item failed, with no account error involved', () => {
    expect(
      computeProducerStatus({ fetched: 3, produced: 0, errors: 3, messageErrors: 3, accountErrors: 0 }),
    ).toBe('down');
  });

  // Round 3 finding (tasks.db #1056, verified by execution): the `fetched === 0` half of the old
  // `if (fetched === 0 || messageErrors >= fetched) return 'down'` OR was written on the premise
  // that fetched:0 with a messageError is arithmetically impossible garbage input. The `listed`
  // flag fix to poll.js made it a real, valid shape: a quiet account (getHistory succeeds, 0 new
  // mail) whose subsequent getCurrentHistoryId()/writeState() throws now counts as a messageError,
  // not an accountError — {fetched:0, messageErrors:1, accountErrors:0}. accountErrors is already
  // confirmed valid-and-zero by the time this branch runs, so this is one quiet-but-healthy
  // account with a real transient blip — degraded, not a full outage.
  it('is degraded, not down, for a quiet account with a real transient message error and no account error (round 3, #1056)', () => {
    expect(
      computeProducerStatus({ fetched: 0, errors: 1, messageErrors: 1, accountErrors: 0 }),
    ).toBe('degraded');
  });

  it('is ok when both counts are zero', () => {
    expect(
      computeProducerStatus({ fetched: 4, produced: 4, errors: 0, messageErrors: 0, accountErrors: 0 }),
    ).toBe('ok');
  });

  it('is down when the only account there is died and nothing was fetched', () => {
    expect(
      computeProducerStatus({ fetched: 0, produced: 0, errors: 1, messageErrors: 0, accountErrors: 1 }),
    ).toBe('down');
  });

  // The three consumer repos pin this lib by git SHA and upgrade independently, so a caller on an
  // older poll() will keep sending the summed shape for a while. It must not change meaning.
  it('falls back to the summed comparator when the split counts are absent', () => {
    expect(computeProducerStatus({ fetched: 4, produced: 2, errors: 2 })).toBe('degraded');
    expect(computeProducerStatus({ fetched: 0, produced: 0, errors: 1 })).toBe('down');
    expect(computeProducerStatus({ fetched: 1, produced: 0, errors: 2 })).toBe('down');
    expect(computeProducerStatus({ fetched: 5, produced: 5, errors: 0 })).toBe('ok');
  });

  it('honours a valid accountErrors even when messageErrors is missing — the bad news is never the optional half', () => {
    // Asymmetric on purpose. A known dead account is a fact; the absence of the other counter
    // does not soften it. Rounding a partial split DOWN to the lenient legacy answer is how
    // "missing = healthy" gets rebuilt one layer up (dev-rules §28.1).
    expect(computeProducerStatus({ fetched: 5, produced: 4, errors: 2, accountErrors: 1 })).toBe('down');
  });

  it('falls back to the summed comparator when a split count is not a usable number', () => {
    // NaN from a Number(...) coercion, or a string from a consumer wiring this by hand. Neither
    // is evidence of anything, so neither may quietly stand in for zero.
    expect(
      computeProducerStatus({ fetched: 5, produced: 4, errors: 2, messageErrors: 1, accountErrors: 'one' }),
    ).toBe('degraded');
    expect(
      computeProducerStatus({ fetched: 5, produced: 4, errors: 2, messageErrors: NaN, accountErrors: 0 }),
    ).toBe('degraded');
  });

  // tasks.db #1056 defect 2b (Opus, 3-model audit of PR #59). A caller can hand in a valid, VALID
  // split (messageErrors:0, accountErrors:0) alongside a summed `errors` that disagrees with it.
  // That shape is structurally impossible on pre-PR main — there was only one number — and the
  // split branch above must not trust a zeroed split into reporting 'ok' when the summed `errors`
  // it was supposedly split FROM is itself a valid, nonzero count. An incoherent split is not
  // evidence of health; it is evidence the split itself is wrong (a bug in poll(), or a
  // hand-built stats object), and must never be more lenient than the legacy summed read.
  it('never reports ok when the split is zeroed but the summed errors is a valid nonzero count (incoherent split)', () => {
    expect(
      computeProducerStatus({ fetched: 4, produced: 2, errors: 2, messageErrors: 0, accountErrors: 0 }),
    ).not.toBe('ok');
  });

  it('an incoherent split still resolves via the legacy summed comparator, not a guess', () => {
    // fetched:4, errors:2 -> degraded under the legacy comparator (errors < fetched). The
    // incoherent split must land on exactly that answer, not 'ok' and not an unrelated 'down'.
    expect(
      computeProducerStatus({ fetched: 4, produced: 2, errors: 2, messageErrors: 0, accountErrors: 0 }),
    ).toBe('degraded');
  });

  it('a COHERENT zeroed split (errors also 0) is still a clean ok', () => {
    expect(
      computeProducerStatus({ fetched: 4, produced: 4, errors: 0, messageErrors: 0, accountErrors: 0 }),
    ).toBe('ok');
  });

  // tasks.db #1056 round 2, DEFECT M-5 (Opus, 3-model audit of PR #59). A PRESENT but INVALID
  // accountErrors (a string, not simply absent) fell through both split checks above (each
  // requires validCount(accountErrors)) and landed on the legacy `errors === 0` comparator, which
  // read the also-zero `errors`/`messageErrors` fields and returned a clean 'ok' — a caller who
  // sent garbage in accountErrors got the SAME answer as a caller who sent nothing at all.
  // validCount()'s own docblock says an invalid count must never stand in for zero; this is that
  // guarantee reaching the one branch it didn't cover yet.
  it('never reports ok when a split field is present but not a usable number, even if errors is also 0 (M-5)', () => {
    expect(
      computeProducerStatus({ fetched: 0, errors: 0, messageErrors: 0, accountErrors: '3' }),
    ).not.toBe('ok');
    expect(
      computeProducerStatus({ fetched: 0, errors: 0, messageErrors: 0, accountErrors: '3' }),
    ).toBe('degraded');
  });

  it('a present-but-invalid messageErrors is floored the same way as accountErrors (M-5)', () => {
    expect(
      computeProducerStatus({ fetched: 0, errors: 0, messageErrors: 'zero', accountErrors: 0 }),
    ).toBe('degraded');
  });

  // tasks.db #1070 — defense-in-depth, LOW. `fetched` was the one count in this branch read
  // WITHOUT a validCount() guard (only messageErrors/accountErrors had one). Round 3's
  // `fetched > 0` gate is a DE-ESCALATION: it is the only thing that can turn the
  // "every fetched item failed" verdict from 'down' back into 'degraded'. An unusable fetched
  // therefore silently bought the lenient answer — {fetched:-1, messageErrors:1, accountErrors:0}
  // returned 'degraded' where pre-round-3 it returned 'down' — which is "missing = healthy"
  // rebuilt one layer up in the denominator instead of the numerator (dev-rules §28.1).
  //
  // Matching the guard convention already established for the other two counts: an unusable count
  // is UNKNOWN, and unknown may never stand in for the benign reading. Here the benign reading is
  // "the failure was partial", and only a trustworthy fetched can establish that — so an unusable
  // one cannot soften the verdict. Same asymmetry as 'honours a valid accountErrors even when
  // messageErrors is missing' above: the bad news is never the optional half.
  //
  // UNREACHABLE through poll.js by construction — stats.fetched is initialized to 0 and only ever
  // incremented, never settable to a negative or non-number. This guard exists so a malformed
  // caller fails loud instead of quietly changing severity as a side effect of a future refactor.
  it('is down, not degraded, when fetched is not a usable count alongside a real message error (#1070)', () => {
    expect(
      computeProducerStatus({ fetched: -1, errors: 1, messageErrors: 1, accountErrors: 0 }),
    ).toBe('down');
  });

  it('treats every unusable fetched shape alike — negative, NaN, a string, Infinity, absent (#1070)', () => {
    for (const fetched of [-1, NaN, '3', Infinity, undefined]) {
      expect(
        computeProducerStatus({ fetched, errors: 1, messageErrors: 1, accountErrors: 0 }),
      ).toBe('down');
    }
  });

  it('still softens to degraded for the VALID fetched:0 quiet account — the #1070 guard must not undo round 3', () => {
    // validCount(0) is true, so the one shape round 3 was written for stays exactly as it was.
    expect(
      computeProducerStatus({ fetched: 0, errors: 1, messageErrors: 1, accountErrors: 0 }),
    ).toBe('degraded');
  });

  it('a usable fetched still decides partial vs total on its own merits, unchanged by the #1070 guard', () => {
    expect(
      computeProducerStatus({ fetched: 5, errors: 1, messageErrors: 1, accountErrors: 0 }),
    ).toBe('degraded');
    expect(
      computeProducerStatus({ fetched: 3, errors: 3, messageErrors: 3, accountErrors: 0 }),
    ).toBe('down');
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

  // tasks.db #1056 end-to-end: this is what a consumer actually calls, with poll()'s real return
  // spread straight through. The unit tests above pin the derivation; this pins the wiring, which
  // is where #944/#948 both went wrong.
  it('reports DOWN when one account is dead on an otherwise-busy, otherwise-healthy run', async () => {
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
    // The emilee.stone@collagesoup.com shape (2026-09-14 incident, since resolved — the account
    // was re-seeded and has been fetching normally): four accounts pulling mail fine, one
    // auth-dead. Summed, `errors: 1` against `fetched: 20` used to read as 'degraded'.
    await reportProducerHealth(
      telemetry,
      {
        fetched: 20, produced: 20, errors: 1, messageErrors: 0, accountErrors: 1,
        truncated: 0, historyExpired: 0, maxStalledRuns: 0, quarantined: 0,
      },
      { sluiceDir },
    );

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

// ── env-var drop-dir resolution — the Aug 2026 Intake rename drift ─────────
// The rename moved the producer's own drop-dir env var from SLUICE_DIR to
// INTAKE_DIR (src/sluice-config.js:resolveDropDir() in every consumer repo
// dual-reads INTAKE_DIR || SLUICE_DIR already). This module's own default —
// used only when a caller does not pass opts.sluiceDir explicitly — was never
// updated and still reads ONLY the deprecated SLUICE_DIR, so a producer whose
// env only has INTAKE_DIR set reports a false queue.depth 'fail' ("inbox dir
// not configured") even though its real inbox exists and is empty/healthy.
// This has driven producer.* modules to overall status=down on hx-health-ingest
// since 2026-09-05 — a false alarm, not real data loss (tasks.db #944).
describe('reportProducerHealth — default sluiceDir resolution (env-var rename drift)', () => {
  const ORIGINAL_INTAKE_DIR = process.env.INTAKE_DIR;
  const ORIGINAL_SLUICE_DIR = process.env.SLUICE_DIR;

  afterEach(() => {
    if (ORIGINAL_INTAKE_DIR === undefined) delete process.env.INTAKE_DIR;
    else process.env.INTAKE_DIR = ORIGINAL_INTAKE_DIR;
    if (ORIGINAL_SLUICE_DIR === undefined) delete process.env.SLUICE_DIR;
    else process.env.SLUICE_DIR = ORIGINAL_SLUICE_DIR;
  });

  it('reports queue.depth as pass when only INTAKE_DIR is set and no opts.sluiceDir is passed (the real producer.* call-site shape)', async () => {
    delete process.env.SLUICE_DIR;
    process.env.INTAKE_DIR = sluiceDir; // fixture dir already has an empty inbox/

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
    // No opts.sluiceDir — mirrors every real call site (personal/collagesoup/
    // perfectcity index.js), all of which call reportProducerHealth(telemetry,
    // stats) with no third argument at all and rely entirely on this module's
    // env-var default.
    await reportProducerHealth(telemetry, { fetched: 1, produced: 1, errors: 0, truncated: 0, historyExpired: 0, maxStalledRuns: 0, quarantined: 0 });

    const report = sent.health[0];
    expect(() => HealthReportSchema.parse(report)).not.toThrow();
    const queueCheck = report.checks.find((c) => c.id === 'queue.depth');
    expect(queueCheck.status).toBe('pass');
    expect(report.status).toBe('ok');
  });

  it('still falls back to SLUICE_DIR when INTAKE_DIR is unset (back-compat for any caller not yet migrated)', async () => {
    delete process.env.INTAKE_DIR;
    process.env.SLUICE_DIR = sluiceDir;

    const { sent, transport } = fakeTransport();
    const telemetry = createTelemetry({
      product: 'sluice', module: 'producer.test', version: 'test',
      transport, heartbeatMs: 0, batchIntervalMs: 0, autoStart: false,
    });
    await reportProducerHealth(telemetry, { fetched: 1, produced: 1, errors: 0, truncated: 0, historyExpired: 0, maxStalledRuns: 0, quarantined: 0 });

    const queueCheck = sent.health[0].checks.find((c) => c.id === 'queue.depth');
    expect(queueCheck.status).toBe('pass');
  });

  it('prefers INTAKE_DIR over SLUICE_DIR when both happen to be set', async () => {
    process.env.SLUICE_DIR = '/nonexistent/stale/sluice/dir';
    process.env.INTAKE_DIR = sluiceDir;

    const { sent, transport } = fakeTransport();
    const telemetry = createTelemetry({
      product: 'sluice', module: 'producer.test', version: 'test',
      transport, heartbeatMs: 0, batchIntervalMs: 0, autoStart: false,
    });
    await reportProducerHealth(telemetry, { fetched: 1, produced: 1, errors: 0, truncated: 0, historyExpired: 0, maxStalledRuns: 0, quarantined: 0 });

    const queueCheck = sent.health[0].checks.find((c) => c.id === 'queue.depth');
    expect(queueCheck.status).toBe('pass');
  });

  it('still reports queue.depth as fail when NEITHER INTAKE_DIR nor SLUICE_DIR is set', async () => {
    delete process.env.INTAKE_DIR;
    delete process.env.SLUICE_DIR;

    const { sent, transport } = fakeTransport();
    const telemetry = createTelemetry({
      product: 'sluice', module: 'producer.test', version: 'test',
      transport, heartbeatMs: 0, batchIntervalMs: 0, autoStart: false,
    });
    await reportProducerHealth(telemetry, { fetched: 1, produced: 1, errors: 0, truncated: 0, historyExpired: 0, maxStalledRuns: 0, quarantined: 0 });

    const queueCheck = sent.health[0].checks.find((c) => c.id === 'queue.depth');
    expect(queueCheck.status).toBe('fail');
    expect(sent.health[0].status).toBe('down');
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
    expect(event.props).toEqual({ entity_id: 'collagesoup', fetched: 4, produced: 3, skipped: 1, errors: 0, message_errors: 0, account_errors: 0, quarantined: 0 });
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
    expect(Object.keys(props).sort()).toEqual([
      'account_errors',
      'entity_id',
      'errors',
      'fetched',
      'message_errors',
      'produced',
      'quarantined',
      'skipped',
    ]);
  });

  // tasks.db #1056 — the same conflation, in the analytics half. Health status is only one
  // consumer of these counts; a dashboard reasoning over a single summed `errors` column is
  // just as unable to tell "3 of 40 messages had trouble" from "an entity's mail stopped
  // arriving". Rule 13 makes analytics a Phase-0 invariant alongside health, so the split has
  // to reach both or the fix is half-done.
  it('emits message_errors and account_errors as separate props', async () => {
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
    trackProducerRun(telemetry, {
      entityId: 'collagesoup',
      fetched: 5,
      produced: 4,
      skipped: 0,
      errors: 2,
      messageErrors: 1,
      accountErrors: 1,
    });
    await telemetry.flush();

    const batch = sent.analytics[0];
    expect(() => AnalyticsBatchSchema.parse(batch)).not.toThrow();
    expect(batch[0].props).toEqual({
      entity_id: 'collagesoup',
      fetched: 5,
      produced: 4,
      skipped: 0,
      errors: 2,
      message_errors: 1,
      account_errors: 1,
      quarantined: 0,
    });
  });

  it('emits both at zero on a clean run — silence is not evidence of absence (dev-rules §28.1)', async () => {
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

    expect(sent.analytics[0][0].props).toMatchObject({ message_errors: 0, account_errors: 0 });
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

// ---------------------------------------------------------------------------
// producerHealthStats / producerRunStats — tasks.db #958, fast-follow to #948.
//
// #948 found that every call site built reportProducerHealth()'s stats
// argument by hand as `{ fetched, produced, errors }` — three fields
// cherry-picked out of the nine poll() actually returns — and that the missing
// four (truncated, historyExpired, maxStalledRuns, quarantined) render as
// permanent `warn`s (missing = healthy is banned, dev-rules Sec28.1), pinning
// producer.* to a permanent `degraded`. collagesoup fixed its own call site
// with a local adapter (src/sluice-config.js); #958 moves that adapter here so
// personal/perfectcity consume ONE definition instead of pasting a second and
// third copy of it.
//
// This lib already reads every one of poll()'s nine keys (the checks above),
// so the adapter itself is trivial: pass poll()'s result through, renaming
// only the one field name the two contracts disagree on (processed -> produced).
// ---------------------------------------------------------------------------

function fullPollStats() {
  return {
    fetched: 12,
    processed: 10,
    errors: 0,
    forwarded: 1,
    archived: 10,
    truncated: 0,
    quarantined: 0,
    historyExpired: 0,
    maxStalledRuns: 0,
  };
}

describe('producerHealthStats', () => {
  it('forwards every count poll() reports — the four that used to be dropped included', () => {
    const out = producerHealthStats(fullPollStats());
    for (const field of ['truncated', 'historyExpired', 'maxStalledRuns', 'quarantined']) {
      expect(Object.hasOwn(out, field), `${field} must be present as an asserted count, not absent`).toBe(true);
      expect(out[field]).toBe(0);
    }
    expect(out.fetched).toBe(12);
  });

  it("maps poll()'s `processed` onto the lib's `produced`", () => {
    expect(producerHealthStats(fullPollStats()).produced).toBe(10);
  });

  // `errors` must be passed through, NEVER defaulted: computeProducerStatus()
  // reads it WITHOUT an invalidCount() guard, so a laundered zero silently
  // yields 'ok'.
  it('does NOT default a missing error count to zero', () => {
    const { errors, ...noErrors } = fullPollStats();
    expect(Object.hasOwn(producerHealthStats(noErrors), 'errors')).toBe(false);
  });

  it('passes a real error count through untouched', () => {
    expect(producerHealthStats({ ...fullPollStats(), errors: 4 }).errors).toBe(4);
  });

  it('passes non-zero counts through untouched — it reports, it does not sanitize', () => {
    const out = producerHealthStats({ ...fullPollStats(), truncated: 3, quarantined: 1, historyExpired: 2, maxStalledRuns: 7 });
    expect(out.truncated).toBe(3);
    expect(out.quarantined).toBe(1);
    expect(out.historyExpired).toBe(2);
    expect(out.maxStalledRuns).toBe(7);
  });

  it('a clean poll() run reports ok on the wire through the REAL telemetry client — not degraded', async () => {
    const { sent, transport } = fakeTransport();
    const telemetry = createTelemetry({
      product: 'sluice', module: 'producer.test', version: 'test',
      transport, heartbeatMs: 0, batchIntervalMs: 0, autoStart: false,
    });
    await reportProducerHealth(telemetry, producerHealthStats(fullPollStats()), { sluiceDir });
    expect(sent.health.length).toBe(1);
    const report = sent.health[0];
    expect(() => HealthReportSchema.parse(report)).not.toThrow();
    const unknown = report.checks.filter((c) => /not reported by poll\(\)/.test(c.detail ?? ''));
    expect(unknown).toEqual([]);
    expect(report.status).toBe('ok');
  });

  // Regression anchor: the OLD hand-built three-field shape must keep producing
  // degraded. If this ever goes green, the lib has started guessing zeroes and
  // #948/#958 are back in a new form.
  it('the old cherry-picked three-field shape still reproduces degraded (regression anchor)', async () => {
    const { sent, transport } = fakeTransport();
    const telemetry = createTelemetry({
      product: 'sluice', module: 'producer.test', version: 'test',
      transport, heartbeatMs: 0, batchIntervalMs: 0, autoStart: false,
    });
    const st = fullPollStats();
    await reportProducerHealth(telemetry, { fetched: st.fetched, produced: st.processed, errors: st.errors }, { sluiceDir });
    expect(sent.health[0].status).toBe('degraded');
  });
});

describe('producerRunStats', () => {
  // trackProducerRun() declares `quarantined = 0` as a DEFAULT PARAMETER, so an
  // omitted field reads as "none", not "unknown" — the producer.run analytics
  // event would claim zero quarantined messages on precisely the run whose
  // health report says otherwise. This is "missing = healthy" rebuilt one layer
  // up (#948's 3-model review).
  it('forwards the real quarantined count, never a defaulted zero', () => {
    expect(producerRunStats('personal', { ...fullPollStats(), quarantined: 3 }).quarantined).toBe(3);
    expect(producerRunStats('personal', fullPollStats()).quarantined).toBe(0);
  });

  it('maps entityId, fetched, produced, errors correctly and defaults skipped to 0', () => {
    const out = producerRunStats('collagesoup', fullPollStats());
    expect(out).toMatchObject({
      entityId: 'collagesoup', fetched: 12, produced: 10, skipped: 0, errors: 0, quarantined: 0,
    });
  });

  // tasks.db #1056 defect 1 — 3-model audit of PR #59, all three reviewers. The health half of
  // the split (producerHealthStats) spreads poll()'s result and so forwards messageErrors/
  // accountErrors automatically. This, its analytics twin, HAND-ENUMERATES the output object and
  // silently dropped both new fields — the exact "cherry-picked three-field shape" #948 already
  // fixed once, reopened for the two newest counts. trackProducerRun() defaults both to 0 when
  // absent, so a real dead-account run reported account_errors:0 on the wire: the one metric a
  // dashboard would filter on to catch #1056 in the first place was DOA.
  it('forwards messageErrors and accountErrors, not a defaulted zero', () => {
    const out = producerRunStats('collagesoup', { ...fullPollStats(), errors: 1, messageErrors: 0, accountErrors: 1 });
    expect(out.accountErrors).toBe(1);
    expect(out.messageErrors).toBe(0);
  });
});

// ── composition seam: trackProducerRun(producerRunStats(...)) — tasks.db #1056 defect 1 ──
//
// Each half (producerRunStats, trackProducerRun) was tested in isolation and both passed; the
// SEAM between them — what a real consumer actually calls — was never exercised, and that is
// exactly where the bug lived: producerRunStats dropped the two new fields, so trackProducerRun's
// own defaulting silently replaced them with 0 no matter what poll() actually returned.
describe('trackProducerRun(producerRunStats(...)) composition — tasks.db #1056 defect 1', () => {
  it('emits account_errors: 1 for a real dead-account poll() fixture, not a laundered 0', async () => {
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

    // The emilee.stone@collagesoup.com shape (2026-09-14 incident, since resolved — the account
    // was re-seeded and has been fetching normally): a busy, otherwise-healthy run where exactly
    // one account died before listing anything. This is poll()'s REAL return shape, not a
    // hand-built params object — the composition is the point.
    const deadAccountFixture = {
      fetched: 20,
      processed: 20,
      errors: 1,
      messageErrors: 0,
      accountErrors: 1,
      forwarded: 0,
      archived: 20,
      truncated: 0,
      quarantined: 0,
      historyExpired: 0,
      maxStalledRuns: 0,
    };

    trackProducerRun(telemetry, producerRunStats('collagesoup', deadAccountFixture));
    await telemetry.flush();

    const batch = sent.analytics[0];
    expect(() => AnalyticsBatchSchema.parse(batch)).not.toThrow();
    expect(batch[0].props.account_errors).toBe(1);
    expect(batch[0].props.message_errors).toBe(0);
  });
});
