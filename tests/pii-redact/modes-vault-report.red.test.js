// P0 RED — mode flag, vault, sidecar report, file-level wrapper. Expected at end of Phase 0: E_NOT_IMPLEMENTED.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactBuffer, redactFile, vaultOriginal, REPORT_SCHEMA } from '../../pii-redact.js';
import { buildFixtures, inspectPdf, leaks, allLeaks, textLeaks, privateDigitsIn, watchTmpdir } from './support/harness.mjs';

let fx;
beforeAll(() => { fx = buildFixtures(); }, 120_000);

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-modes-')); });

describe('mode flag', () => {
  it('off: does not inspect, returns clean with identical bytes and reason mode_off', async () => {
    const input = fx.read('text_layer.pdf');
    const r = await redactBuffer(input, { filename: 'text_layer.pdf', mode: 'off' });
    expect(r).toMatchObject({ outcome: 'clean', reason: 'mode_off' });
    expect(Buffer.compare(r.buffer, input)).toBe(0);
  });

  it('shadow: detects + reports counts but changes NOTHING (outcome detected, original bytes returned)', async () => {
    const input = fx.read('text_layer.pdf');
    const r = await redactBuffer(input, { filename: 'text_layer.pdf', mode: 'shadow' });
    expect(r.outcome).toBe('detected');
    expect(Buffer.compare(r.buffer, input)).toBe(0);
    expect(r.report.counts.ssn).toBeGreaterThanOrEqual(3);
    expect(r.report.counts.bank).toBeGreaterThanOrEqual(2);
  });

  it('shadow on a clean file stays clean', async () => {
    const r = await redactBuffer(fx.read('clean.pdf'), { filename: 'clean.pdf', mode: 'shadow' });
    expect(r.outcome).toBe('clean');
  });

  it('shadow on an unreadable file is still held (a document we cannot inspect is never silently passed)', async () => {
    const r = await redactBuffer(fx.read('encrypted.pdf'), { filename: 'encrypted.pdf', mode: 'shadow' });
    expect(r).toMatchObject({ outcome: 'held', reason: 'encrypted' });
  });

  it('an unknown mode string throws (callers must resolve modes first)', async () => {
    await expect(redactBuffer(fx.read('clean.pdf'), { filename: 'clean.pdf', mode: 'bogus' })).rejects.toThrow(/mode/i);
  });
});

describe('RedactionReport v1 (sidecar)', () => {
  it('has the declared shape, hashes of original + derivative, counts, tool info — and no filename', async () => {
    const input = fx.read('text_layer.pdf');
    const r = await redactBuffer(input, { filename: 'Jane Q Tester 2025 Return.pdf', mode: 'enforce' });
    const rep = r.report;
    expect(rep.schema).toBe(REPORT_SCHEMA);
    expect(rep.schema).toBe('pii-redaction-report/v1');
    expect(rep.original_sha256).toBe(sha(input));
    expect(rep.redacted_sha256).toBe(sha(r.buffer));
    expect(rep.mode).toBe('enforce');
    expect(rep.outcome).toBe('redacted');
    expect(rep.filename_ext).toBe('.pdf');
    expect(rep.counts).toEqual(expect.objectContaining({ ssn: expect.any(Number), bank: expect.any(Number), dob: expect.any(Number), pin: expect.any(Number), id: expect.any(Number) }));
    expect(rep.tool).toEqual(expect.objectContaining({ engine: expect.any(String) }));
    expect(JSON.stringify(rep)).not.toMatch(/Jane|Tester|Return/); // names in file names are personal data too (R2: synthetic name; round 1 used a real one)
  });

  it('contains no private digits (only sha256 hex, small counts, a timestamp and version strings)', async () => {
    const r = await redactBuffer(fx.read('text_layer.pdf'), { filename: 'a.pdf', mode: 'enforce' });
    expect(privateDigitsIn(r.report, { allowKeys: ['original_sha256', 'redacted_sha256', 'at', 'tool'] })).toEqual([]);
  });

  it('a held report records the reason and a null redacted hash', async () => {
    const r = await redactBuffer(fx.read('encrypted.pdf'), { filename: 'e.pdf', mode: 'enforce' });
    expect(r.report).toMatchObject({ outcome: 'held', reason: 'encrypted', redacted_sha256: null });
  });
});

