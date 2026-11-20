/**
 * tasks.db #3215 (security review 3118, MEDIUM #4): the JSONL sink still
 * carried a per-message `snippet` field and a first-char-masked sender, and
 * the file was never rotated. Contract:
 *   - message() writes NO `snippet` key at all (not even a length marker).
 *   - message()/forward() write the sender as DOMAIN ONLY (`fromDomain`),
 *     no `from` key; messageId stays as the dedupe/debug key.
 *   - subject stays length-only ([redacted:N]).
 *   - new log files are created mode 0600.
 *   - size-based rotation: when the next append would push the file past
 *     maxBytes (default 10 MB, dev-rules §15), file -> .1, .1 -> .2 ... keep N
 *     (default 5); the oldest beyond N is dropped by the rename chain.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createLogger, DEFAULT_MAX_BYTES, DEFAULT_KEEP } from '../log.js';

let tmpDir;
let logPath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-3215-'));
  logPath = path.join(tmpDir, 'email-ingestor.jsonl');
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const META = {
  id: 'msg-3215',
  snippet: 'Hi, my order 1234 never arrived, call me at 555-0100',
  payload: {
    headers: [
      { name: 'From', value: '"Jane Customer" <jane.customer@example.org>' },
      { name: 'Subject', value: 'Where is my order 1234' },
    ],
  },
};

const lines = (p = logPath) =>
  fs.readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

describe('#3215 message(): no snippet, domain-only sender', () => {
  it('writes no snippet key and no from key', () => {
    createLogger('collagesoup', logPath).message(META, { category: 'order' });
    const [rec] = lines();
    expect(rec).not.toHaveProperty('snippet');
    expect(rec).not.toHaveProperty('from');
    expect(rec.fromDomain).toBe('example.org');
    expect(rec.messageId).toBe('msg-3215');
    expect(rec.subject).toBe('[redacted:22]');
    expect(rec.category).toBe('order');
  });

  it('no part of the local-part, display name or snippet text reaches disk', () => {
    createLogger('collagesoup', logPath).message(META);
    const bytes = fs.readFileSync(logPath, 'utf8');
    for (const raw of ['jane', 'Jane Customer', 'j***@', '555-0100', 'never arrived', 'Where is my order']) {
      expect(bytes).not.toContain(raw);
    }
  });

  it('a From with no parseable address is [redacted], not leaked', () => {
    const meta = { ...META, payload: { headers: [{ name: 'From', value: 'Jane Customer' }] } };
    createLogger('collagesoup', logPath).message(meta);
    const [rec] = lines();
    expect(rec.fromDomain).toBe('[redacted]');
    expect(fs.readFileSync(logPath, 'utf8')).not.toContain('Jane');
  });

  it('missing From header writes no sender at all', () => {
    const meta = { id: 'x', payload: { headers: [] } };
    createLogger('collagesoup', logPath).message(meta);
    const [rec] = lines();
    expect(rec.fromDomain).toBeUndefined();
  });

  it('caller extra cannot smuggle a snippet back in', () => {
    createLogger('collagesoup', logPath).message(META, { snippet: META.snippet, mode: 'sluice' });
    const [rec] = lines();
    expect(rec).not.toHaveProperty('snippet');
    expect(rec.mode).toBe('sluice');
  });
});

describe('#3215 forward(): domain-only sender', () => {
  it('writes fromDomain, no from', () => {
    createLogger('collagesoup', logPath).forward(META, 'router@x.com', 'r1');
    const [rec] = lines();
    expect(rec).not.toHaveProperty('from');
    expect(rec.fromDomain).toBe('example.org');
    expect(rec.target).toBe('router@x.com');
    expect(fs.readFileSync(logPath, 'utf8')).not.toContain('jane');
  });
});

describe('#3215 file mode', () => {
  it('creates a new log file with mode 0600', () => {
    createLogger('collagesoup', logPath).runStart({ accounts: 1 });
    expect(fs.statSync(logPath).mode & 0o777).toBe(0o600);
  });
});

describe('#3215 size-based rotation', () => {
  it('defaults follow dev-rules §15 (10 MB) and keep 5', () => {
    expect(DEFAULT_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(DEFAULT_KEEP).toBe(5);
  });

  it('does not rotate below the threshold', () => {
    const log = createLogger('collagesoup', logPath, { maxBytes: 100_000 });
    for (let i = 0; i < 5; i++) log.runEnd({ i });
    expect(fs.existsSync(`${logPath}.1`)).toBe(false);
    expect(lines()).toHaveLength(5);
  });

  it('rotates to .1 when the next append would exceed maxBytes', () => {
    const log = createLogger('collagesoup', logPath, { maxBytes: 300 });
    for (let i = 0; i < 6; i++) log.runEnd({ i, pad: 'x'.repeat(40) });
    expect(fs.existsSync(`${logPath}.1`)).toBe(true);
    expect(fs.statSync(logPath).size).toBeLessThanOrEqual(300);
    // nothing lost across the rotated files (oldest first) + the live file
    const rotated = [5, 4, 3, 2, 1].map((n) => `${logPath}.${n}`).filter((p) => fs.existsSync(p));
    const all = [...rotated.flatMap((p) => lines(p)), ...lines()];
    expect(all.map((r) => r.i)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('keeps at most N rotated files, shifting .1 -> .2 ...', () => {
    const log = createLogger('collagesoup', logPath, { maxBytes: 150, keep: 2 });
    for (let i = 0; i < 20; i++) log.runEnd({ i, pad: 'y'.repeat(60) });
    expect(fs.existsSync(`${logPath}.1`)).toBe(true);
    expect(fs.existsSync(`${logPath}.2`)).toBe(true);
    expect(fs.existsSync(`${logPath}.3`)).toBe(false);
    // newest record in live file, older in .1, older still in .2
    const live = lines().map((r) => r.i);
    const one = lines(`${logPath}.1`).map((r) => r.i);
    const two = lines(`${logPath}.2`).map((r) => r.i);
    expect(Math.min(...live)).toBeGreaterThan(Math.max(...one));
    expect(Math.min(...one)).toBeGreaterThan(Math.max(...two));
    expect(live).toContain(19);
  });

  it('rotated files stay mode 0600', () => {
    const log = createLogger('collagesoup', logPath, { maxBytes: 150 });
    for (let i = 0; i < 6; i++) log.runEnd({ i, pad: 'z'.repeat(60) });
    expect(fs.statSync(`${logPath}.1`).mode & 0o777).toBe(0o600);
    expect(fs.statSync(logPath).mode & 0o777).toBe(0o600);
  });

  it('rotates an existing oversized file left by an older version', () => {
    fs.writeFileSync(logPath, 'q'.repeat(500) + '\n');
    createLogger('collagesoup', logPath, { maxBytes: 300 }).runStart({});
    expect(fs.readFileSync(`${logPath}.1`, 'utf8')).toContain('qqqq');
    expect(lines()).toHaveLength(1);
  });

  it('a REAL rotation failure (live -> .1 rename throws) warns, never throws, and still writes the record', () => {
    const log = createLogger('collagesoup', logPath, { maxBytes: 100 });
    log.runEnd({ pad: 'a'.repeat(120) });
    const realRename = fs.renameSync;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((src, dst) => {
      if (src === logPath && dst === `${logPath}.1`) throw Object.assign(new Error('EACCES: simulated'), { code: 'EACCES' });
      return realRename(src, dst);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => log.runEnd({ marker: 'after-fail' })).not.toThrow();
    expect(renameSpy).toHaveBeenCalledWith(logPath, `${logPath}.1`);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Rotation failed .*EACCES: simulated/));
    expect(fs.existsSync(`${logPath}.1`)).toBe(false); // rotation really did not happen
    expect(fs.readFileSync(logPath, 'utf8')).toContain('after-fail');
  });
});

describe('#3215 mode 0600 enforced on existing files, not just on create', () => {
  it('tightens a pre-existing 0644 live file to 0600 on write', () => {
    fs.writeFileSync(logPath, '{"old":1}\n', { mode: 0o644 });
    fs.chmodSync(logPath, 0o644);
    createLogger('collagesoup', logPath).runStart({});
    expect(fs.statSync(logPath).mode & 0o777).toBe(0o600);
  });

  it('tightens pre-existing 0644 rotated files as the chain shifts them', () => {
    fs.writeFileSync(logPath, 'q'.repeat(500) + '\n');
    fs.chmodSync(logPath, 0o644);
    fs.writeFileSync(`${logPath}.1`, 'old1\n');
    fs.chmodSync(`${logPath}.1`, 0o644);
    createLogger('collagesoup', logPath, { maxBytes: 300 }).runStart({});
    for (const p of [logPath, `${logPath}.1`, `${logPath}.2`]) {
      expect(fs.statSync(p).mode & 0o777, p).toBe(0o600);
    }
  });
});

describe('#3215 re-stat before the rename chain', () => {
  it('skips rotation if the file shrank (another writer rotated) between the size check and the rename', () => {
    fs.writeFileSync(logPath, 'q'.repeat(500) + '\n', { mode: 0o600 });
    const log = createLogger('collagesoup', logPath, { maxBytes: 300 });
    const realStat = fs.statSync;
    let calls = 0;
    vi.spyOn(fs, 'statSync').mockImplementation((p, ...rest) => {
      if (p === logPath && ++calls === 2) {
        // simulate a concurrent rotation landing between the two stats
        fs.renameSync(logPath, `${logPath}.other`);
        fs.writeFileSync(logPath, '', { mode: 0o600 });
      }
      return realStat(p, ...rest);
    });
    log.runStart({});
    expect(fs.existsSync(`${logPath}.1`)).toBe(false);
    expect(lines()).toHaveLength(1);
  });
});
