// P0 RED — PDF redaction engine contract (redactBuffer / verifyRedacted).
// Independent verification: outputs are inspected with tests/pii-redact/support/inspect_pdf.py + local tesseract,
// never with the engine's own verifier. Expected at the end of Phase 0: all fail with E_NOT_IMPLEMENTED.
// Round 2 (2026-10-14): red-team fold-in. IDs in test names map to review-verdicts/{sonnet,opus}-redact-p0.md.
import { describe, it, expect, beforeAll } from 'vitest';
import { redactBuffer, verifyRedacted } from '../../pii-redact.js';
import { buildFixtures, inspectPdf, allLeaks, negativesPresent, lastFourKept, regionStats, privateDigitsIn, SECRETS } from './support/harness.mjs';

let fx;
beforeAll(() => { fx = buildFixtures(); }, 120_000);

/** Every surface the independent inspector has, incl. raw file bytes, every decoded object, and TWO local OCR setups. */
const inspectAll = (buf) => inspectPdf(buf, { ocr: true, ocrAlt: true });

/** Output hygiene every redacted PDF must meet (Opus D1): one revision, no unreferenced objects. */
function expectNoDeadData(out, name) {
  expect(out.meta.revisions, `${name}: revisions`).toBe(1);
  expect(out.meta.xref_length_gc, `${name}: orphan objects`).toBe(out.meta.xref_length);
}

const REDACTABLE = [
  'text_layer.pdf', 'image_only.pdf', 'mixed.pdf', 'acroform.pdf', 'metadata.pdf', 'embedded.pdf', 'annots_toc.pdf',
  'hidden_ocg.pdf', 'white_on_white.pdf', 'footer_every_page.pdf', 'split_spans.pdf', 'unicode_dashes.pdf',
  // round 2
  'form_xobject.pdf', 'acroform_full.pdf', 'image_on_text_page.pdf', 'objstm.pdf', 'js_action.pdf', 'custom_info_key.pdf',
  'link_labels_fileannot.pdf', 'incremental_history.pdf', 'orphan_after_redact.pdf',
];
// Hard inputs where HOLDING is an acceptable (fail-closed) answer; 'redacted' must still be leak-free.
const REDACTED_OR_HELD = ['scan_variants.pdf', 'xfa.pdf', 'encrypted_owner_only.pdf'];

describe('every surface is scrubbed (enforce mode)', () => {
  for (const name of REDACTABLE) {
    it(`${name}: no secret (full OR partial) survives on ANY surface — text, raw streams, metadata, xmp, widgets, annots, toc, embedded, RAW FILE BYTES, every decoded object, two OCR setups; one revision, no orphans`, async () => {
      const input = fx.read(name);
      const r = await redactBuffer(input, { filename: name, mode: 'enforce' });
      expect(r.outcome).toBe('redacted');
      const out = inspectAll(r.buffer);
      expect(out.ok).toBe(true);
      expect(allLeaks(out.surfaces, fx.manifest[name].secrets)).toEqual([]);
      expectNoDeadData(out, name);
    });
  }

  for (const name of REDACTED_OR_HELD) {
    it(`${name}: redacted leak-free, or held — never clean, never redacted-with-residue`, async () => {
      const r = await redactBuffer(fx.read(name), { filename: name, mode: 'enforce' });
      expect(['redacted', 'held']).toContain(r.outcome);
      if (r.outcome === 'held') { expect(r.buffer).toBeUndefined(); return; }
      const out = inspectAll(r.buffer);
      expect(allLeaks(out.surfaces, fx.manifest[name].secrets)).toEqual([]);
      expect(out.meta.is_encrypted).toBe(false);
      expectNoDeadData(out, name);
    });
  }

  it('keeps the last 4 of every SSN as XXX-XX-#### on the page', async () => {
    const r = await redactBuffer(fx.read('text_layer.pdf'), { filename: 'text_layer.pdf', mode: 'enforce' });
    const out = inspectPdf(r.buffer, { ocr: false });
    expect(lastFourKept(out.surfaces, 'ssn1')).toBe(true);
    expect(lastFourKept(out.surfaces, 'ssn2')).toBe(true);
  });

  it('leaves negative controls (invoice no., phone, EIN, amount, filing date, current-year AGI) in place', async () => {
    const r = await redactBuffer(fx.read('text_layer.pdf'), { filename: 'text_layer.pdf', mode: 'enforce' });
    const out = inspectPdf(r.buffer, { ocr: false });
    expect(negativesPresent(out.surfaces, fx.manifest['text_layer.pdf'].negatives)).toEqual([]);
  });

  it('real redaction, not an overlay: the redacted text layer cannot be recovered (image-only page is rasterized-and-blacked-out)', async () => {
    const r = await redactBuffer(fx.read('image_only.pdf'), { filename: 'image_only.pdf', mode: 'enforce' });
    const out = inspectAll(r.buffer);
    expect(allLeaks({ ocr: out.surfaces.ocr, ocr_alt: out.surfaces.ocr_alt, text: out.surfaces.text, raw: out.surfaces.raw, filebytes: out.surfaces.filebytes })).toEqual([]);
  });

  it('SSN repeated in the footer of all 5 pages is masked on every page', async () => {
    const r = await redactBuffer(fx.read('footer_every_page.pdf'), { filename: 'footer_every_page.pdf', mode: 'enforce' });
    const out = inspectPdf(r.buffer, { ocr: false });
    expect(out.pages).toBe(5);
    for (const pageText of out.surfaces.text) expect(allLeaks({ text: [pageText] })).toEqual([]);
  });

  it('[Opus D6/H1] AcroForm fields carrying PII are DELETED (value, /DV default, hidden appearance stream) — not blanked', async () => {
    const r = await redactBuffer(fx.read('acroform_full.pdf'), { filename: 'acroform_full.pdf', mode: 'enforce' });
    expect(r.outcome).toBe('redacted');
    const out = inspectPdf(r.buffer, { ocr: false });
    expect(out.surfaces.widgets.filter((w) => /taxpayer_ssn/.test(w))).toEqual([]);
    expect(allLeaks({ objects: out.surfaces.objects, filebytes: out.surfaces.filebytes }, ['ssn1', 'ssn2'])).toEqual([]);
  });
});

