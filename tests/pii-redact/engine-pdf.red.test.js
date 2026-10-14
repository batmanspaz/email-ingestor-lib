// P0 RED — PDF redaction engine contract (redactBuffer / verifyRedacted).
// Independent verification: outputs are inspected with tests/pii-redact/support/inspect_pdf.py + local tesseract,
// never with the engine's own verifier. Expected at the end of Phase 0: all fail with E_NOT_IMPLEMENTED.
import { describe, it, expect, beforeAll } from 'vitest';
import { redactBuffer, verifyRedacted } from '../../pii-redact.js';
import { buildFixtures, inspectPdf, leaks, negativesPresent, lastFourKept } from './support/harness.mjs';

let fx;
beforeAll(() => { fx = buildFixtures(); }, 120_000);

const REDACTABLE = [
  'text_layer.pdf', 'image_only.pdf', 'mixed.pdf', 'acroform.pdf', 'metadata.pdf', 'embedded.pdf', 'annots_toc.pdf',
  'hidden_ocg.pdf', 'white_on_white.pdf', 'footer_every_page.pdf', 'split_spans.pdf', 'unicode_dashes.pdf',
];

describe('every surface is scrubbed (enforce mode)', () => {
  for (const name of REDACTABLE) {
    it(`${name}: no secret survives on ANY surface (text, raw streams, metadata, xmp, widgets, annots, toc, embedded, local OCR)`, async () => {
      const input = fx.read(name);
      const r = await redactBuffer(input, { filename: name, mode: 'enforce' });
      expect(r.outcome).toBe('redacted');
      const out = inspectPdf(r.buffer, { ocr: true });
      expect(out.ok).toBe(true);
      expect(leaks(out.surfaces, fx.manifest[name].secrets)).toEqual([]);
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
    const out = inspectPdf(r.buffer, { ocr: true });
    expect(leaks({ ocr: out.surfaces.ocr, text: out.surfaces.text, raw: out.surfaces.raw })).toEqual([]);
  });

  it('SSN repeated in the footer of all 5 pages is masked on every page', async () => {
    const r = await redactBuffer(fx.read('footer_every_page.pdf'), { filename: 'footer_every_page.pdf', mode: 'enforce' });
    const out = inspectPdf(r.buffer, { ocr: false });
    expect(out.pages).toBe(5);
    for (const pageText of out.surfaces.text) expect(leaks({ text: [pageText] })).toEqual([]);
  });
});

describe('clean documents and idempotence', () => {
  it('a PDF with nothing to redact comes back as "clean" with the IDENTICAL bytes', async () => {
    const input = fx.read('clean.pdf');
    const r = await redactBuffer(input, { filename: 'clean.pdf', mode: 'enforce' });
    expect(r.outcome).toBe('clean');
    expect(Buffer.compare(r.buffer, input)).toBe(0);
  });

  it('redacting an already-redacted document is a no-op (clean, identical bytes)', async () => {
    const first = await redactBuffer(fx.read('text_layer.pdf'), { filename: 'text_layer.pdf', mode: 'enforce' });
    expect(first.outcome).toBe('redacted');
    const second = await redactBuffer(first.buffer, { filename: 'text_layer.pdf', mode: 'enforce' });
    expect(second.outcome).toBe('clean');
    expect(Buffer.compare(second.buffer, first.buffer)).toBe(0);
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

  it('image-only PDF with local OCR unavailable -> held:ocr_unavailable (never falls back to a remote model)', async () => {
    const remote = [];
    const r = await redactBuffer(fx.read('image_only.pdf'), {
      filename: 'image_only.pdf',
      mode: 'enforce',
      deps: { ocr: async () => { throw new Error('tesseract missing'); }, remoteOcr: async (...a) => { remote.push(a); return ''; } },
    });
    expect(r).toMatchObject({ outcome: 'held', reason: 'ocr_unavailable' });
    expect(remote).toHaveLength(0);
  });

  it('an unrecognized binary (not pdf/office/text/zip) is held:unsupported only if it contains an SSN pattern in raw bytes; otherwise clean', async () => {
    const withSsn = await redactBuffer(Buffer.concat([Buffer.from([0, 1, 2, 3]), Buffer.from('SSN 123-45-6789'), Buffer.from([4, 5])]), { filename: 'blob.bin', mode: 'enforce' });
    expect(withSsn).toMatchObject({ outcome: 'held', reason: 'unsupported' });
    const without = await redactBuffer(Buffer.from([0, 1, 2, 3, 4, 5]), { filename: 'blob.bin', mode: 'enforce' });
    expect(without.outcome).toBe('clean');
  });
});

describe('verifyRedacted (the engine\'s own verifier, checked against the independent inspector)', () => {
  it('flags every secret fixture as NOT ok (finds the same surfaces the independent inspector sees)', async () => {
    for (const name of ['text_layer.pdf', 'hidden_ocg.pdf', 'metadata.pdf', 'embedded.pdf', 'acroform.pdf', 'annots_toc.pdf']) {
      const v = await verifyRedacted(fx.read(name), { filename: name });
      expect(v.ok, name).toBe(false);
      expect(v.residual.length, name).toBeGreaterThan(0);
    }
  });
  it('passes the clean fixture', async () => {
    const v = await verifyRedacted(fx.read('clean.pdf'), { filename: 'clean.pdf' });
    expect(v).toEqual({ ok: true, residual: [] });
  });
  it('residual entries carry kind + surface only (no matched text)', async () => {
    const v = await verifyRedacted(fx.read('text_layer.pdf'), { filename: 'text_layer.pdf' });
    for (const r of v.residual) expect(Object.keys(r).sort()).toEqual(['kind', 'surface']);
  });
});