describe('vaultOriginal', () => {
  it('copies into <vault>/<yyyy>/<sha256>-<name> with dir 0700 and file 0600, sha verified, source untouched', async () => {
    const src = path.join(tmp, 'Complete Return.pdf');
    fs.writeFileSync(src, fx.read('text_layer.pdf'));
    const before = fs.readFileSync(src);
    const vault = path.join(tmp, 'vault');
    const v = await vaultOriginal(src, { vaultDir: vault, now: () => '2026-10-15T12:00:00Z' });
    expect(v.sha256).toBe(sha(before));
    expect(v.vaultPath.startsWith(path.join(vault, '2026') + path.sep)).toBe(true);
    expect(path.basename(v.vaultPath).startsWith(`${v.sha256}-`)).toBe(true);
    expect(fs.statSync(path.dirname(v.vaultPath)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(v.vaultPath).mode & 0o777).toBe(0o600);
    expect(Buffer.compare(fs.readFileSync(v.vaultPath), before)).toBe(0);
    expect(Buffer.compare(fs.readFileSync(src), before)).toBe(0); // caller owns the move
  });

  it('never overwrites an existing vault file (idempotent for the same content)', async () => {
    const src = path.join(tmp, 'a.pdf');
    fs.writeFileSync(src, fx.read('text_layer.pdf'));
    const vault = path.join(tmp, 'vault');
    const a = await vaultOriginal(src, { vaultDir: vault, now: () => '2026-10-15T12:00:00Z' });
    const b = await vaultOriginal(src, { vaultDir: vault, now: () => '2026-10-15T12:00:00Z' });
    expect(b.vaultPath).toBe(a.vaultPath);
    expect(fs.readdirSync(path.dirname(a.vaultPath))).toHaveLength(1);
  });

  it('refuses a vault inside iCloud (the vault must stay local)', async () => {
    const src = path.join(tmp, 'a.pdf');
    fs.writeFileSync(src, fx.read('clean.pdf'));
    await expect(vaultOriginal(src, { vaultDir: path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'vault') })).rejects.toThrow(/icloud/i);
  });
});

