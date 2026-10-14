// P0 RED — non-PDF formats: txt / csv / html / docx / zip. Expected at the end of Phase 0: E_NOT_IMPLEMENTED.
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactBuffer } from '../../pii-redact.js';
import { buildFixtures, inspectPdf, leaks, SECRETS } from './support/harness.mjs';

let fx;
beforeAll(() => { fx = buildFixtures(); }, 120_000);

const textOf = (b) => b.toString('utf8');
const digitsOf = (s) => s.replace(/\D/g, '');
const hasSecret = (s, keys) => keys.filter((k) => (SECRETS[k].kind === 'dl_id' ? s.replace(/\s/g, '').includes(SECRETS[k].digits) : digitsOf(s).includes(SECRETS[k].digits)));

function unzipToMap(buf) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-unzip-'));
  const zp = path.join(dir, 'x.zip');
  fs.writeFileSync(zp, buf);
  execFileSync('unzip', ['-q', zp, '-d', path.join(dir, 'out')]);
  const out = {};
  const walk = (d, rel = '') => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, path.join(rel, e.name));
      else out[path.join(rel, e.name)] = fs.readFileSync(p);
    }
  };
  walk(path.join(dir, 'out'));
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

describe('plain text formats', () => {
  for (const name of ['notes.txt', 'sheet.csv', 'page.html']) {
    it(`${name}: secrets masked, last 4 kept, structure preserved`, async () => {
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
});

describe('docx', () => {
  it('masks word/document.xml, stays a valid zip, other parts untouched', async () => {
    const input = fx.read('return.docx');
    const r = await redactBuffer(input, { filename: 'return.docx', mode: 'enforce' });
    expect(r.outcome).toBe('redacted');
    const parts = unzipToMap(r.buffer);
    expect(Object.keys(parts).sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'word/document.xml']);
    expect(hasSecret(textOf(parts['word/document.xml']), fx.manifest['return.docx'].secrets)).toEqual([]);
    expect(textOf(parts['word/document.xml'])).toContain('XXX-XX-6789');
    expect(textOf(parts['word/document.xml'])).toMatch(/^<\?xml/);
  });
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
    expect(leaks(pdf.surfaces, fx.manifest['text_layer.pdf'].secrets)).toEqual([]);
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
});
