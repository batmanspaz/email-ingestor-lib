// P0 RED (round 2) — temp files. [Sonnet C6, Opus D18/M2]
// The engine renders UNREDACTED page images for OCR and writes an unverified candidate before verifying it. Contract:
// all of that lives in ONE private (0700) directory under os.tmpdir(), files 0600, removed on EVERY exit path
// (redacted, held, verify_failed, engine crash, shadow). Expected at end of Phase 0: E_NOT_IMPLEMENTED.
import { describe, it, expect, beforeAll } from 'vitest';
import { redactBuffer } from '../../pii-redact.js';
import { buildFixtures, watchTmpdir, tesseractPng } from './support/harness.mjs';

let fx;
beforeAll(() => { fx = buildFixtures(); }, 120_000);

async function runWatched(name, opts) {
  const w = watchTmpdir();
  try {
    let mid = null;
    const verify = opts.verifyResult ? async () => { mid = w.snapshot(); return opts.verifyResult; } : undefined;
    const r = await redactBuffer(fx.read(name), { filename: name, mode: opts.mode ?? 'enforce', deps: { ...(opts.deps ?? {}), ...(verify ? { verify } : {}) } });
    return { r, mid, left: w.leftovers() };
  } finally { w.restore(); }
}

describe('temp files: private while they exist, gone afterwards', () => {
  it('image-only PDF, success: mid-run temp entries (snapshot taken INSIDE deps.ocr, while rendered pages exist) are 0700 dirs / 0600 files; nothing left after [Fable L1]', async () => {
    const w = watchTmpdir();
    let mid = [];
    let r;
    try {
      r = await redactBuffer(fx.read('image_only.pdf'), {
        filename: 'image_only.pdf', mode: 'enforce',
        deps: { ocr: async (png) => { if (!mid.length) mid = w.snapshot(); return tesseractPng(png); } },
      });
    } finally { w.restore(); }
    expect(r.outcome).toBe('redacted');
    expect(mid.length).toBeGreaterThan(0); // the engine DID hold rendered pages in temp space at that moment
    for (const e of mid) expect(e.mode, e.path).toBe(e.dir ? 0o700 : 0o600);
    expect(w.leftovers()).toEqual([]);
  });

  it('verify_failed: nothing left after', async () => {
    const { r, left } = await runWatched('image_only.pdf', { verifyResult: { ok: false, residual: [{ kind: 'ssn', surface: 'ocr' }] } });
    expect(r.outcome).toBe('held');
    expect(left).toEqual([]);
  });

  it('engine crash: nothing left after', async () => {
    const { r, left } = await runWatched('text_layer.pdf', { deps: { engineCmd: ['python3', '-c', 'import sys; sys.exit(3)'] } });
    expect(r).toMatchObject({ outcome: 'held', reason: 'engine_error' });
    expect(left).toEqual([]);
  });

  it('held (encrypted) and shadow: nothing left after', async () => {
    for (const [name, mode] of [['encrypted.pdf', 'enforce'], ['image_only.pdf', 'shadow'], ['bundle.zip', 'enforce']]) {
      const { left } = await runWatched(name, { mode });
      expect(left, `${name}/${mode}`).toEqual([]);
    }
  });
});
