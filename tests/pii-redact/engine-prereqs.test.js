// GREEN guard (R2, Sonnet M10): engine tests must FAIL, not silently skip, on a machine without the local engine.
// If this goes red on a CI runner, provision pymupdf + tesseract there; never skip the PII suites.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';

describe('local redaction engine prerequisites are present', () => {
  it('python3 can import PyMuPDF (fitz) and Pillow', () => {
    const v = execFileSync('python3', ['-c', 'import fitz, PIL; print(fitz.VersionBind)']).toString().trim();
    expect(v).toMatch(/^\d+\.\d+/);
  });
  it('tesseract is on PATH', () => {
    expect(execFileSync('tesseract', ['--version']).toString()).toMatch(/tesseract/i);
  });
});
