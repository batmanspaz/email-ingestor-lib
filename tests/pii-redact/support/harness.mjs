// Test harness for the PII-redaction contract. Independent of the engine under test:
// builds SYNTHETIC fixtures with PyMuPDF and inspects outputs with inspect_pdf.py (+ local tesseract).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const values = JSON.parse(fs.readFileSync(path.join(HERE, 'values.json'), 'utf8'));
export const SECRETS = values.secrets;
export const NEGATIVES = values.negatives;

let cached = null;
/** Generate (once per process) the synthetic fixture set into a temp dir. */
export function buildFixtures() {
  if (cached) return cached;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-fixtures-'));
  execFileSync('python3', [path.join(HERE, 'generate_fixtures.py'), dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  cached = {
    dir,
    manifest,
    path: (name) => path.join(dir, name),
    read: (name) => fs.readFileSync(path.join(dir, name)),
    names: Object.keys(manifest),
  };
  return cached;
}

/** Run the independent inspector on a PDF buffer. Returns {ok, encrypted, error, pages, surfaces}. */
export function inspectPdf(buffer, { ocr = true } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-inspect-'));
  const p = path.join(tmp, 'x.pdf');
  fs.writeFileSync(p, buffer);
  try {
    const args = [path.join(HERE, 'inspect_pdf.py'), p];
    if (ocr) args.push('--ocr');
    const out = execFileSync('python3', args, { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(out.toString('utf8'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const digitsOf = (s) => String(s).replace(/\D/g, '');
const squash = (s) => String(s).replace(/\s+/g, '');

/**
 * Which synthetic secrets are still readable in these surfaces? Numeric secrets are matched on digits only
 * (so dashes/spaces/NBSP variants cannot hide), the driver-license id on whitespace-stripped text.
 * Masked forms such as XXX-XX-6789 leave only the last 4 digits and therefore do NOT match.
 * @returns {{key:string, surface:string}[]}
 */
export function leaks(surfaces, keys = Object.keys(SECRETS)) {
  const hits = [];
  for (const [surface, arr] of Object.entries(surfaces)) {
    const joined = arr.join('\n');
    const d = digitsOf(joined);
    const sq = squash(joined);
    for (const key of keys) {
      const sec = SECRETS[key];
      const found = sec.kind === 'dl_id' ? sq.includes(sec.digits) : d.includes(sec.digits);
      if (found) hits.push({ key, surface });
    }
  }
  return hits;
}

/** Do all these negative controls still appear (whitespace-insensitive) on a text surface? */
export function negativesPresent(surfaces, keys) {
  const text = squash([...(surfaces.text ?? []), ...(surfaces.ocr ?? [])].join('\n'));
  return keys.filter((k) => !text.includes(squash(NEGATIVES[k].text)));
}

/** Is the XXX-XX-<last4> form present on a text/ocr surface for this ssn key? */
export function lastFourKept(surfaces, key) {
  const text = [...(surfaces.text ?? []), ...(surfaces.ocr ?? [])].join('\n');
  return new RegExp(`[X*]{3}[-\\s]?[X*]{2}[-\\s]?${SECRETS[key].last4}`, 'i').test(text);
}

/** Scan any JSON/string payload (events, reports) for private digits. Returns offending fragments' KINDS only. */
export function privateDigitsIn(payload, { allowKeys = ['sha256', 'original_sha256', 'redacted_sha256', 'at'] } = {}) {
  const strip = (v) => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) if (!allowKeys.includes(k)) o[k] = strip(x);
      return o;
    }
    return v;
  };
  const s = JSON.stringify(strip(payload));
  const problems = [];
  for (const [key, sec] of Object.entries(SECRETS)) {
    if (digitsOf(s).includes(sec.digits) || s.includes(sec.text)) problems.push(key);
  }
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(s)) problems.push('ssn_pattern');
  if (/\d{4,}/.test(s.replace(/"\d{4}-\d{2}-\d{2}T[^"]*"/g, ''))) problems.push('long_digit_run');
  return problems;
}

/** Install a fetch/net guard that records any call (tests assert it stayed empty). */
export function installNetworkGuard() {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (...args) => {
    calls.push(String(args[0]));
    throw new Error('network call during redaction is forbidden');
  };
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}
