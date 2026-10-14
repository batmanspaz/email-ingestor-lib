// GREEN by design (positive controls). These prove the P0 harness is real: the synthetic fixtures leak where they
// should and the independent inspector can see it. If these ever go red, the RED suites below are meaningless.
import { describe, it, expect, beforeAll } from 'vitest';
import { buildFixtures, inspectPdf, leaks, negativesPresent, SECRETS } from './support/harness.mjs';

let fx;
beforeAll(() => { fx = buildFixtures(); }, 120_000);

const PDF_WITH_TEXT = ['text_layer.pdf', 'footer_every_page.pdf', 'split_spans.pdf', 'unicode_dashes.pdf', 'white_on_white.pdf'];

describe('fixture generator (positive controls)', () => {
  it('writes every fixture named in the manifest', () => {
    expect(fx.names.length).toBeGreaterThanOrEqual(20);
    for (const n of fx.names) expect(fx.read(n).length, n).toBeGreaterThan(0);
  });

  it('every fake value is obviously synthetic (no real data in the harness)', () => {
    expect(SECRETS.ssn1.text).toBe('123-45-6789');
    for (const s of Object.values(SECRETS)) expect(s.text).toBeTruthy();
  });

  for (const name of PDF_WITH_TEXT) {
    it(`inspector sees the text-layer secret in ${name}`, () => {
      const r = inspectPdf(fx.read(name), { ocr: false });
      expect(r.ok).toBe(true);
      const hit = leaks(r.surfaces, fx.manifest[name].secrets);
      expect([...new Set(hit.map((h) => h.key))].sort()).toEqual([...new Set(fx.manifest[name].secrets)].sort());
    });
  }

  it('inspector sees every secret of the full text-layer fixture and the negative controls survive', () => {
    const r = inspectPdf(fx.read('text_layer.pdf'), { ocr: false });
    expect(new Set(leaks(r.surfaces).map((h) => h.key))).toEqual(new Set(['ssn1', 'ssn2', 'itin', 'routing', 'account', 'dob', 'pin', 'agi', 'dl']));
    expect(negativesPresent(r.surfaces, fx.manifest['text_layer.pdf'].negatives)).toEqual([]);
  });

  it('image-only PDF has NO text layer but local OCR still reads the secrets', () => {
    const r = inspectPdf(fx.read('image_only.pdf'), { ocr: true });
    expect(r.surfaces.text.join('').trim()).toBe('');
    const hit = new Set(leaks({ ocr: r.surfaces.ocr }).map((h) => h.key));
    for (const k of ['ssn1', 'ssn2', 'itin', 'routing', 'account']) expect(hit.has(k), k).toBe(true);
  });

  it('hidden-layer text is visible to the inspector via decoded content streams', () => {
    const r = inspectPdf(fx.read('hidden_ocg.pdf'), { ocr: false });
    expect(leaks({ raw: r.surfaces.raw }).map((h) => h.key)).toContain('ssn1');
  });

  it('non-text surfaces leak where designed: widget, metadata, xmp, embedded file, annotations, bookmarks', () => {
    const bySurface = {
      'acroform.pdf': 'widgets', 'metadata.pdf': 'metadata', 'embedded.pdf': 'embedded', 'annots_toc.pdf': 'annots',
    };
    for (const [n, surf] of Object.entries(bySurface)) {
      const r = inspectPdf(fx.read(n), { ocr: false });
      expect(leaks({ [surf]: r.surfaces[surf] }).length, `${n}/${surf}`).toBeGreaterThan(0);
    }
    expect(leaks({ xmp: inspectPdf(fx.read('metadata.pdf'), { ocr: false }).surfaces.xmp }).length).toBeGreaterThan(0);
    expect(leaks({ toc: inspectPdf(fx.read('annots_toc.pdf'), { ocr: false }).surfaces.toc }).length).toBeGreaterThan(0);
  });

  it('encrypted and corrupt fixtures are reported (not raised) by the inspector', () => {
    expect(inspectPdf(fx.read('encrypted.pdf'), { ocr: false })).toMatchObject({ ok: false, encrypted: true });
    expect(inspectPdf(fx.read('corrupt.pdf'), { ocr: false })).toMatchObject({ ok: false, encrypted: false });
  });

  it('clean.pdf carries only negative controls and no secret', () => {
    const r = inspectPdf(fx.read('clean.pdf'), { ocr: false });
    expect(leaks(r.surfaces)).toEqual([]);
    expect(negativesPresent(r.surfaces, fx.manifest['clean.pdf'].negatives)).toEqual([]);
  });
});