describe('[Opus D3/C3] OCR is not trusted alone: pixel ground truth', () => {
  it('comb-field SSN (boxed digits tesseract cannot read): first-5 digit boxes are UNIFORM in the output (ink gone), or the file is held', async () => {
    const input = fx.read('comb_ssn_image.pdf');
    const r = await redactBuffer(input, { filename: 'comb_ssn_image.pdf', mode: 'enforce' });
    expect(['redacted', 'held']).toContain(r.outcome);
    if (r.outcome === 'held') { expect(r.buffer).toBeUndefined(); return; }
    for (const t of fx.manifest['comb_ssn_image.pdf'].pixel_truth) {
      const st = regionStats(r.buffer, { kind: 'pdf', ...t });
      expect(st.std, `digit box ${JSON.stringify(t.rect)} still shows strokes`).toBeLessThan(8);
    }
  });

  it('the verifier rejects a page with an SSN label but no located value (masked or unmasked) in its window', async () => {
    const v = await verifyRedacted(fx.read('comb_ssn_image.pdf'), { filename: 'comb_ssn_image.pdf' });
    expect(v.ok).toBe(false);
    expect(v.residual.map((x) => x.surface)).toContain('ocr_label_without_value');
  });

  it('[Opus D6/C5] an image pasted on a TEXT page is OCR\'d and redacted (the page has a text layer, so "OCR image-only pages" is not enough)', async () => {
    const r = await redactBuffer(fx.read('image_on_text_page.pdf'), { filename: 'image_on_text_page.pdf', mode: 'enforce' });
    expect(r.outcome).toBe('redacted');
    const out = inspectAll(r.buffer);
    expect(allLeaks({ ocr: out.surfaces.ocr, ocr_alt: out.surfaces.ocr_alt }, ['ssn1'])).toEqual([]);
  });
});

