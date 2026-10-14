// P0 RED — non-PDF formats: txt / csv / html / docx / xlsx / rtf / eml / zip and every encoding.
// Expected at the end of Phase 0: E_NOT_IMPLEMENTED. Round 2 (2026-10-14) = red-team fold-in; IDs in test names map to
// review-verdicts/{sonnet,opus}-redact-p0.md.
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactBuffer } from '../../pii-redact.js';
import { buildFixtures, inspectPdf, allLeaks, textLeaks, SECRETS, NEGATIVES } from './support/harness.mjs';

let fx;
beforeAll(() => { fx = buildFixtures(); }, 120_000);

const textOf = (b) => b.toString('utf8');
const hasSecret = (s, keys) => textLeaks(s, keys);

/** Decode a text buffer the way a reader would: BOM-aware UTF-16, else UTF-8. */
function decodeAny(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString('utf16le');
  return buf.toString('utf8');
}

function unzipToMap(buf) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-unzip-'));
  const zp = path.join(dir, 'x.zip');
  fs.writeFileSync(zp, buf);
  // -: allow '../' in names to be listed safely by reading entries instead of extracting
  const names = execFileSync('zipinfo', ['-1', zp]).toString('utf8').split('\n').filter(Boolean);
  const out = {};
  for (const n of names) {
    if (n.endsWith('/')) continue;
    out[n] = execFileSync('unzip', ['-p', zp, n], { maxBuffer: 64 * 1024 * 1024 });
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

/** Every part of an OOXML/zip, recursively (embedded xlsx inside docx, nested zip), as {path: Buffer}. */
function allParts(buf, prefix = '') {
  const parts = unzipToMap(buf);
  const out = {};
  for (const [n, b] of Object.entries(parts)) {
    out[prefix + n] = b;
    if (/\.(zip|xlsx|docx)$/i.test(n)) Object.assign(out, allParts(b, `${prefix}${n}!/`));
  }
  return out;
}

const xmlText = (b) => b.toString('utf8').replace(/<[^>]+>/g, '');

describe('plain text formats', () => {
  for (const name of ['notes.txt', 'sheet.csv', 'page.html']) {
    it(`${name}: secrets masked (full and partial), last 4 kept, structure preserved`, async () => {
      const input = fx.read(name);
      const r = await redactBuffer(input, { filename: name, mode: 'enforce' });
      expect(r.outcome).toBe('redacted');
      expect(hasSecret(textOf(r.buffer), fx.manifest[name].secrets)).toEqual([]);
      if (name === 'sheet.csv') {
        expect(textOf(r.buffer).split('\n')[0]).toBe('name,ssn,routing'); // header intact
        expect(textOf(r.buffer)).toContain('XXX-XX-6789');
      }
      if (name === 'page.html') {
        expect(textOf(r.buffer)).toMatch(/<html>[\s\S]*<\/html>/);
        expect(textOf(r.buffer)).toContain('XXX-XX-6789');
      }
    });
  }

  it('notes.txt keeps the negative controls', async () => {
    const r = await redactBuffer(fx.read('notes.txt'), { filename: 'notes.txt', mode: 'enforce' });
    for (const neg of ['246813579', '(415) 555-0134', '98-7654321', '$2,468,013.57', '04/15/2026', '64,210']) {
      expect(textOf(r.buffer), neg).toContain(neg);
    }
  });

  for (const name of ['notes.md', 'notes.xml', 'notes.log']) {
    it(`[Opus D5] ${name} (a type the producer extracts as text) is masked, never clean`, async () => {
      const r = await redactBuffer(fx.read(name), { filename: name, mode: 'enforce' });
      expect(r.outcome).toBe('redacted');
      expect(hasSecret(textOf(r.buffer), fx.manifest[name].secrets)).toEqual([]);
    });
  }
});

describe('[Sonnet H2, Opus H8] encodings: masked in the SAME encoding, or held — never clean', () => {
  for (const name of ['notes_utf16le.txt', 'notes_utf16be.txt', 'notes_utf8bom.txt', 'notes_crlf.txt', 'sheet_utf16.csv', 'page_latin1.html']) {
    it(`${name}`, async () => {
      const input = fx.read(name);
      const r = await redactBuffer(input, { filename: name, mode: 'enforce' });
      // [Fable M1] success floor: the common encodings MUST be redacted, not held
      if (['notes_utf16le.txt', 'notes_utf16be.txt', 'notes_utf8bom.txt', 'notes_crlf.txt'].includes(name)) expect(r.outcome).toBe('redacted');
      expect(['redacted', 'held']).toContain(r.outcome);
      if (r.outcome === 'held') return;
      const enc = fx.manifest[name].encoding;
      const out = enc === 'latin1' ? r.buffer.toString('latin1') : decodeAny(r.buffer);
      expect(hasSecret(out, fx.manifest[name].secrets)).toEqual([]);
      // the encoding/BOM/line endings survive (a reader still opens it)
      expect(r.buffer.subarray(0, 2).equals(input.subarray(0, 2))).toBe(true);
      if (name === 'notes_crlf.txt') expect(textOf(r.buffer)).toContain('\r\n');
      if (name === 'page_latin1.html') expect(r.buffer.toString('latin1')).toContain('Café');
    });
  }
});

describe('[Sonnet C5, Opus H9] CSV / HTML / JSON shapes that hide an SSN from a line regex', () => {
  it('ssn_column.csv: an SSN column of UNSEPARATED 9-digit values under an "SSN" header is fully masked (column-aware label)', async () => {
    const r = await redactBuffer(fx.read('ssn_column.csv'), { filename: 'ssn_column.csv', mode: 'enforce' });
    expect(r.outcome).toBe('redacted');
    const rows = textOf(r.buffer).trim().split('\n');
    expect(rows[0]).toBe('name,SSN,Routing number');
    for (const row of rows.slice(1)) {
      const [, ssn, routing] = row.split(',');
      expect(ssn).toMatch(/^XXX-XX-\d{4}$/);
      expect(routing).not.toContain(SECRETS.routing.digits);
    }
  });

  it('split_columns.csv: an SSN split across three columns ("123","45","6789") is masked or held', async () => {
    const r = await redactBuffer(fx.read('split_columns.csv'), { filename: 'split_columns.csv', mode: 'enforce' });
    expect(['redacted', 'held']).toContain(r.outcome);
    if (r.outcome === 'redacted') expect(textOf(r.buffer)).not.toMatch(/"?123"?\s*,\s*"?45"?\s*,/);
  });

  it('html_entities.html: numeric/named entities and tag-split SSNs are masked (checked on the RENDERED text)', async () => {
    const r = await redactBuffer(fx.read('html_entities.html'), { filename: 'html_entities.html', mode: 'enforce' });
    expect(r.outcome).toBe('redacted');
    const rendered = textOf(r.buffer).replace(/<[^>]+>/g, '').replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&ndash;/g, '–');
    expect(hasSecret(rendered, ['ssn1', 'ssn2', 'itin'])).toEqual([]);
  });

  it('json_escapes.json: \\u002d escapes are decoded before matching; output is still valid JSON', async () => {
    const r = await redactBuffer(fx.read('json_escapes.json'), { filename: 'json_escapes.json', mode: 'enforce' });
    expect(r.outcome).toBe('redacted');
    const parsed = JSON.parse(textOf(r.buffer));
    expect(hasSecret(JSON.stringify(parsed), ['ssn1', 'ssn2'])).toEqual([]);
  });
});