describe('redactFile (the wrapper both producers call)', () => {
  it('enforce: writes <name>-REDACTED.pdf, vaults the original, writes <sha256>.redaction-report.json (0600) beside it, leaves inPath untouched', async () => {
    const inPath = path.join(tmp, 'Return.pdf');
    fs.writeFileSync(inPath, fx.read('text_layer.pdf'));
    const original = fs.readFileSync(inPath);
    const outDir = path.join(tmp, 'out');
    const vaultDir = path.join(tmp, 'vault');
    const r = await redactFile(inPath, { outDir, vaultDir, mode: 'enforce' });
    expect(r.outcome).toBe('redacted');
    expect(path.basename(r.outPath)).toBe('Return-REDACTED.pdf');
    expect(leaks(inspectPdf(fs.readFileSync(r.outPath), { ocr: false }).surfaces)).toEqual([]);
    expect(Buffer.compare(fs.readFileSync(r.vaultPath), original)).toBe(0);
    expect(path.dirname(r.reportPath)).toBe(path.dirname(r.vaultPath));
    expect(path.basename(r.reportPath)).toBe(`${sha(original)}.redaction-report.json`);
    expect(fs.statSync(r.reportPath).mode & 0o777).toBe(0o600);
    expect(Buffer.compare(fs.readFileSync(inPath), original)).toBe(0);
  });

  it('held: writes nothing to outDir or vault', async () => {
    const inPath = path.join(tmp, 'e.pdf');
    fs.writeFileSync(inPath, fx.read('encrypted.pdf'));
    const outDir = path.join(tmp, 'out');
    const vaultDir = path.join(tmp, 'vault');
    const r = await redactFile(inPath, { outDir, vaultDir, mode: 'enforce' });
    expect(r.outcome).toBe('held');
    expect(fs.existsSync(outDir) ? fs.readdirSync(outDir) : []).toEqual([]);
    expect(fs.existsSync(vaultDir) ? fs.readdirSync(vaultDir) : []).toEqual([]);
  });

  it('shadow and off: write nothing, return the outcome only', async () => {
    const inPath = path.join(tmp, 'a.pdf');
    fs.writeFileSync(inPath, fx.read('text_layer.pdf'));
    for (const mode of ['shadow', 'off']) {
      const r = await redactFile(inPath, { outDir: path.join(tmp, 'o'), vaultDir: path.join(tmp, 'v'), mode });
      expect(r.outPath).toBeUndefined();
      expect(r.vaultPath).toBeUndefined();
    }
    expect(fs.existsSync(path.join(tmp, 'v'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// ROUND 2 (red-team fold-in, 2026-10-14). IDs map to review-verdicts/{sonnet,opus}-redact-p0.md.
// ---------------------------------------------------------------------------------------------------------------

describe('[Sonnet M1, Opus D16/M6] shadow mode: observe only, across types, and writes nothing anywhere', () => {
  for (const name of ['image_only.pdf', 'bundle.zip', 'return.docx', 'notes.txt']) {
    it(`${name}: shadow -> detected, ORIGINAL bytes, counts > 0, report filename-free and digit-free`, async () => {
      const input = fx.read(name);
      const r = await redactBuffer(input, { filename: `Jane Q Tester ${name}`, mode: 'shadow' });
      expect(r.outcome).toBe('detected');
      expect(Buffer.compare(r.buffer, input)).toBe(0);
      expect(r.report.counts.ssn).toBeGreaterThan(0);
      expect(JSON.stringify(r.report)).not.toMatch(/Jane|Tester/);
      expect(privateDigitsIn(r.report, { allowKeys: ['original_sha256', 'redacted_sha256', 'at', 'tool'] })).toEqual([]);
    });
  }

  it('shadow leaves no temp files behind and writes no vault/out files', async () => {
    const w = watchTmpdir();
    try {
      const inPath = path.join(tmp, 'n.pdf');
      fs.writeFileSync(inPath, fx.read('image_only.pdf'));
      await redactFile(inPath, { outDir: path.join(tmp, 'o'), vaultDir: path.join(tmp, 'v'), mode: 'shadow' });
      expect(w.leftovers()).toEqual([]);
      expect(fs.existsSync(path.join(tmp, 'o'))).toBe(false);
      expect(fs.existsSync(path.join(tmp, 'v'))).toBe(false);
    } finally { w.restore(); }
  });
});

describe('[Sonnet M8, Opus D9/H17] the sidecar report', () => {
  it('has ONLY the declared keys (allow-list) and an ISO "at"', async () => {
    const r = await redactBuffer(fx.read('text_layer.pdf'), { filename: 'a.pdf', mode: 'enforce' });
    const allowed = ['schema', 'original_sha256', 'redacted_sha256', 'mode', 'outcome', 'reason', 'filename_ext', 'counts', 'tool', 'at'];
    for (const k of Object.keys(r.report)) expect(allowed, k).toContain(k);
    expect(r.report.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    for (const v of Object.values(r.report.tool)) expect(String(v)).toMatch(/^[A-Za-z0-9 ._+-]{1,40}$/);
  });

  it('filename_ext never echoes digits or a long "extension" (file named x.123456789)', async () => {
    const r = await redactBuffer(Buffer.from('nothing'), { filename: 'x.123456789', mode: 'enforce' });
    expect(r.report.filename_ext).not.toMatch(/\d{4,}/);
    expect(r.report.filename_ext.length).toBeLessThanOrEqual(6);
  });

  it('per-page counts are NOT in v1 (they aid inference); counts are per-file totals only', async () => {
    const r = await redactBuffer(fx.read('footer_every_page.pdf'), { filename: 'f.pdf', mode: 'enforce' });
    expect(Object.keys(r.report.counts).sort()).toEqual(['bank', 'dob', 'id', 'pin', 'ssn']);
  });
});

describe('[Sonnet H7, Opus H19/D12] vault hardening', () => {
  it('modes are explicit, not inherited from the umask (umask 000 still gives 0700 dirs incl. the ROOT, 0600 file)', async () => {
    const old = process.umask(0);
    try {
      const src = path.join(tmp, 'a.pdf');
      fs.writeFileSync(src, fx.read('text_layer.pdf'));
      const vault = path.join(tmp, 'vault');
      const v = await vaultOriginal(src, { vaultDir: vault, now: () => '2026-10-15T12:00:00Z' });
      expect(fs.statSync(vault).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.dirname(v.vaultPath)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(v.vaultPath).mode & 0o777).toBe(0o600);
    } finally { process.umask(old); }
  });

  it('an EXISTING group/world-readable vault root is refused (not silently used)', async () => {
    const src = path.join(tmp, 'a.pdf');
    fs.writeFileSync(src, fx.read('clean.pdf'));
    const vault = path.join(tmp, 'vault');
    fs.mkdirSync(vault, { mode: 0o755 });
    fs.chmodSync(vault, 0o755);
    await expect(vaultOriginal(src, { vaultDir: vault, now: () => '2026-10-15T12:00:00Z' })).rejects.toThrow(/perm|mode|0700/i);
  });

  it('refuses a vault whose REALPATH is in iCloud (symlink into Mobile Documents), and ~/Library/CloudStorage', async () => {
    const src = path.join(tmp, 'a.pdf');
    fs.writeFileSync(src, fx.read('clean.pdf'));
    const fakeHome = path.join(tmp, 'home');
    const icloud = path.join(fakeHome, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'v');
    fs.mkdirSync(icloud, { recursive: true });
    const link = path.join(tmp, 'innocent-vault');
    fs.symlinkSync(icloud, link);
    const savedHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      await expect(vaultOriginal(src, { vaultDir: link })).rejects.toThrow(/icloud|cloud/i);
      await expect(vaultOriginal(src, { vaultDir: path.join(fakeHome, 'Library', 'CloudStorage', 'GoogleDrive-x', 'v') })).rejects.toThrow(/cloud/i);
    } finally { process.env.HOME = savedHome; }
  });

  it('a symlink INSIDE the vault (e.g. <vault>/2026 -> elsewhere) is refused', async () => {
    const src = path.join(tmp, 'a.pdf');
    fs.writeFileSync(src, fx.read('clean.pdf'));
    const vault = path.join(tmp, 'vault');
    fs.mkdirSync(vault, { mode: 0o700 });
    fs.mkdirSync(path.join(tmp, 'elsewhere'), { mode: 0o700 });
    fs.symlinkSync(path.join(tmp, 'elsewhere'), path.join(vault, '2026'));
    await expect(vaultOriginal(src, { vaultDir: vault, now: () => '2026-10-15T12:00:00Z' })).rejects.toThrow(/symlink/i);
  });

  it('[Sonnet C2] the vault file NAME is sanitized (SSN masked, no traversal) and stays inside the vault', async () => {
    const src = path.join(tmp, 'W2 123-45-6789.pdf');
    fs.writeFileSync(src, fx.read('clean.pdf'));
    const vault = path.join(tmp, 'vault');
    const v = await vaultOriginal(src, { vaultDir: vault, now: () => '2026-10-15T12:00:00Z' });
    expect(textLeaks(v.vaultPath, ['ssn1'])).toEqual([]);
    expect(path.relative(vault, v.vaultPath).startsWith('..')).toBe(false);
  });
});

describe('[Sonnet C2/C6, Opus D14/H11/D18] redactFile: names, ordering, failures', () => {
  it('an SSN in the INPUT name never reaches outPath, vaultPath or reportPath', async () => {
    const inPath = path.join(tmp, 'W2 123-45-6789.pdf');
    fs.writeFileSync(inPath, fx.read('text_layer.pdf'));
    const r = await redactFile(inPath, { outDir: path.join(tmp, 'out'), vaultDir: path.join(tmp, 'vault'), mode: 'enforce' });
    expect(r.outcome).toBe('redacted');
    for (const p of [r.outPath, r.vaultPath, r.reportPath]) expect(textLeaks(p, ['ssn1']), p).toEqual([]);
    expect(path.basename(r.outPath)).toBe('W2 XXX-XX-6789-REDACTED.pdf');
  });

  it('no UNVERIFIED candidate ever exists in outDir: while the verifier runs, outDir is empty', async () => {
    const inPath = path.join(tmp, 'n.pdf');
    fs.writeFileSync(inPath, fx.read('text_layer.pdf'));
    const outDir = path.join(tmp, 'out');
    const seen = [];
    await redactFile(inPath, {
      outDir, vaultDir: path.join(tmp, 'vault'), mode: 'enforce',
      deps: { verify: async () => { seen.push(fs.existsSync(outDir) ? fs.readdirSync(outDir) : []); return { ok: true, residual: [] }; } },
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(s).toEqual([]);
  });

  it('a vault failure -> held:vault_failed, nothing left in outDir, inPath untouched', async () => {
    const inPath = path.join(tmp, 'n.pdf');
    fs.writeFileSync(inPath, fx.read('text_layer.pdf'));
    const before = fs.readFileSync(inPath);
    const vaultDir = path.join(tmp, 'not-a-dir');
    fs.writeFileSync(vaultDir, 'a file where the vault should be');
    const outDir = path.join(tmp, 'out');
    const r = await redactFile(inPath, { outDir, vaultDir, mode: 'enforce' });
    expect(r).toMatchObject({ outcome: 'held', reason: 'vault_failed' });
    expect(fs.existsSync(outDir) ? fs.readdirSync(outDir) : []).toEqual([]);
    expect(Buffer.compare(fs.readFileSync(inPath), before)).toBe(0);
  });

  it('output derivative is leak-free on EVERY surface incl. raw bytes (not only the text layer)', async () => {
    const inPath = path.join(tmp, 'Return.pdf');
    fs.writeFileSync(inPath, fx.read('incremental_history.pdf'));
    const r = await redactFile(inPath, { outDir: path.join(tmp, 'out'), vaultDir: path.join(tmp, 'vault'), mode: 'enforce' });
    if (r.outcome === 'redacted') expect(allLeaks(inspectPdf(fs.readFileSync(r.outPath), { ocr: false }).surfaces)).toEqual([]);
    else expect(r.outcome).toBe('held');
  });
});
