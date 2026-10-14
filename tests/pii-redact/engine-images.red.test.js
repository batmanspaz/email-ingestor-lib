// P0 RED (round 2) — IMAGE FILES. [Opus D4/C4, Sonnet H2]
// Today the document-drop producer sends .jpg/.jpeg/.png/.tiff/.heic straight to Claude vision (ocrImage). The
// round-1 contract had no image path at all, and its "unknown binary is clean unless ASCII SSN" rule made a photo of a
// W-2 'clean'. Contract: an image is redacted (local OCR -> pixel blackout of at least the first 5 SSN digits, EXIF/
// metadata stripped) or HELD. Never 'clean' when it shows a secret. Expected at the end of Phase 0: E_NOT_IMPLEMENTED.
import { describe, it, expect, beforeAll } from 'vitest';
import { redactBuffer } from '../../pii-redact.js';
import { buildFixtures, allLeaks, regionStats, ocrImageFile, probeImage, SECRETS } from './support/harness.mjs';

let fx;
beforeAll(() => { fx = buildFixtures(); }, 120_000);

const IMAGES = () => ['w2_scan.png', 'w2.tiff', 'w2_photo.jpg', ...(fx.manifest['w2.heic'] ? ['w2.heic'] : [])];
const extOf = (n) => n.slice(n.lastIndexOf('.'));

describe('image files are never "clean" when they show a secret', () => {
  it('every image fixture -> redacted or held; [Fable M1 success floor] the plain scans (png, tiff) MUST be redacted', async () => {
    for (const name of IMAGES()) {
      const r = await redactBuffer(fx.read(name), { filename: name, mode: 'enforce' });
      if (['w2_scan.png', 'w2.tiff'].includes(name)) expect(r.outcome, name).toBe('redacted');
      else expect(['redacted', 'held'], name).toContain(r.outcome);
    }
  });

  it('redacted images: local OCR of the output finds no SSN-class value (full or partial)', async () => {
    for (const name of IMAGES()) {
      const r = await redactBuffer(fx.read(name), { filename: name, mode: 'enforce' });
      if (r.outcome !== 'redacted') continue;
      const text = ocrImageFile(r.buffer, extOf(name));
      expect(allLeaks({ ocr: [text] }, ['ssn1', 'ssn2', 'itin', 'routing', 'account']), name).toEqual([]);
    }
  });

  it('redacted images: the generator-recorded SSN boxes (first 5 digits) are uniform — ink removed, not just OCR-invisible', async () => {
    for (const name of ['w2_scan.png', 'w2.tiff']) {
      const r = await redactBuffer(fx.read(name), { filename: name, mode: 'enforce' });
      if (r.outcome !== 'redacted') continue;
      for (const t of fx.manifest[name].pixel_truth) {
        expect(regionStats(r.buffer, { kind: 'image', rect: t.rect }).std, `${name} ${t.rect}`).toBeLessThan(8);
      }
    }
  });

  it('EXIF / metadata carrying an SSN is stripped (jpg ImageDescription)', async () => {
    const r = await redactBuffer(fx.read('w2_photo.jpg'), { filename: 'w2_photo.jpg', mode: 'enforce' });
    expect(['redacted', 'held']).toContain(r.outcome);
    if (r.outcome === 'redacted') {
      const raw = r.buffer.toString('latin1');
      expect(raw.includes(SECRETS.ssn1.text)).toBe(false);
      expect(raw.replace(/\D/g, '').includes(SECRETS.ssn1.digits)).toBe(false);
    }
  });

  it('local OCR unavailable -> held:ocr_unavailable (never falls through to the remote vision model)', async () => {
    const r = await redactBuffer(fx.read('w2_scan.png'), { filename: 'w2_scan.png', mode: 'enforce', deps: { ocr: async () => { throw new Error('tesseract missing'); } } });
    expect(r).toMatchObject({ outcome: 'held', reason: 'ocr_unavailable' });
  });

  it('a photo with no private number is clean (identical bytes) — the rule is "never clean WITH a secret", not "hold every image"', async () => {
    const { execFileSync } = await import('node:child_process');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-cleanimg-'));
    const p = path.join(d, 'c.png');
    execFileSync('python3', ['-c', `import fitz; d=fitz.open(); pg=d.new_page(width=300,height=80); pg.insert_text((10,40),"Grocery receipt total $12.34",fontsize=14); pg.get_pixmap(dpi=150).save(${JSON.stringify(p)})`]);
    const input = fs.readFileSync(p);
    const r = await redactBuffer(input, { filename: 'c.png', mode: 'enforce' });
    expect(r.outcome).toBe('clean');
    expect(Buffer.compare(r.buffer, input)).toBe(0);
    fs.rmSync(d, { recursive: true, force: true });
  });
});

describe('[Fable M2] secondary payloads inside image containers', () => {
  const secretsIn = (text, keys) => allLeaks({ t: [text] }, keys).map((h) => h.key);

  it('clean pixels + SSN only in EXIF ImageDescription: never "clean"/identical; redacted output has no APP1/EXIF and no secret', async () => {
    const input = fx.read('clean_pixels_exif_ssn.jpg');
    const r = await redactBuffer(input, { filename: 'c.jpg', mode: 'enforce' });
    expect(r.outcome).not.toBe('clean');
    if (r.outcome !== 'redacted') return;
    const p = probeImage(r.buffer, '.jpg');
    expect(p.jpeg_app.filter((a) => a !== 'e0')).toEqual([]);
    expect(secretsIn(p.metadata_text + r.buffer.toString('latin1'), ['ssn1'])).toEqual([]);
  });

  it('PNG tEXt / iTXt metadata with the SSN: no textual chunk survives', async () => {
    const r = await redactBuffer(fx.read('w2_meta.png'), { filename: 'm.png', mode: 'enforce' });
    expect(r.outcome).not.toBe('clean');
    if (r.outcome !== 'redacted') return;
    const p = probeImage(r.buffer, '.png');
    expect(p.png_chunks.filter((c) => ['tEXt', 'iTXt', 'zTXt', 'eXIf'].includes(c))).toEqual([]);
    expect(secretsIn(p.metadata_text, ['ssn1', 'ssn2'])).toEqual([]);
  });

  it('EXIF THUMBNAIL (a downscaled copy of the unredacted scan): the output carries exactly one image (one SOI), no APP1', async () => {
    const r = await redactBuffer(fx.read('w2_thumb.jpg'), { filename: 't.jpg', mode: 'enforce' });
    expect(['redacted', 'held']).toContain(r.outcome);
    if (r.outcome !== 'redacted') return;
    const p = probeImage(r.buffer, '.jpg');
    expect(p.soi_count).toBe(1);
    expect(p.jpeg_app).not.toContain('e1');
    expect(secretsIn(p.frames.join('\n'), ['ssn1', 'ssn2', 'itin'])).toEqual([]);
  });

  it('multi-frame TIFF whose SECOND frame has the SSN: every frame is redacted (frame count kept) or the file is held', async () => {
    const r = await redactBuffer(fx.read('w2_2page.tiff'), { filename: 'p.tiff', mode: 'enforce' });
    expect(['redacted', 'held']).toContain(r.outcome);
    if (r.outcome !== 'redacted') return;
    const p = probeImage(r.buffer, '.tiff');
    expect(p.frames).toHaveLength(2);
    for (const f of p.frames) expect(secretsIn(f, ['ssn1', 'ssn2', 'itin'])).toEqual([]);
  });
});
