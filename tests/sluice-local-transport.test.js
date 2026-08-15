// sluice-local-transport.js — a Transport (per @perfectcity/telemetry's real
// interface: send(path, body)) that appends JSON lines to a local file. Stand-in
// until the central ingest Worker is deployed — swapping to httpTransport is a
// one-line change since the interface is identical. Byte-identical to intake's
// own copy (src/lib/sluice-local-transport.js) — promoted here in the Sluice
// entity-cutover Phase 2 so every entity's producer can use the same stand-in,
// not just the dispatcher.

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalFileTransport } from '../sluice-local-transport.js';

let logPath;
beforeEach(() => {
  logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sluice-transport-')), 'telemetry.jsonl');
});

describe('createLocalFileTransport', () => {
  it('appends one JSON line per send(), tagged with the path', async () => {
    const transport = createLocalFileTransport(logPath);
    await transport.send('/ingest/health', { status: 'ok' });
    await transport.send('/ingest/analytics', { events: [] });

    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines.length).toBe(2);
    const first = JSON.parse(lines[0]);
    expect(first.path).toBe('/ingest/health');
    expect(first.body.status).toBe('ok');
    const second = JSON.parse(lines[1]);
    expect(second.path).toBe('/ingest/analytics');
  });

  it('creates the parent directory if missing', async () => {
    const nested = path.join(path.dirname(logPath), 'nested', 'telemetry.jsonl');
    const transport = createLocalFileTransport(nested);
    await transport.send('/ingest/health', { status: 'ok' });
    expect(fs.existsSync(nested)).toBe(true);
  });
});
