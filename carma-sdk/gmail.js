/**
 * gmail.js — re-exports email-ingestor-lib for callers that just want
 * Gmail OAuth without depending on the full ingestor package directly.
 *
 * Lives in @carma/sdk so a future swap (gmail.js → a Carma-internal OAuth
 * client) is a one-import change.
 */

export { GmailClient, poll, checkAndForward, createLogger } from '../email-ingestor-lib/index.js';
