/**
 * Unit tests for log.js — createLogger()
 *
 * Focus: PII must never reach the persistent JSONL sink (SOC 2). The
 * message() and forward() ops historically wrote the FULL unmasked From
 * header, Subject, and ~200-char body snippet straight to disk. Every raw
 * email local-part, subject string, and snippet string must be masked /
 * redacted before any append.
 *
 * The logger is exercised against a real temp file and the written bytes
 * are scanned for leaks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createLogger } from '../log.js';

let tmpDir;
let logPath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-test-'));
  logPath = path.join(tmpDir, 'email-ingestor.jsonl');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeMeta({ from, subject, snippet }) {
  return {
    id: 'msg-123',
    snippet,
    payload: {
      headers: [
        { name: 'From', value: from },
        { name: 'Subject', value: subject },
      ],
    },
  };
}

function readLines() {
  return fs.readFileSync(logPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
}

// Raw PII that must NEVER appear anywhere in the written log bytes.
const RAW = {
  fromLocal: 'paul.steinberg',                 // email local-part of the sender
  fromName: 'Paul Steinberg',                  // display name (also PII)
  subject: 'Wire transfer confirmation 88231', // subject line
  snippet: 'Your routing number is 021000021 and the balance is $5,000', // body preview
};

const META = makeMeta({
  from: `"${RAW.fromName}" <${RAW.fromLocal}@gmail.com>`,
  subject: RAW.subject,
  snippet: RAW.snippet,
});

describe('createLogger — PII masking on the persistent sink', () => {
  it('message(): no raw email-local / subject / snippet text reaches the log file', () => {
    const log = createLogger('perfectcity', logPath);
    log.message(META);

    const bytes = fs.readFileSync(logPath, 'utf8');
    for (const [field, raw] of Object.entries(RAW)) {
      expect(bytes, `raw ${field} leaked into the log`).not.toContain(raw);
    }
  });

  it('message(): masks the sender to first-char + ***@domain and keeps the messageId', () => {
    const log = createLogger('perfectcity', logPath);
    log.message(META);

    const [rec] = readLines();
    expect(rec.op).toBe('message');
    expect(rec.messageId).toBe('msg-123');
    expect(rec.from).toContain('p***@gmail.com'); // masked address present (not just dropped)
  });

  it('forward(): no raw email-local / subject text reaches the log file', () => {
    const log = createLogger('perfectcity', logPath);
    log.forward(META, 'router@perfectcity.com', 'pc-rule');

    const bytes = fs.readFileSync(logPath, 'utf8');
    expect(bytes).not.toContain(RAW.fromLocal);
    expect(bytes).not.toContain(RAW.fromName);
    expect(bytes).not.toContain(RAW.subject);

    const [rec] = readLines();
    expect(rec.op).toBe('forward');
    expect(rec.target).toBe('router@perfectcity.com');
    expect(rec.rule).toBe('pc-rule');
  });
});