describe('clean documents, idempotence, determinism', () => {
  it('a PDF with nothing to redact on ANY surface (raw bytes included) comes back as "clean" with the IDENTICAL bytes', async () => {
    const input = fx.read('clean.pdf');
    const r = await redactBuffer(input, { filename: 'clean.pdf', mode: 'enforce' });
    expect(r.outcome).toBe('clean');
    expect(Buffer.compare(r.buffer, input)).toBe(0);
  });

  for (const name of ['incremental_history.pdf', 'orphan_after_redact.pdf', 'objstm.pdf', 'js_action.pdf', 'xfa.pdf', 'custom_info_key.pdf', 'link_labels_fileannot.pdf']) {
    it(`[Opus D2] ${name}: VISIBLE text is clean but the bytes are not — never passed through as "clean"/identical`, async () => {
      const input = fx.read(name);
      const r = await redactBuffer(input, { filename: name, mode: 'enforce' });
      expect(r.outcome).not.toBe('clean');
      if (r.outcome === 'redacted') {
        expect(Buffer.compare(r.buffer, input)).not.toBe(0);
        const out = inspectPdf(r.buffer, { ocr: false });
        expect(allLeaks(out.surfaces, fx.manifest[name].secrets)).toEqual([]);
        expectNoDeadData(out, name);
      } else {
        expect(r.outcome).toBe('held');
      }
    });
  }

  it('redacting an already-redacted document is a no-op (clean, identical bytes)', async () => {
    const first = await redactBuffer(fx.read('text_layer.pdf'), { filename: 'text_layer.pdf', mode: 'enforce' });
    expect(first.outcome).toBe('redacted');
    const second = await redactBuffer(first.buffer, { filename: 'text_layer.pdf', mode: 'enforce' });
    expect(second.outcome).toBe('clean');
    expect(Buffer.compare(second.buffer, first.buffer)).toBe(0);
  });

  it('[Sonnet M6] re-redacting a redacted IMAGE-ONLY pdf (masked XXX now in pixels) is clean', async () => {
    const first = await redactBuffer(fx.read('image_only.pdf'), { filename: 'image_only.pdf', mode: 'enforce' });
    expect(first.outcome).toBe('redacted');
    const second = await redactBuffer(first.buffer, { filename: 'image_only.pdf', mode: 'enforce' });
    expect(second.outcome).toBe('clean');
  });

  it('[Opus D17/M1] output is byte-deterministic: the same input redacted twice gives identical bytes (content-addressed envelope ids must not duplicate)', async () => {
    for (const name of ['text_layer.pdf', 'image_only.pdf', 'acroform_full.pdf']) {
      const a = await redactBuffer(fx.read(name), { filename: name, mode: 'enforce' });
      const b = await redactBuffer(fx.read(name), { filename: name, mode: 'enforce' });
      expect(Buffer.compare(a.buffer, b.buffer), name).toBe(0);
    }
  });

  it('never mutates the caller\'s input buffer', async () => {
    const input = Buffer.from(fx.read('text_layer.pdf'));
    const snapshot = Buffer.from(input);
    await redactBuffer(input, { filename: 'text_layer.pdf', mode: 'enforce' });
    expect(Buffer.compare(input, snapshot)).toBe(0);
  });
});

