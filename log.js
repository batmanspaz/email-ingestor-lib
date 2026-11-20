/**
 * log.js — Append-only JSONL email log for entity ingestors
 *
 * Each entity writes to ~/claude/{entity}/logs/email-ingestor.jsonl
 *
 * PII (SOC 2 §17.5, tasks.db #3215): the sink never holds message body text
 * (no `snippet` key at all), the sender is written as its DOMAIN ONLY
 * (`fromDomain`), and the subject is a length marker. `messageId` (the Gmail
 * id) is the dedupe/debug key: anyone authorised to debug can open the
 * message in Gmail from it, so no sender identity or hash is needed here.
 *
 * Retention (dev-rules §15, SOC 2 §17.6): size-based rotation. When the next
 * append would push the file past `maxBytes` (default 10 MB) it is renamed to
 * `.1`, `.1` -> `.2`, ... keeping `keep` (default 5) rotated files. New files
 * are created mode 0600, and an existing live or rotated file found with any
 * other mode is tightened to 0600. Assumes a single writer per logPath.
 */

import fs from 'fs';
import path from 'path';
import { GmailClient } from './gmail.js';
import { maskFrom, redact } from './mask.js';

export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_KEEP = 5;

// Fields every record's writer owns; callers' extra/stats can never overwrite
// them (a caller-supplied `subject` would otherwise land raw on disk).
const RESERVED = ['ts', 'entity', 'op', 'messageId', 'fromDomain', 'subject', 'from', 'snippet'];
const stripReserved = (obj) => {
  const out = {};
  for (const [k, v] of Object.entries(obj ?? {})) if (!RESERVED.includes(k)) out[k] = v;
  return out;
};

// Latch: warn about a persistent chmod failure once per logPath per process.
const chmodWarned = new Set();

/**
 * Sender domain only. maskFrom() already extracts a single address (and fails
 * closed to '[redacted]'); keep only what follows the '@'.
 * @param {*} from raw From header
 * @returns {string|undefined}
 */
function senderDomain(from) {
  const masked = maskFrom(from);
  if (!masked || typeof masked !== 'string') return undefined;
  const at = masked.lastIndexOf('@');
  return at === -1 ? '[redacted]' : masked.slice(at + 1).toLowerCase();
}

/**
 * Create a logger for an entity.
 * @param {string} entity — entity name (collagesoup, perfectcity, personal)
 * @param {string} logPath — full path to the .jsonl log file
 * @param {object} [opts]
 * @param {number} [opts.maxBytes=DEFAULT_MAX_BYTES] rotate before the file would exceed this
 * @param {number} [opts.keep=DEFAULT_KEEP] rotated files to keep (.1 .. .keep)
 * @returns {object} logger with methods: message(), forward(), error(), runStart(), runEnd()
 */
export function createLogger(entity, logPath, opts = {}) {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const keep = Math.max(1, opts.keep ?? DEFAULT_KEEP);
  const dir = path.dirname(logPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  /** Enforce 0600 on an existing file (the `mode` on append only applies at create). */
  function ensurePrivate(p, st) {
    try {
      const mode = (st ?? fs.statSync(p)).mode & 0o777;
      if (mode !== 0o600) fs.chmodSync(p, 0o600);
    } catch (err) {
      if (err.code !== 'ENOENT' && !chmodWarned.has(p)) {
        chmodWarned.add(p);
        console.warn(`[log] chmod 0600 failed for ${p}: ${err.message}`);
      }
    }
  }

  // SINGLE-WRITER ASSUMPTION: one process appends to a given logPath at a time
  // (each entity ingestor is one LaunchAgent and runs do not overlap). Two
  // concurrent writers could both decide to rotate; the re-stat just before
  // the rename chain narrows, but does not close, that window. If concurrent
  // writers are ever introduced, move rotation behind a lock file.
  function rotateIfNeeded(nextLen) {
    let st;
    try {
      st = fs.statSync(logPath);
    } catch {
      return; // no file yet
    }
    ensurePrivate(logPath, st);
    const needs = (s) => s.size > 0 && s.size + nextLen > maxBytes;
    if (!needs(st)) return;
    try {
      // Re-stat right before renaming: another writer may have rotated already.
      if (!needs(fs.statSync(logPath))) return;
    } catch {
      return; // file vanished (rotated elsewhere); append recreates it 0600
    }
    // Move the live file aside FIRST: if it cannot be renamed (persistent
    // EBUSY/EACCES), nothing in the .N chain has moved, so history is never
    // collapsed by repeated failing rotations.
    const tmp = `${logPath}.1-tmp`;
    try {
      fs.renameSync(logPath, tmp);
    } catch (err) {
      console.warn(`[log] Rotation failed for ${logPath}: ${err.message}`);
      return;
    }
    try {
      // Rename chain, oldest first: .keep is overwritten by .keep-1, ..., .2 by .1.
      for (let i = keep - 1; i >= 1; i--) {
        const src = `${logPath}.${i}`;
        if (fs.existsSync(src)) {
          fs.renameSync(src, `${logPath}.${i + 1}`);
          ensurePrivate(`${logPath}.${i + 1}`);
        }
      }
      fs.renameSync(tmp, `${logPath}.1`);
      ensurePrivate(`${logPath}.1`);
    } catch (err) {
      console.warn(`[log] Rotation failed for ${logPath}: ${err.message}`);
      try {
        fs.renameSync(tmp, logPath); // put the live file back; nothing lost
      } catch (err2) {
        console.warn(`[log] Could not restore ${logPath} from ${tmp}: ${err2.message}`);
      }
    }
  }

  function append(record) {
    // Fixed fields last so a record can never overwrite them.
    const { ts: _ts, entity: _entity, ...rest } = record;
    const line = JSON.stringify(Object.assign(
      { ts: new Date().toISOString(), entity }, rest,
      { ts: new Date().toISOString(), entity },
    )) + '\n';

    try {
      rotateIfNeeded(Buffer.byteLength(line, 'utf8'));
      fs.appendFileSync(logPath, line, { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
      console.warn(`[log] Failed to write to ${logPath}: ${err.message}`);
    }
  }

  return {
    message(meta, extra = {}) {
      // PII (SOC 2, #3215): sender domain only, subject length only, and the
      // body snippet is never written. Reserved keys are stripped from the
      // caller's `extra` so it cannot overwrite (or re-add) any of them.
      const safeExtra = stripReserved(extra);
      append({
        op: 'message',
        messageId: meta.id,
        fromDomain: senderDomain(GmailClient.getHeader(meta, 'From')),
        subject: redact(GmailClient.getHeader(meta, 'Subject')),
        ...safeExtra,
      });
    },

    forward(meta, target, rule) {
      append({
        op: 'forward',
        messageId: meta.id,
        // PII (SOC 2, #3215): sender domain only + subject length only.
        fromDomain: senderDomain(GmailClient.getHeader(meta, 'From')),
        subject: redact(GmailClient.getHeader(meta, 'Subject')),
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

    /** A refused write on a readOnly account (readonly-guard.js). Record is already masked. */
    readOnlyDenial(rec) {
      append({ ...rec });
    },

    runStart(stats) {
      append({ op: 'run_start', ...stripReserved(stats) });
    },

    runEnd(stats) {
      append({ op: 'run_end', ...stripReserved(stats) });
    },
  };
}
