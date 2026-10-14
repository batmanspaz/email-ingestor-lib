// Test harness for the PII-redaction contract. Independent of the engine under test:
// builds SYNTHETIC fixtures with PyMuPDF and inspects outputs with inspect_pdf.py (+ local tesseract).
import { execFileSync } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const values = JSON.parse(fs.readFileSync(path.join(HERE, 'values.json'), 'utf8'));
export const SECRETS = values.secrets;
export const NEGATIVES = values.negatives;

// The harness's OWN temp space is fixed at import time, so tests that point TMPDIR at a watched directory (temp-file
// hygiene, C6/D18) only ever see what the code under test created there.
const HARNESS_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-harness-'));

let cached = null;
/** Generate (once per process) the synthetic fixture set into a temp dir. */
export function buildFixtures() {
  if (cached) return cached;
  const dir = fs.mkdtempSync(path.join(HARNESS_TMP, 'pii-fixtures-'));
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

/** Run the independent inspector on a PDF buffer. Returns {ok, encrypted, error, pages, surfaces, meta}. */
export function inspectPdf(buffer, { ocr = true, ocrAlt = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(HARNESS_TMP, 'pii-inspect-'));
  const p = path.join(tmp, 'x.pdf');
  fs.writeFileSync(p, buffer);
  try {
    const args = [path.join(HERE, 'inspect_pdf.py'), p];
    if (ocr) args.push('--ocr');
    if (ocrAlt) args.push('--ocr-alt');
    const out = execFileSync('python3', args, { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(out.toString('utf8'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Fold every Unicode digit script / fullwidth form to ASCII and drop invisible characters, so obfuscation in
 *  the OUTPUT cannot hide a secret from the checker (Sonnet C4/C5, Opus H4). */
export function normalizeForCheck(s) {
  let t = String(s).normalize('NFKC').replace(/[\u00ad\u200b-\u200f\u2060\ufeff]/g, '');
  t = t.replace(/\p{Nd}/gu, (ch) => {
    const cp = ch.codePointAt(0);
    for (let z = cp; z > cp - 10; z--) if (!/\p{Nd}/u.test(String.fromCodePoint(z - 1))) return String(cp - z);
    return ch;
  });
  return t;
}
const digitsOf = (s) => normalizeForCheck(s).replace(/\D/g, '');
const squash = (s) => normalizeForCheck(s).replace(/\s+/g, '');
const escRe = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Surfaces that are whole files / object dumps: concatenating ALL their digits would collide with xref offsets and
// object numbers, so these are matched with "digits separated by at most 3 non-alphanumerics" instead.
const RAW_SURFACES = new Set(['filebytes', 'objects']);
const sepRegex = (secret) => new RegExp(secret.split('').map(escRe).join('[^0-9A-Za-z]{0,3}'));

/**
 * Which synthetic secrets are still readable in these surfaces? Numeric secrets are matched on digits only
 * (so dashes/spaces/NBSP variants cannot hide), the driver-license id on whitespace-stripped text.
 * Masked forms such as XXX-XX-6789 leave only the last 4 digits and therefore do NOT match.
 * NOTE (R2, Opus D22): this only catches the FULL value. Always combine with partialLeaks() — see allLeaks().
 * @returns {{key:string, surface:string}[]}
 */
export function leaks(surfaces, keys = Object.keys(SECRETS)) {
  const hits = [];
  for (const [surface, arr] of Object.entries(surfaces)) {
    if (!Array.isArray(arr)) continue;
    const joined = normalizeForCheck(arr.join('\n'));
    if (RAW_SURFACES.has(surface)) {
      for (const key of keys) if (sepRegex(SECRETS[key].digits).test(joined)) hits.push({ key, surface });
      continue;
    }
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

const SEP_CLASS = '[\\s\\-\\u2010-\\u2015\\u2212\\u00a0\\u00b7]';
const MASKCH = '[0-9Xx*\\u2022\\u25cf#]';
/**
 * PARTIAL-mask leaks (R2, Opus D22 / H3): a too-small redaction box or a bad masker that leaves 5-8 digits of an
 * SSN/ITIN visible passes leaks() (which needs all 9). Flags, per SSN-class key:
 *  (a) an SSN-shaped token ending in this SSN's last 4 whose first 5 positions contain ANY digit (XXX-X5-6789, 3-45-6789);
 *  (b) a digit run of 5-8 digits that is a prefix or suffix window of the SSN (12345..., ...56789).
 * The kept last 4 alone never matches.
 */
export function partialLeaks(surfaces, keys = Object.keys(SECRETS)) {
  const hits = [];
  const ssnKeys = keys.filter((k) => ['ssn', 'itin'].includes(SECRETS[k].kind));
  const shaped = new RegExp(`(${MASKCH}{1,3})${SEP_CLASS}?(${MASKCH}{2})${SEP_CLASS}?(\\d{4})(?!\\d)`, 'g');
  const run = /(?<![0-9A-Za-z])\d(?:[\s\-\u2010-\u2015\u2212\u00a0]?\d)+(?![0-9])/g;
  for (const [surface, arr] of Object.entries(surfaces)) {
    if (!Array.isArray(arr) || RAW_SURFACES.has(surface)) continue;
    const t = normalizeForCheck(arr.join('\n'));
    for (const key of ssnKeys) {
      const d = SECRETS[key].digits;
      const last4 = d.slice(5);
      let bad = false;
      for (const m of t.matchAll(shaped)) if (m[3] === last4 && /\d/.test(m[1] + m[2])) bad = true;
      for (const m of t.matchAll(run)) {
        const tok = m[0].replace(/\D/g, '');
        if (tok.length >= 5 && tok.length <= 8 && (d.startsWith(tok) || d.endsWith(tok))) bad = true;
      }
      if (bad) hits.push({ key, surface, partial: true });
    }
  }
  return hits;
}

/** Full + partial leaks. Every RED engine test uses this, never leaks() alone. */
export function allLeaks(surfaces, keys = Object.keys(SECRETS)) {
  return [...leaks(surfaces, keys), ...partialLeaks(surfaces, keys)];
}

/** Text check for non-PDF outputs (txt/csv/html/xml parts): full + partial leaks of the given keys. */
export function textLeaks(text, keys = Object.keys(SECRETS)) {
  return allLeaks({ text: [String(text)] }, keys).map((h) => h.key);
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

/**
 * Scan any JSON/string payload (events, reports) for private digits. Returns offending fragments' KINDS only.
 * R2 (Opus D8/H17/H18): the default allow-list NO LONGER lets sha256 keys through (sha256(original) + redacted text
 * + kept last-4 is a 10^5 brute-force oracle — it must never leave the vault), and DOES allow `ttl_seconds` (a
 * spec-correct 12h-40h ttl is 5 digits, so the round-1 reporter test was unsatisfiable). Any 64-hex string is
 * reported as 'sha256_hex'. Callers that legitimately carry hashes (the vault sidecar) opt in explicitly.
 */
export function privateDigitsIn(payload, { allowKeys = ['at', 'ttl_seconds'] } = {}) {
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
  if (/\b[0-9a-f]{64}\b/i.test(s)) problems.push('sha256_hex');
  if (/\d{4,}/.test(s.replace(/"\d{4}-\d{2}-\d{2}T[^"]*"/g, ''))) problems.push('long_digit_run');
  return problems;
}

/**
 * Network guard (R2, Opus M4/D20, Sonnet M2): fetch AND node:http/https request, net.Socket#connect, dns.lookup in
 * this process, PLUS a Python sitecustomize (via PYTHONPATH) that makes every socket connect / getaddrinfo in the
 * engine subprocess write a marker file and fail. tesseract is a local binary with no network code paths.
 */
export function installNetworkGuard() {
  const require = createRequire(import.meta.url);
  const http = require('node:http');
  const https = require('node:https');
  const net = require('node:net');
  const dns = require('node:dns');
  const calls = [];
  const deny = (what) => (...args) => { calls.push(`${what}:${String(args[0]?.href ?? args[0]?.host ?? args[0])}`); throw new Error(`network call during redaction is forbidden (${what})`); };
  const saved = {
    fetch: globalThis.fetch, httpReq: http.request, httpGet: http.get, httpsReq: https.request, httpsGet: https.get,
    connect: net.Socket.prototype.connect, lookup: dns.lookup, pyPath: process.env.PYTHONPATH, marker: process.env.PII_NET_MARKER,
  };
  globalThis.fetch = deny('fetch');
  http.request = deny('http.request'); http.get = deny('http.get');
  https.request = deny('https.request'); https.get = deny('https.get');
  net.Socket.prototype.connect = function guardedConnect(...a) { return deny('net.connect')(...a); };
  dns.lookup = deny('dns.lookup');
  syncBuiltinESMExports();
  const pyDir = fs.mkdtempSync(path.join(HARNESS_TMP, 'pii-pyguard-'));
  const marker = path.join(pyDir, 'NETWORK_USED');
  fs.writeFileSync(path.join(pyDir, 'sitecustomize.py'), [
    'import os, socket',
    'def _deny(*a, **k):',
    '    open(os.environ.get("PII_NET_MARKER", "/dev/null"), "a").write("socket\\n")',
    '    raise OSError("network forbidden during redaction")',
    'socket.socket.connect = _deny',
    'socket.socket.connect_ex = _deny',
    'socket.create_connection = _deny',
    'socket.getaddrinfo = _deny',
    '',
  ].join('\n'));
  process.env.PYTHONPATH = [pyDir, saved.pyPath].filter(Boolean).join(path.delimiter);
  process.env.PII_NET_MARKER = marker;
  return {
    calls,
    pythonNetworkUsed: () => fs.existsSync(marker),
    restore: () => {
      globalThis.fetch = saved.fetch;
      http.request = saved.httpReq; http.get = saved.httpGet; https.request = saved.httpsReq; https.get = saved.httpsGet;
      net.Socket.prototype.connect = saved.connect; dns.lookup = saved.lookup;
      syncBuiltinESMExports();
      if (saved.pyPath === undefined) delete process.env.PYTHONPATH; else process.env.PYTHONPATH = saved.pyPath;
      if (saved.marker === undefined) delete process.env.PII_NET_MARKER; else process.env.PII_NET_MARKER = saved.marker;
    },
  };
}

/**
 * Temp-file hygiene (R2, Sonnet C6 / Opus D18/M2): point TMPDIR (node os.tmpdir(), python tempfile, tesseract) at a
 * fresh watched directory. snapshot() lists what is there NOW with modes — call it from inside an injected
 * collaborator to see temp files mid-run; leftovers() after the run must be [].
 */
export function watchTmpdir() {
  const dir = fs.mkdtempSync(path.join(HARNESS_TMP, 'pii-watched-tmp-'));
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  const walk = (d, rel = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    const r = path.join(rel, e.name);
    const mode = fs.lstatSync(p).mode & 0o777;
    return e.isDirectory() ? [{ path: r, dir: true, mode }, ...walk(p, r)] : [{ path: r, dir: false, mode }];
  });
  return {
    dir,
    snapshot: () => walk(dir),
    leftovers: () => walk(dir),
    restore: () => { if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved; },
  };
}

/** Run a python pixel probe: mean + stddev of a region. PDFs: rect in PDF points on page N rendered at dpi; images: pixels. */
export function regionStats(buffer, { kind, page = 0, rect, dpi = 200 }) {
  const tmp = fs.mkdtempSync(path.join(HARNESS_TMP, 'pii-pixel-'));
  const p = path.join(tmp, kind === 'pdf' ? 'x.pdf' : 'x.img');
  fs.writeFileSync(p, buffer);
  try {
    const out = execFileSync('python3', [path.join(HERE, 'pixel_check.py'), p, kind, String(page), rect.join(','), String(dpi)], { stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(out.toString('utf8'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Local tesseract over a PNG buffer — the reference implementation a test hands to deps.ocr (R3, Fable L1/L2). */
export async function tesseractPng(png) {
  const tmp = fs.mkdtempSync(path.join(HARNESS_TMP, 'pii-tess-'));
  try {
    fs.writeFileSync(path.join(tmp, 'p.png'), png);
    return execFileSync('tesseract', [path.join(tmp, 'p.png'), '-', '--psm', '6'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** R3 (Fable M2): frames OCR + JPEG APPn segments + SOI count + PNG chunks + textual metadata of an image file. */
export function probeImage(buffer, ext = '.img') {
  const tmp = fs.mkdtempSync(path.join(HARNESS_TMP, 'pii-imgprobe-'));
  const p = path.join(tmp, `x${ext}`);
  fs.writeFileSync(p, buffer);
  try {
    return JSON.parse(execFileSync('python3', [path.join(HERE, 'image_probe.py'), p], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 }).toString('utf8'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** OCR an image FILE buffer with local tesseract (positive controls + output checks for jpg/png/tiff/heic). */
export function ocrImageFile(buffer, ext) {
  const tmp = fs.mkdtempSync(path.join(HARNESS_TMP, 'pii-ocrimg-'));
  let p = path.join(tmp, `x${ext}`);
  fs.writeFileSync(p, buffer);
  try {
    if (ext === '.heic') {
      execFileSync('sips', ['-s', 'format', 'png', p, '--out', path.join(tmp, 'x.png')], { stdio: 'ignore' });
      p = path.join(tmp, 'x.png');
    }
    return execFileSync('tesseract', [p, '-', '--psm', '6'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