describe('fail closed: anything not redactable AND verifiable is HELD', () => {
  it('encrypted PDF -> held:encrypted, no buffer', async () => {
    const r = await redactBuffer(fx.read('encrypted.pdf'), { filename: 'encrypted.pdf', mode: 'enforce' });
    expect(r).toMatchObject({ outcome: 'held', reason: 'encrypted' });
    expect(r.buffer).toBeUndefined();
  });

  it('corrupt PDF -> held:corrupt, no buffer', async () => {
    const r = await redactBuffer(fx.read('corrupt.pdf'), { filename: 'corrupt.pdf', mode: 'enforce' });
    expect(r).toMatchObject({ outcome: 'held', reason: 'corrupt' });
    expect(r.buffer).toBeUndefined();
  });

  it('verification failure (injected verifier reports a residual) -> held:verify_failed, no buffer', async () => {
    const r = await redactBuffer(fx.read('text_layer.pdf'), {
      filename: 'text_layer.pdf',
      mode: 'enforce',
      deps: { verify: async () => ({ ok: false, residual: [{ kind: 'ssn', surface: 'text' }] }) },
    });
    expect(r).toMatchObject({ outcome: 'held', reason: 'verify_failed' });
    expect(r.buffer).toBeUndefined();
  });

  it('[Sonnet C4] the verifier is INDEPENDENT of the detector: with a detector that finds nothing, the file is held verify_failed — never "clean"', async () => {
    for (const name of ['text_layer.pdf', 'unicode_dashes.pdf', 'split_spans.pdf']) {
      const r = await redactBuffer(fx.read(name), { filename: name, mode: 'enforce', deps: { detect: () => [] } });
      expect(r, name).toMatchObject({ outcome: 'held', reason: 'verify_failed' });
    }
  });

  it('image pages with local OCR unavailable -> held:ocr_unavailable (image-only AND image-on-text pages)', async () => {
    for (const name of ['image_only.pdf', 'image_on_text_page.pdf']) {
      const r = await redactBuffer(fx.read(name), {
        filename: name,
        mode: 'enforce',
        deps: { ocr: async () => { throw new Error('tesseract missing'); } },
      });
      expect(r, name).toMatchObject({ outcome: 'held', reason: 'ocr_unavailable' });
    }
  });

  it('[Sonnet M9] over a resource limit -> held:too_large (page count), never partially processed', async () => {
    const r = await redactBuffer(fx.read('footer_every_page.pdf'), { filename: 'f.pdf', mode: 'enforce', limits: { maxPages: 3 } });
    expect(r).toMatchObject({ outcome: 'held', reason: 'too_large' });
    expect(r.buffer).toBeUndefined();
  });

  it('[Sonnet M9, Opus M3] engine hang -> held:engine_error within the timeout, child reaped', async () => {
    const t0 = Date.now();
    const r = await redactBuffer(fx.read('text_layer.pdf'), {
      filename: 'text_layer.pdf', mode: 'enforce',
      deps: { engineCmd: ['python3', '-c', 'import time; time.sleep(60)'], engineTimeoutMs: 1500 },
    });
    expect(r).toMatchObject({ outcome: 'held', reason: 'engine_error' });
    expect(Date.now() - t0).toBeLessThan(15_000);
  }, 30_000);

  it('[Opus D19/M3, Sonnet H8] engine crash that prints the SSN (and the filename) to stderr -> held:engine_error; result/report carry neither', async () => {
    const r = await redactBuffer(fx.read('text_layer.pdf'), {
      filename: 'Jane Q Tester 123-45-6789.pdf', mode: 'enforce',
      deps: { engineCmd: ['python3', '-c', `import sys; sys.stderr.write("Traceback: value ${SECRETS.ssn1.text} in Jane Q Tester 123-45-6789.pdf\\n"); sys.exit(1)`] },
    });
    expect(r).toMatchObject({ outcome: 'held', reason: 'engine_error' });
    const s = JSON.stringify({ ...r, buffer: undefined });
    expect(s).not.toMatch(/123-45-6789|123456789|Jane|Tester/);
  });

  it('an unrecognized binary (not a sanitizable type) is held:unsupported if it contains a PII pattern in ANY decoding (latin1, UTF-16LE/BE); otherwise clean', async () => {
    const withSsn = await redactBuffer(Buffer.concat([Buffer.from([0, 1, 2, 3]), Buffer.from('SSN 123-45-6789'), Buffer.from([4, 5])]), { filename: 'blob.bin', mode: 'enforce' });
    expect(withSsn).toMatchObject({ outcome: 'held', reason: 'unsupported' });
    const utf16 = await redactBuffer(fx.read('blob_utf16.bin'), { filename: 'blob.bin', mode: 'enforce' });
    expect(utf16).toMatchObject({ outcome: 'held', reason: 'unsupported' });
    const without = await redactBuffer(Buffer.from([0, 1, 2, 3, 4, 5]), { filename: 'blob.bin', mode: 'enforce' });
    expect(without.outcome).toBe('clean');
  });
});

describe('verifyRedacted (the engine\'s own verifier, checked against the independent inspector)', () => {
  it('flags every secret fixture as NOT ok — incl. the round-2 ones whose secret is only in raw bytes / hidden objects', async () => {
    for (const name of [
      'text_layer.pdf', 'hidden_ocg.pdf', 'metadata.pdf', 'embedded.pdf', 'acroform.pdf', 'annots_toc.pdf',
      'incremental_history.pdf', 'orphan_after_redact.pdf', 'objstm.pdf', 'form_xobject.pdf', 'acroform_full.pdf',
      'image_on_text_page.pdf', 'js_action.pdf', 'xfa.pdf', 'custom_info_key.pdf', 'link_labels_fileannot.pdf', 'unicode_dashes.pdf', 'split_spans.pdf',
    ]) {
      const v = await verifyRedacted(fx.read(name), { filename: name });
      expect(v.ok, name).toBe(false);
      expect(v.residual.length, name).toBeGreaterThan(0);
    }
  });
  it('passes the clean fixture', async () => {
    const v = await verifyRedacted(fx.read('clean.pdf'), { filename: 'clean.pdf' });
    expect(v).toEqual({ ok: true, residual: [] });
  });
  it('residual entries carry kind + surface only (no matched text, no digits)', async () => {
    const v = await verifyRedacted(fx.read('text_layer.pdf'), { filename: 'text_layer.pdf' });
    for (const r of v.residual) expect(Object.keys(r).sort()).toEqual(['kind', 'surface']);
    expect(privateDigitsIn(v)).toEqual([]);
  });
});
