/**
 * telemetry-pin.test.js — tasks.db #2470.
 *
 * This lib pins @perfectcity/telemetry by commit SHA, and every downstream
 * email-ingestor keeps its own telemetry pin in LOCKSTEP with this one (see
 * their tests/telemetry-pin tests, tasks.db #1094). This test is the lib-side
 * half of that contract: it asserts the pin, the lockfile and the INSTALLED
 * package all agree on telemetry 0.6.0 (batmanspaz/telemetry PR #15 merge
 * commit), and that the zod that telemetry actually resolves is the zod 4
 * line with the GHSA-mrhx-c7xc-m3w5 fix (>= 4.6.6). A package.json-only bump
 * with a stale lockfile, or a nested zod 3 copy, fails here.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TELEMETRY_SHA = '396821cca10376117c7c4e25e7cf8386319bcdf9';
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function semverGte(v, min) {
  const a = v.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

describe('@perfectcity/telemetry pin (#2470)', () => {
  it('package.json pins telemetry to the PR #15 merge commit', () => {
    const pkg = readJson(path.join(ROOT, 'package.json'));
    expect(pkg.dependencies['@perfectcity/telemetry']).toBe(
      `git+https://github.com/batmanspaz/telemetry.git#${TELEMETRY_SHA}`,
    );
  });

  it('package-lock.json resolves telemetry to the same commit', () => {
    const lock = readJson(path.join(ROOT, 'package-lock.json'));
    const entry = lock.packages['node_modules/@perfectcity/telemetry'];
    expect(entry).toBeDefined();
    expect(entry.resolved).toContain(TELEMETRY_SHA);
    expect(entry.version).toBe('0.6.0');
  });

  it('the installed telemetry is 0.6.0 and resolves zod >= 4.6.6', () => {
    const req = createRequire(path.join(ROOT, 'package.json'));
    const telPkgPath = req.resolve('@perfectcity/telemetry/package.json');
    expect(readJson(telPkgPath).version).toBe('0.6.0');
    const telReq = createRequire(telPkgPath);
    const zodVersion = readJson(telReq.resolve('zod/package.json')).version;
    expect(zodVersion.split('.')[0]).toBe('4');
    expect(semverGte(zodVersion, '4.6.6')).toBe(true);
  });
});