describe('docx', () => {
  it('return.docx: masks word/document.xml, stays a valid zip', async () => {
    const input = fx.read('return.docx');
    const r = await redactBuffer(input, { filename: 'return.docx', mode: 'enforce' });
    expect(r.outcome).toBe('redacted');
    const parts = unzipToMap(r.buffer);
    expect(Object.keys(parts).sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'word/document.xml']);
    expect(hasSecret(xmlText(parts['word/document.xml']), fx.manifest['return.docx'].secrets)).toEqual([]);
    expect(textOf(parts['word/document.xml'])).toContain('XXX-XX-6789');
    expect(textOf(parts['word/document.xml'])).toMatch(/^<\?xml/);
  });

  it('[Sonnet H1, Opus H6] return_full.docx: EVERY part is scanned — split runs, tracked deletion (w:delText), comments, header, footer, footnotes, docProps core+custom, customXml, embedded xlsx — and the part list is preserved (replaces round-1 "other parts untouched")', async () => {
    const input = fx.read('return_full.docx');
    const r = await redactBuffer(input, { filename: 'return_full.docx', mode: 'enforce' });
    expect(r.outcome).toBe('redacted'); // [Fable M1] success floor: a well-formed docx is redacted, not held
    expect(Object.keys(unzipToMap(r.buffer)).sort()).toEqual(Object.keys(unzipToMap(input)).sort());
    const parts = allParts(r.buffer);
    for (const [n, b] of Object.entries(parts)) {
      if (/\.(xlsx|zip)$/.test(n)) continue;
      expect(hasSecret(xmlText(b), fx.manifest['return_full.docx'].secrets), n).toEqual([]);
      // raw XML too (attribute values, split runs re-joined by digit matching)
      expect(hasSecret(b.toString('utf8'), fx.manifest['return_full.docx'].secrets), `${n} raw`).toEqual([]);
    }
    const body = xmlText(parts['word/document.xml']);
    expect(body).toContain(NEGATIVES.ein.text);
    expect(body).toContain(NEGATIVES.current_agi.text);
  });

  it('a docx part that cannot be parsed but contains a PII pattern holds the file', async () => {
    const d =fs.mkdtempSync(path.join(os.tmpdir(), 'pii-baddocx-'));
    fs.mkdirSync(path.join(d, 'word'));
    fs.writeFileSync(path.join(d, '[Content_Types].xml'), '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
    fs.writeFileSync(path.join(d, 'word', 'document.xml'), `<w:document><w:body><w:p><w:t>SSN ${SECRETS.ssn1.text}</w:t></w:p>`); // truncated XML
    execFileSync('zip', ['-q', '-r', path.join(d, 'bad.docx'), '[Content_Types].xml', 'word'], { cwd: d });
    const r = await redactBuffer(fs.readFileSync(path.join(d, 'bad.docx')), { filename: 'bad.docx', mode: 'enforce' });
    expect(r.outcome).toBe('held');
  });
});

