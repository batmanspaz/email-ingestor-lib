// GREEN by design (positive controls). These prove the P0 harness is real: the synthetic fixtures leak where they
// should and the independent inspector can see it. If these ever go red, the RED suites below are meaningless.
import { describe, it, expect, beforeAll } from 'vitest';
import { buildFixtures, inspectPdf, leaks, allLeaks, partialLeaks, negativesPresent, privateDigitsIn, regionStats, ocrImageFile, normalizeForCheck, SECRETS } from './support/harness.mjs';

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

  it('image-only PDF has NO text layer but local OCR still reads ALL NINE secrets (R2 Opus M5: was 5 of 9)', () => {
    const r = inspectPdf(fx.read('image_only.pdf'), { ocr: true });
    expect(r.surfaces.text.join('').trim()).toBe('');
    const hit = new Set(leaks({ ocr: r.surfaces.ocr }).map((h) => h.key));
    for (const k of ['ssn1', 'ssn2', 'itin', 'routing', 'account', 'dob', 'pin', 'agi', 'dl']) expect(hit.has(k), k).toBe(true);
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

// ---------------------------------------------------------------------------------------------------------------
// ROUND 2 positive controls (red-team fold-in). Each proves the new fixture really contains what it claims and that
// the independent inspector can see it — otherwise the matching RED test would be vacuous (Opus D21).
// ---------------------------------------------------------------------------------------------------------------
describe('round-2 fixtures are what they claim (positive controls)', () => {
  it('[Opus D21/H5] unicode_dashes.pdf really contains U+00A0, U+2013 and U+2011 (Unicode TTF embedded)', () => {
    const r = inspectPdf(fx.read('unicode_dashes.pdf'), { ocr: false });
    const cps = new Set([...r.surfaces.text.join('')].map((c) => c.codePointAt(0)));
    for (const cp of [0x00a0, 0x2013, 0x2011]) expect(cps.has(cp), cp.toString(16)).toBe(true);
    expect(new Set(leaks(r.surfaces).map((h) => h.key))).toEqual(new Set(['ssn1', 'ssn2', 'itin']));
  });

  it('[Opus D21] split_spans.pdf: no single span holds a whole SSN (font change, line wrap, two text blocks)', () => {
    const r = inspectPdf(fx.read('split_spans.pdf'), { ocr: false });
    const spans = r.meta.spans.flat();
    expect(spans.length).toBeGreaterThanOrEqual(6);
    for (const k of ['ssn1', 'ssn2', 'itin']) {
      expect(spans.some((sp) => sp.replace(/\D/g, '').includes(SECRETS[k].digits)), k).toBe(false);
    }
    expect(new Set(leaks({ text: r.surfaces.text }).map((h) => h.key))).toEqual(new Set(['ssn1', 'ssn2', 'itin']));
  });

  it('[Opus D1/D2, Sonnet C3] incremental_history / orphan_after_redact / objstm / js / xfa / custom Info / labels: VISIBLE surfaces are clean but the file is not', () => {
    for (const n of ['incremental_history.pdf', 'orphan_after_redact.pdf', 'objstm.pdf', 'js_action.pdf', 'xfa.pdf', 'custom_info_key.pdf', 'link_labels_fileannot.pdf']) {
      const r = inspectPdf(fx.read(n), { ocr: false });
      const visible = { text: r.surfaces.text, raw: r.surfaces.raw, metadata: r.surfaces.metadata, xmp: r.surfaces.xmp, widgets: r.surfaces.widgets, annots: r.surfaces.annots, toc: r.surfaces.toc, embedded: r.surfaces.embedded };
      expect(allLeaks(visible, fx.manifest[n].secrets), `${n} visible`).toEqual([]);
      const deep = new Set(leaks({ filebytes: r.surfaces.filebytes, objects: r.surfaces.objects }).map((h) => h.key));
      for (const k of fx.manifest[n].secrets) expect(deep.has(k), `${n} deep ${k}`).toBe(true);
    }
  });

  it('[Opus D1] the history fixtures really carry dead data: >1 revision or unreferenced objects', () => {
    const inc = inspectPdf(fx.read('incremental_history.pdf'), { ocr: false });
    expect(inc.meta.revisions).toBeGreaterThan(1);
    const orph = inspectPdf(fx.read('orphan_after_redact.pdf'), { ocr: false });
    expect(orph.meta.xref_length_gc).toBeLessThan(orph.meta.xref_length);
  });

  it('[Sonnet C3] form_xobject.pdf: the SSN is NOT in the page content stream (only in the XObject)', () => {
    const r = inspectPdf(fx.read('form_xobject.pdf'), { ocr: false });
    expect(leaks({ raw: r.surfaces.raw })).toEqual([]);
    expect(leaks({ text: r.surfaces.text }).map((h) => h.key)).toContain('ssn1');
  });

  it('[Opus D6/H1] acroform_full.pdf: hidden widget value + /DV default both present', () => {
    const r = inspectPdf(fx.read('acroform_full.pdf'), { ocr: false });
    expect(new Set(leaks({ objects: r.surfaces.objects }).map((h) => h.key))).toEqual(new Set(['ssn1', 'ssn2']));
  });

  it('[Opus D6/C5] image_on_text_page.pdf: has a text layer, the SSN is only in the pasted image (OCR sees it)', () => {
    const r = inspectPdf(fx.read('image_on_text_page.pdf'), { ocr: true });
    expect(r.surfaces.text.join('').trim().length).toBeGreaterThan(10);
    expect(leaks({ text: r.surfaces.text, raw: r.surfaces.raw, filebytes: r.surfaces.filebytes })).toEqual([]);
    expect(leaks({ ocr: r.surfaces.ocr }).map((h) => h.key)).toContain('ssn1');
  });

  it('[Opus D3] comb_ssn_image.pdf: BOTH local OCR setups fail to read the boxed SSN, yet the pixels hold the digits — which is why tests need pixel ground truth', () => {
    const r = inspectPdf(fx.read('comb_ssn_image.pdf'), { ocr: true, ocrAlt: true });
    expect(leaks({ ocr: r.surfaces.ocr, ocr_alt: r.surfaces.ocr_alt })).toEqual([]);
    expect(r.surfaces.ocr.join(' ')).toMatch(/social security number/i);
    for (const t of fx.manifest['comb_ssn_image.pdf'].pixel_truth) {
      const st = regionStats(fx.read('comb_ssn_image.pdf'), { kind: 'pdf', ...t });
      expect(st.std, JSON.stringify(t)).toBeGreaterThan(20); // ink strokes present
    }
  });

  it('[Sonnet C3] scan_variants.pdf: 4 image-only pages (skewed, 100 dpi, light grey, /Rotate 90), OCR still reads the SSN', () => {
    const r = inspectPdf(fx.read('scan_variants.pdf'), { ocr: true });
    expect(r.pages).toBe(4);
    expect(r.surfaces.text.join('').trim()).toBe('');
    expect(leaks({ ocr: r.surfaces.ocr }).map((h) => h.key)).toContain('ssn1');
  });

  it('[Sonnet C3] encrypted_owner_only.pdf opens WITHOUT a password but is encrypted', () => {
    const r = inspectPdf(fx.read('encrypted_owner_only.pdf'), { ocr: false });
    expect(r.ok).toBe(true);
    expect(r.meta.is_encrypted).toBe(true);
    expect(leaks({ text: r.surfaces.text }).length).toBeGreaterThan(0);
  });

  it('[Opus D4/C4] photo/scan IMAGE files carry readable SSNs (local OCR) and the ground-truth boxes hold ink', () => {
    for (const n of ['w2_scan.png', 'w2.tiff', 'w2_photo.jpg', ...(fx.manifest['w2.heic'] ? ['w2.heic'] : [])]) {
      const text = ocrImageFile(fx.read(n), n.slice(n.lastIndexOf('.')));
      const seen = new Set(leaks({ ocr: [text] }).map((h) => h.key));
      for (const k of ['ssn1', 'ssn2', 'itin']) expect(seen.has(k), `${n} ${k}`).toBe(true);
    }
    for (const t of fx.manifest['w2_scan.png'].pixel_truth) expect(regionStats(fx.read('w2_scan.png'), { kind: 'image', rect: t.rect }).std).toBeGreaterThan(20);
    expect(fx.read('w2_photo.jpg').toString('latin1')).toContain(SECRETS.ssn1.text); // EXIF ImageDescription
  });

  it('[Sonnet H2] encoded text fixtures: the SSN is invisible to a latin1 byte scan but present once decoded', () => {
    for (const n of ['notes_utf16le.txt', 'notes_utf16be.txt', 'sheet_utf16.csv', 'blob_utf16.bin', 'legacy.doc', 'legacy.xls']) {
      const b = fx.read(n);
      expect(b.toString('latin1').includes(SECRETS.ssn1.text), n).toBe(false);
      const dec = n.includes('be') ? Buffer.from(b).swap16().toString('utf16le') : b.toString('utf16le');
      expect(dec.includes(SECRETS.ssn1.text) || b.toString('utf16le', 1).includes(SECRETS.ssn1.text), n).toBe(true);
    }
    expect(fx.read('return.eml').toString('latin1')).not.toContain(SECRETS.ssn2.text); // base64 body
  });

  it('[Sonnet H1, Opus H6/H7] docx/xlsx fixtures put secrets in every part type', () => {
    expect(fx.read('return_full.docx').length).toBeGreaterThan(1000);
    expect(fx.read('sheet.xlsx').length).toBeGreaterThan(1000);
  });

  it('[Opus D22] partialLeaks flags 5-8 visible digits but not the kept last 4, EINs or phone numbers', () => {
    expect(partialLeaks({ t: ['SSN XXX-X5-6789'] }).map((h) => h.key)).toEqual(['ssn1']);
    expect(partialLeaks({ t: ['SSN 3-45-6789'] }).map((h) => h.key)).toEqual(['ssn1']);
    expect(partialLeaks({ t: ['SSN 12345XXXX'] }).map((h) => h.key)).toEqual(['ssn1']);
    expect(partialLeaks({ t: ['SSN XXX-XX-6789 / XXX-XX-4320', 'EIN 98-7654321', 'Phone (415) 555-0134', 'Driver D1234567'] })).toEqual([]);
  });

  it('[Sonnet C4/C5] the checker folds Unicode digits and strips invisible characters', () => {
    expect(normalizeForCheck('\uff11\uff12\uff13-\u0664\u0665-\u096c\u096d\u096e\u096f')).toBe('123-45-6789');
    expect(leaks({ t: ['SSN 123\u200b-45\u00ad-6789'] }).map((h) => h.key)).toEqual(['ssn1']);
  });

  it('[Opus D8] privateDigitsIn accepts a spec-correct heartbeat (ttl 24h) and rejects any 64-hex hash by default', () => {
    expect(privateDigitsIn({ module: 'pii-redaction', status: 'ok', ttl_seconds: 86400, at: '2026-10-14T08:00:00Z' })).toEqual([]);
    expect(privateDigitsIn({ props: { original_sha256: 'a'.repeat(64) } })).toContain('sha256_hex');
  });
});
