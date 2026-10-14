// P0 RED — nothing leaves the machine before redaction completes. Expected at end of Phase 0: E_NOT_IMPLEMENTED.
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactBuffer } from '../../pii-redact.js';
import { buildFixtures, installNetworkGuard } from './support/harness.mjs';

let fx;
let guard;
beforeAll(() => { fx = buildFixtures(); }, 120_000);
afterEach(() => { guard?.restore(); });

describe('no remote calls while redacting', () => {
  for (const name of ['text_layer.pdf', 'image_only.pdf', 'mixed.pdf', 'notes.txt', 'bundle.zip']) {
    it(`${name}: zero fetch calls and zero remote-OCR calls (image pages use LOCAL tesseract)`, async () => {
      guard = installNetworkGuard();
      const remote = [];
      const r = await redactBuffer(fx.read(name), {
        filename: name,
        mode: 'enforce',
        deps: { remoteOcr: async (...a) => { remote.push(a); throw new Error('remote OCR forbidden'); } },
      });
      expect(['redacted', 'clean']).toContain(r.outcome);
      expect(guard.calls).toEqual([]);
      expect(remote).toEqual([]);
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
