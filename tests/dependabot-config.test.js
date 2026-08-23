/**
 * dependabot-config.test.js — guards .github/dependabot.yml against path rot.
 * TEST-FIRST, red before the fix.
 *
 * Incident (2026-08-15 → 2026-08-23): cc0e45a (#34) moved package.json to the
 * repo root and deleted the nested `email-ingestor-lib/package.json`, but
 * `.github/dependabot.yml` kept pointing at `directory: "/email-ingestor-lib"`.
 * Every Dependabot run since aborted with
 *   dependency_file_not_found: "/email-ingestor-lib/package.json not found"
 * so the repo received NO automated dependency security updates for five weeks.
 *
 * The same restructure broke CI in exactly the same way. CI was fixed in
 * 361ef22 (#36); dependabot.yml was missed. It was the second victim of one
 * commit, and nothing existed to catch it — a failing Dependabot run is
 * visible in `gh run list` and nowhere a human looks.
 *
 * This test is that missing check. It runs in the normal suite, so a future
 * restructure that moves a manifest turns the suite red instead of silently
 * switching dependency updates off.
 *
 * PARSING NOTE: no YAML parser is installed and none is added for a 9-line
 * hand-maintained config (Paul's call, 2026-08-23). The extraction below is a
 * targeted regex over `- package-ecosystem:` / `directory:` pairs, not a real
 * YAML parse — it would miss exotic syntax (flow mappings, anchors, multi-line
 * scalars). If this file ever grows beyond simple block style, swap in `yaml`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(REPO_ROOT, '.github', 'dependabot.yml');

/** The manifest each ecosystem's `directory` is expected to contain. */
const MANIFEST_BY_ECOSYSTEM = {
  npm: 'package.json',
  'github-actions': null, // scans .github/workflows, no manifest file to assert
};

/** Targeted extraction — see PARSING NOTE above. Returns [{ecosystem, directory}]. */
function parseUpdateEntries(yaml) {
  return yaml
    .split(/^\s*-\s+(?=package-ecosystem:)/m)
    .slice(1)
    .map((block) => ({
      ecosystem: block.match(/package-ecosystem:\s*["']?([^"'\s]+)/)?.[1],
      directory: block.match(/^\s*directory:\s*["']?([^"'\s]+)/m)?.[1],
    }));
}

describe('.github/dependabot.yml', () => {
  it('exists and is non-empty', () => {
    expect(existsSync(CONFIG_PATH)).toBe(true);
    expect(readFileSync(CONFIG_PATH, 'utf8').trim().length).toBeGreaterThan(0);
  });

  it('declares at least one update entry the parser can actually read', () => {
    // Guards the parser itself: a regex that silently matches nothing would
    // make every assertion below vacuously pass — the exact failure shape this
    // whole file exists to catch.
    const entries = parseUpdateEntries(readFileSync(CONFIG_PATH, 'utf8'));
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.ecosystem, 'every entry must declare package-ecosystem').toBeTruthy();
      expect(e.directory, `entry "${e.ecosystem}" must declare a directory`).toBeTruthy();
    }
  });

  it('every declared directory EXISTS in this repo', () => {
    for (const { ecosystem, directory } of parseUpdateEntries(readFileSync(CONFIG_PATH, 'utf8'))) {
      const abs = path.join(REPO_ROOT, directory);
      expect(existsSync(abs), `${ecosystem}: directory "${directory}" does not exist`).toBe(true);
    }
  });

  it('every declared directory CONTAINS the manifest its ecosystem needs', () => {
    // The live 2026-08-15 bug: the directory key survived a restructure that
    // deleted the manifest under it.
    for (const { ecosystem, directory } of parseUpdateEntries(readFileSync(CONFIG_PATH, 'utf8'))) {
      const manifest = MANIFEST_BY_ECOSYSTEM[ecosystem];
      if (!manifest) continue;
      const abs = path.join(REPO_ROOT, directory, manifest);
      expect(existsSync(abs), `${ecosystem}: no ${manifest} at "${directory}"`).toBe(true);
    }
  });

  it("covers this repo's root package.json exactly once — no gap, no duplicate", () => {
    const npmDirs = parseUpdateEntries(readFileSync(CONFIG_PATH, 'utf8'))
      .filter((e) => e.ecosystem === 'npm')
      .map((e) => path.normalize(e.directory));
    expect(existsSync(path.join(REPO_ROOT, 'package.json'))).toBe(true);
    expect(npmDirs.filter((d) => d === path.sep || d === '/')).toHaveLength(1);
  });
});
