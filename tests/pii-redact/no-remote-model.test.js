// GREEN guard (permanent): the redaction module must never grow a remote-model dependency.
// R2 (Opus D20/M4): walk the IMPORT GRAPH of pii-redact.js (static + dynamic imports, relative files recursively) and
// every python file under pii-redact/, instead of text-matching two files. Forbidden: any Anthropic client/gateway,
// the lib's own Claude-vision OCR module (./ocr.js), HTTP clients, raw sockets.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const FORBIDDEN_JS = [/^@anthropic-ai\//, /anthropic-gateway/, /^@paul\//, /(^|\/)ocr(\.js)?$/, /claude/i, /^node:(http|https|net|tls|dgram|dns)$/, /^(http|https|net|tls|dgram|dns)$/, /^(axios|node-fetch|undici|got|googleapis)$/];
const FORBIDDEN_PY = /^\s*(import|from)\s+(anthropic|requests|urllib|http|socket|httpx|aiohttp|ssl)\b/m;

function importsOf(file) {
  const src = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const specs = [];
  for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    specs.push(m[1] ?? m[2] ?? m[3] ?? m[4]);
  }
  return specs;
}

function walk(entry) {
  const seen = new Set();
  const bad = [];
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const spec of importsOf(f)) {
      if (FORBIDDEN_JS.some((re) => re.test(spec))) bad.push(`${path.relative(root, f)} -> ${spec}`);
      if (spec.startsWith('.')) {
        const p = path.resolve(path.dirname(f), spec);
        const cand = [p, `${p}.js`, `${p}.mjs`, path.join(p, 'index.js')].find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
        if (cand) stack.push(cand);
      }
    }
  }
  return { seen: [...seen].map((f) => path.relative(root, f)), bad };
}

describe('redaction module dependency surface', () => {
  it('the import graph of pii-redact.js reaches no remote model, no Claude-vision OCR, no network client', () => {
    const { seen, bad } = walk(path.join(root, 'pii-redact.js'));
    expect(seen).toContain('pii-redact.js');
    expect(bad).toEqual([]);
  });

  it('every python file under pii-redact/ imports no network or model module', () => {
    const dir = path.join(root, 'pii-redact');
    const files = fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.py'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(FORBIDDEN_PY.test(fs.readFileSync(path.join(dir, f), 'utf8')), f).toBe(false);
  });

  it('the walker is not vacuous: it flags a forbidden import when one exists (guards the guard)', () => {
    const tmp = fs.mkdtempSync(path.join(root, 'tests', 'pii-redact', '.walk-'));
    try {
      fs.writeFileSync(path.join(tmp, 'a.js'), "import x from './b.js';\nexport default x;\n");
      fs.writeFileSync(path.join(tmp, 'b.js'), "// import nothing here\nconst m = await import('@anthropic-ai/sdk');\nexport default m;\n");
      expect(walk(path.join(tmp, 'a.js')).bad.length).toBe(1);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});