describe('[Sonnet H1, Opus H7] xlsx', () => {
  it('sheet.xlsx: numeric SSN cell (numFmt 000-00-0000), shared strings, hidden sheet, comment, defined name, docProps — every part clean (R3: must be redacted, not held)', async () => {
    const input = fx.read('sheet.xlsx');
    const r = await redactBuffer(input, { filename: 'sheet.xlsx', mode: 'enforce' });
    expect(r.outcome).toBe('redacted'); // [Fable M1] success floor
    for (const [n, b] of Object.entries(allParts(r.buffer))) {
      expect(hasSecret(b.toString('utf8'), fx.manifest['sheet.xlsx'].secrets), n).toEqual([]);
    }
  });
});

describe('[Opus D5] other office / mail types the producer can extract', () => {
  it('notes.rtf is masked (or held), never clean', async () => {
    const r = await redactBuffer(fx.read('notes.rtf'), { filename: 'notes.rtf', mode: 'enforce' });
    expect(['redacted', 'held']).toContain(r.outcome);
    if (r.outcome === 'redacted') expect(hasSecret(r.buffer.toString('latin1'), ['ssn1', 'dob'])).toEqual([]);
  });

  it('return.eml: SSN in a header AND in a base64 body is masked (decoded first) or held', async () => {
    const r = await redactBuffer(fx.read('return.eml'), { filename: 'return.eml', mode: 'enforce' });
    expect(['redacted', 'held']).toContain(r.outcome);
    if (r.outcome === 'redacted') {
      const raw = r.buffer.toString('latin1');
      const b64 = raw.split('\r\n\r\n')[1] ?? '';
      expect(hasSecret(raw + '\n' + Buffer.from(b64.trim(), 'base64').toString('utf8'), ['ssn1', 'ssn2'])).toEqual([]);
    }
  });

  it('legacy .doc / .xls with UTF-16 text (no ASCII SSN in the bytes) are held, never clean', async () => {
    for (const name of ['legacy.doc', 'legacy.xls']) {
      const r = await redactBuffer(fx.read(name), { filename: name, mode: 'enforce' });
      expect(r.outcome, name).toBe('held');
    }
  });
});

describe('[Opus D4/C8] type coverage: every type the producers extract is sanitizable, and nothing with a secret is ever "clean"', () => {
  // Mirrors personal/email-ingestor document-drop-producer.js IMAGE_EXT_RE + TEXT_EXT_RE + '.md' + '.pdf' +
  // lib/office-extract.js OFFICE_READERS + container-extract.js CONTAINER_EXT_RE (2026-10-14). The producer-side test
  // (pii-sanitize-document-drop.red.test.js) derives the same list from the producer's own regexes.
  // (the declared-constant half of this contract is GREEN in contract-constants.test.js)
  const PRODUCER_EXTRACTS = ['.pdf', '.jpg', '.jpeg', '.png', '.tiff', '.heic', '.txt', '.csv', '.log', '.json', '.xml', '.html', '.md',
    '.docx', '.doc', '.rtf', '.xls', '.xlsx', '.zip', '.pages', '.numbers', '.key'];

  for (const ext of PRODUCER_EXTRACTS) {
    it(`a ${ext} file whose bytes carry an SSN (as UTF-8 text) is redacted or held — never clean`, async () => {
      const r = await redactBuffer(Buffer.from(`Taxpayer SSN ${SECRETS.ssn1.text}\n`), { filename: `f${ext}`, mode: 'enforce' });
      expect(['redacted', 'held']).toContain(r.outcome);
      if (r.outcome === 'redacted') expect(hasSecret(r.buffer.toString('latin1'), ['ssn1'])).toEqual([]);
    });
  }
});

