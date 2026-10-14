// GREEN guard (permanent): the redaction module must never grow a remote-model dependency.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

describe('redaction module dependency surface', () => {
  it('the module has no Anthropic/Claude client in its dependency surface', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const root = path.join(here, '..', '..');
    const src = fs.readFileSync(path.join(root, 'pii-redact.js'), 'utf8');
    expect(src).not.toMatch(/@anthropic-ai|anthropic-gateway|api\.anthropic\.com|messages\.create/);
    const py = fs.readFileSync(path.join(root, 'pii-redact', 'redact_pdf.py'), 'utf8');
    expect(py).not.toMatch(/anthropic|requests|urllib|http\.client|socket/);
  });
});
