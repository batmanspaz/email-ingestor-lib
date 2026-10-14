// P0 RED — nothing leaves the machine before redaction completes. Expected at end of Phase 0: E_NOT_IMPLEMENTED.
// R2 (Opus M4/D20, Sonnet M2): the guard now covers fetch, node:http/https, net.Socket#connect and dns.lookup in this
// process AND every socket/getaddrinfo in the python engine subprocess (sitecustomize marker). The round-1 phantom
// `deps.remoteOcr` collaborator (an implementation could simply ignore it, making the assertion vacuous) is gone; the
// "no remote model in the import graph" half lives in the GREEN no-remote-model.test.js.
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactBuffer } from '../../pii-redact.js';
import { buildFixtures, installNetworkGuard } from './support/harness.mjs';

let fx;
let guard;
beforeAll(() => { fx = buildFixtures(); }, 120_000);
afterEach(() => { guard?.restore(); guard = null; });

describe('no remote calls while redacting', () => {
  for (const name of ['text_layer.pdf', 'image_only.pdf', 'mixed.pdf', 'image_on_text_page.pdf', 'notes.txt', 'bundle.zip', 'return_full.docx', 'sheet.xlsx', 'w2_scan.png']) {
    it(`${name}: zero network activity in node AND in the python engine (image pages/files use LOCAL tesseract)`, async () => {
      guard = installNetworkGuard();
      const r = await redactBuffer(fx.read(name), { filename: name, mode: 'enforce' });
      expect(['redacted', 'clean', 'held']).toContain(r.outcome);
      expect(guard.calls).toEqual([]);
      expect(guard.pythonNetworkUsed()).toBe(false);
    });
  }

  it('the engine entry point exists and runs (not a stub): redact_pdf.py exits 0 on a clean fixture', async () => {
    const { execFileSync } = await import('node:child_process');
    const os = await import('node:os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-cli-'));
    const here = path.dirname(fileURLToPath(import.meta.url));
    const out = execFileSync('python3', [
      path.join(here, '..', '..', 'pii-redact', 'redact_pdf.py'),
      '--in', fx.path('clean.pdf'), '--out', path.join(tmp, 'o.pdf'), '--report', path.join(tmp, 'r.json'), '--mode', 'enforce',
    ]);
    expect(JSON.parse(out.toString()).outcome).toBe('clean');
  });
});
