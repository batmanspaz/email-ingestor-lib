/**
 * sluice-local-transport.js — a @perfectcity/telemetry `Transport` (real
 * interface: `send(path, body): Promise<void>`) that appends JSON lines to a
 * local file instead of POSTing to a central ingest Worker.
 *
 * Stand-in until the central Health Monitor ingest Worker is actually deployed
 * (verified this session: TELEMETRY_INGEST_URL/TELEMETRY_HMAC_KEY are not set
 * anywhere, no other product has adopted the client yet). Swapping to the
 * library's own `httpTransport({baseUrl, hmacKey})` later is a one-line change
 * at the call site — this module, the schemas, and the rest of the dispatcher
 * don't change.
 */

import fs from 'node:fs';
import path from 'node:path';

export function createLocalFileTransport(logPath) {
  return {
    async send(ingestPath, body) {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, JSON.stringify({ path: ingestPath, body }) + '\n', 'utf8');
    },
  };
}