describe('zip bundles', () => {
  it('every member is sanitized (pdf + txt), clean members pass through unchanged', async () => {
    const input = fx.read('bundle.zip');
    const r = await redactBuffer(input, { filename: 'bundle.zip', mode: 'enforce' });
    expect(r.outcome).toBe('redacted');
    const parts = unzipToMap(r.buffer);
    expect(Object.keys(parts).sort()).toEqual(['clean.pdf', 'notes.txt', 'text_layer.pdf']);
    expect(hasSecret(textOf(parts['notes.txt']), fx.manifest['notes.txt'].secrets)).toEqual([]);
    const pdf = inspectPdf(parts['text_layer.pdf'], { ocr: false });
    expect(allLeaks(pdf.surfaces, fx.manifest['text_layer.pdf'].secrets)).toEqual([]);
    expect(Buffer.compare(parts['clean.pdf'], fx.read('clean.pdf'))).toBe(0);
  });

  it('one unredactable member holds the WHOLE zip (atomic): held:corrupt_member, no buffer', async () => {
    const r = await redactBuffer(fx.read('bundle_with_bad_member.zip'), { filename: 'bundle_with_bad_member.zip', mode: 'enforce' });
    expect(r).toMatchObject({ outcome: 'held', reason: 'corrupt_member' });
    expect(r.buffer).toBeUndefined();
  });

  it('a zip with only clean members is clean with identical bytes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-cleanzip-'));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'nothing private here, invoice 246813579\n');
    execFileSync('zip', ['-q', '-j', path.join(dir, 'c.zip'), path.join(dir, 'a.txt')]);
    const input = fs.readFileSync(path.join(dir, 'c.zip'));
    const r = await redactBuffer(input, { filename: 'c.zip', mode: 'enforce' });
    expect(r.outcome).toBe('clean');
    expect(Buffer.compare(r.buffer, input)).toBe(0);
  });

  it('[Sonnet C2, Opus H10/D14] SSNs in member NAMES are masked in the output zip (content was clean)', async () => {
    const r = await redactBuffer(fx.read('zip_member_names.zip'), { filename: 'zip_member_names.zip', mode: 'enforce' });
    expect(r.outcome).toBe('redacted');
    const names = Object.keys(unzipToMap(r.buffer));
    expect(names).toHaveLength(2);
    expect(hasSecret(names.join('\n'), ['ssn1', 'ssn2'])).toEqual([]);
    expect(r.buffer.toString('latin1').includes(SECRETS.ssn1.text)).toBe(false); // central directory too
  });

  it('[Opus H10] a NESTED zip is sanitized recursively', async () => {
    const r = await redactBuffer(fx.read('nested.zip'), { filename: 'nested.zip', mode: 'enforce' });
    expect(r.outcome).toBe('redacted');
    for (const [n, b] of Object.entries(allParts(r.buffer))) {
      if (/\.pdf$/.test(n)) expect(allLeaks(inspectPdf(b, { ocr: false }).surfaces), n).toEqual([]);
      else if (!/\.zip$/.test(n)) expect(hasSecret(textOf(b), fx.manifest['nested.zip'].secrets), n).toEqual([]);
    }
  });

  it('[Opus H10] a zip-slip member name (../../) is neutralised (no ../ in output names) or the zip is held', async () => {
    const r = await redactBuffer(fx.read('zip_slip.zip'), { filename: 'zip_slip.zip', mode: 'enforce' });
    expect(['redacted', 'held']).toContain(r.outcome);
    if (r.outcome === 'redacted') {
      const parts = unzipToMap(r.buffer);
      for (const n of Object.keys(parts)) expect(n).not.toMatch(/(^|\/)\.\.(\/|$)|^\//);
      expect(hasSecret(Object.values(parts).map(textOf).join('\n'), ['ssn1'])).toEqual([]);
    }
  });

  it('[Opus H10] an encrypted member holds the zip (held:encrypted)', async () => {
    const r = await redactBuffer(fx.read('zip_encrypted_member.zip'), { filename: 'zip_encrypted_member.zip', mode: 'enforce' });
    expect(r).toMatchObject({ outcome: 'held', reason: 'encrypted' });
  });

  it('[Opus H10, Sonnet M9] a zip bomb (uncompressed size over the limit) is held:too_large without being expanded', async () => {
    const r = await redactBuffer(fx.read('zip_bomb.zip'), { filename: 'zip_bomb.zip', mode: 'enforce', limits: { maxZipUncompressedBytes: 1_000_000 } });
    expect(r).toMatchObject({ outcome: 'held', reason: 'too_large' });
  });

  it('[Sonnet M6] re-redacting a redacted docx / zip is clean (idempotent)', async () => {
    for (const name of ['return.docx', 'bundle.zip']) {
      const first = await redactBuffer(fx.read(name), { filename: name, mode: 'enforce' });
      const second = await redactBuffer(first.buffer, { filename: name, mode: 'enforce' });
      expect(second.outcome, name).toBe('clean');
    }
  });
});
