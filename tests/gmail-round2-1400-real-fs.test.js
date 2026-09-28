/**
 * PR #68 round 2 — checks that need the REAL filesystem (no fs mock):
 *  - a genuine chmod 000 token file yields a path-free typed error (skipped as root / when the OS
 *    ignores permissions);
 *  - package.json engines (AbortSignal.any needs Node >= 20.3) and README notes.
 * HOME is pointed at a temp dir BEFORE gmail.js is imported, so nothing under the real
 * ~/claude/shared/config/credentials is ever read.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ADDR = 'chmod.person@example.com';
const root = path.resolve(new URL('..', import.meta.url).pathname);
let tmpHome; let realHome; let GmailClient; let tokenPath; let canTestChmod;

beforeAll(async () => {
  realHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'eil-1400-'));
  const credDir = path.join(tmpHome, 'claude/shared/config/credentials');
  fs.mkdirSync(credDir, { recursive: true });
  tokenPath = path.join(credDir, `${ADDR}.json`);
  fs.writeFileSync(tokenPath, JSON.stringify({ refresh_token: 'FAKE', client_id: 'a', client_secret: 'b' }));
  fs.chmodSync(tokenPath, 0o000);
  try { fs.readFileSync(tokenPath); canTestChmod = false; } catch { canTestChmod = true; }
  process.env.HOME = tmpHome;
  vi.resetModules();
  ({ GmailClient } = await import('../gmail.js'));
});
afterAll(() => {
  process.env.HOME = realHome;
  try { fs.chmodSync(tokenPath, 0o600); } catch { /* best effort */ }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('real chmod 000 token file', () => {
  it('fromTokenFile throws TOKEN_FILE_INVALID with no path, not a raw EACCES', (ctx) => {
    if (!canTestChmod) return ctx.skip();
    let err;
    try { GmailClient.fromTokenFile(ADDR, 'test-entity'); } catch (e) { err = e; }
    expect(err?.code).toBe('TOKEN_FILE_INVALID');
    expect(err.message).toContain('token file is not readable');
    const all = [err.message, JSON.stringify(err), String(err.path)].join('\n');
    expect(all).not.toContain(tmpHome);
    expect(all).not.toContain(`${ADDR}.json`);
    expect(all).not.toMatch(/EACCES/);
    expect(err.path).toBeUndefined();
  });
});

describe('packaging + docs', () => {
  it('package.json declares node >=20.3 (AbortSignal.any)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.engines?.node).toBe('>=20.3');
  });
  it('README documents: unexpectedScopes display-only + count, timeout 0, accountLabel', () => {
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    expect(readme).toMatch(/unexpectedScopes[^.]*display-only/i);
    expect(readme).toMatch(/unexpectedScopeCount/);
    expect(readme).toMatch(/`0`\s+is\s+accepted and means\s+\*\*no timeout\*\*/);
    expect(readme).toMatch(/accountLabel/);
    expect(readme).toMatch(/not readable/i);
  });
});
