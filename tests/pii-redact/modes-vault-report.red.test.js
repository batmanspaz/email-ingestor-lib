// P0 RED — mode flag, vault, sidecar report, file-level wrapper. Expected at end of Phase 0: E_NOT_IMPLEMENTED.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactBuffer, redactFile, vaultOriginal, REPORT_SCHEMA } from '../../pii-redact.js';
import { buildFixtures, inspectPdf, leaks, privateDigitsIn } from './support/harness.mjs';

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
    const r = await redactBuffer(input, { filename: 'Samantha Steinberg 2025 Return.pdf', mode: 'enforce' });
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
    expect(JSON.stringify(rep)).not.toMatch(/Samantha|Steinberg|Return/); // names in file names are personal data too
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
