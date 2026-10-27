/**
 * engines-audit-2539.test.js — tasks.db #2539.
 *
 * 1. engines.node must not understate what the dependency tree really needs:
 *    googleapis requires node >=22 and vitest 5 requires ^22.12, so the old
 *    ">=20.3" promised an install that could not actually work. The floor is
 *    now >=22.12.
 * 2. CI must run a node that satisfies that floor (a CI pinned below it would
 *    stay green while lying about support).
 * 3. The two dev-only high advisories found by `npm audit` on 2026-10-26 must
 *    stay fixed in the lockfile: vite 8.3.0-8.3.2 (via vitest) and
 *    fast-uri 3.0.0-3.1.8 (via ajv).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

const parse = (v) => v.split('.').map((n) => Number.parseInt(n, 10) || 0);
function cmp(a, b) {
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  }
  return 0;
}
const inRange = (v, lo, hi) => cmp(v, lo) >= 0 && cmp(v, hi) <= 0;

describe('engines.node floor (#2539)', () => {
  it('package.json engines.node is >=22.12', () => {
    const pkg = readJson(path.join(ROOT, 'package.json'));
    expect(pkg.engines?.node).toBe('>=22.12');
  });

  it('package-lock.json root entry carries the same engines floor', () => {
    const lock = readJson(path.join(ROOT, 'package-lock.json'));
    expect(lock.packages[''].engines?.node).toBe('>=22.12');
  });

  it('CI setup-node version satisfies >=22.12', () => {
    const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    const m = ci.match(/node-version:\s*["']?([^"'\s]+)["']?/);
    expect(m, 'ci.yml must set setup-node node-version').toBeTruthy();
    const v = m[1];
    // "22.x" style resolves to the latest 22 line (>=22.12); an exact pin
    // must itself be >=22.12.
    const xMajor = v.match(/^(\d+)\.x$/);
    if (xMajor) {
      expect(Number(xMajor[1])).toBeGreaterThanOrEqual(22);
    } else {
      expect(cmp(v, '22.12.0')).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('dev-only high advisories stay fixed in the lockfile (#2539)', () => {
  const lock = readJson(path.join(ROOT, 'package-lock.json'));
  const versionsOf = (name) =>
    Object.entries(lock.packages)
      .filter(([k]) => k === `node_modules/${name}` || k.endsWith(`/node_modules/${name}`))
      .map(([, v]) => v.version);

  it('no vite in the vulnerable 8.3.0-8.3.2 range', () => {
    const vs = versionsOf('vite');
    expect(vs.length).toBeGreaterThan(0);
    for (const v of vs) expect(inRange(v, '8.3.0', '8.3.2'), `vite ${v}`).toBe(false);
  });

  it('no fast-uri in the vulnerable 3.0.0-3.1.8 range', () => {
    const vs = versionsOf('fast-uri');
    expect(vs.length).toBeGreaterThan(0);
    for (const v of vs) expect(inRange(v, '3.0.0', '3.1.8'), `fast-uri ${v}`).toBe(false);
  });
});
