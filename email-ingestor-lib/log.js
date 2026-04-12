/**
 * log.js — Append-only JSONL email log for entity ingestors
 *
 * Each entity writes to ~/claude/{entity}/logs/email-ingestor.jsonl
 */

import fs from 'fs';
import path from 'path';
import { GmailClient } from './gmail.js';

/**
 * Create a logger for an entity.
 * @param {string} entity — entity name (carma, collagesoup, perfectcity, personal)
 * @param {string} logPath — full path to the .jsonl log file
 * @returns {object} logger with methods: message(), forward(), error(), runStart(), runEnd()
 */
export function createLogger(entity, logPath) {
  const dir = path.dirname(logPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  function append(record) {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      entity,
      ...record,
    }) + '\n';

    try {
      fs.appendFileSync(logPath, line, 'utf8');
    } catch (err) {
      console.warn(`[log] Failed to write to ${logPath}: ${err.message}`);
    }
  }

  return {
    message(meta, extra = {}) {
      append({
        op: 'message',
        messageId: meta.id,
        from: GmailClient.getHeader(meta, 'From')?.slice(0, 120),
        subject: GmailClient.getHeader(meta, 'Subject')?.slice(0, 120),
        snippet: meta.snippet?.slice(0, 200),
        ...extra,
      });
    },

    forward(meta, target, rule) {
      append({
        op: 'forward',
        messageId: meta.id,
        from: GmailClient.getHeader(meta, 'From')?.slice(0, 80),
        subject: GmailClient.getHeader(meta, 'Subject')?.slice(0, 80),
        target,
        rule,
      });
    },

    error(context, err) {
      append({
        op: 'error',
        context,
        message: err.message,
        stack: err.stack?.split('\n').slice(0, 3).join(' | '),
      });
    },

    runStart(stats) {
      append({ op: 'run_start', ...stats });
    },

    runEnd(stats) {
      append({ op: 'run_end', ...stats });
    },
  };
}
