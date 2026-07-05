/**
 * ocr.js — Haiku-vision OCR for image-only PDFs and images.
 * Sends a document/image to Claude Haiku and extracts structured data for any
 * document type. Shared across entity producers (the legacy intake document
 * processor, Sluice document-drop producers).
 *
 * Cost-capping and logging are the CALLER's responsibility, injected via an
 * optional options param — this module has no opinion on where cost state
 * lives or how errors get logged, so it stays a portable dependency with no
 * ties to any one repo's infra (moved 2026-07-05 out of intake's
 * src/processors/ocr-vision.js, which hard-imported that repo's own
 * utils/llm-cost.js + utils/logger.js; those stayed in intake since
 * llm-cost.js has 8+ other consumers there unrelated to OCR).
 */

import Anthropic from '@anthropic-ai/sdk';

const MAX_FILE_SIZE = 30 * 1024 * 1024; // 30MB
let client = null;

function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

const NOOP_COST_TRACKER = { isCapReached: () => false, record: () => 0 };
const NOOP_LOG = { info() {}, warn() {}, error() {} };

const UNIVERSAL_PROMPT = `Extract all text from this document verbatim. Then classify the document type and extract all relevant structured fields.

Return ONLY valid JSON (no markdown, no explanation):
{
  "raw_text": "complete verbatim text extracted from the document",
  "document_type": one of: "receipt" | "invoice" | "collection_notice" | "medical_bill" | "medical_statement" | "eob" | "legal_document" | "contract" | "correspondence_letter" | "contact_card" | "business_card" | "financial_statement" | "bank_statement" | "tax_document" | "insurance_document" | "government_document" | "form" | "other",
  "sender_name": "name of the person or organization that sent this document, or null",
  "sender_address": "sender full mailing address, or null",
  "sender_phone": "sender phone number, or null",
  "sender_email": "sender email address, or null",
  "recipient_name": "name of the person this is addressed to, or null",
  "recipient_address": "recipient mailing address, or null",
  "date": "document date as YYYY-MM-DD, or null",
  "reference_number": "account number, claim number, case number, invoice number, or any other reference ID, or null",
  "amount_owed": total dollar amount currently owed as a number or null,
  "amount_paid": dollar amount already paid as a number or null,
  "due_date": "payment deadline as YYYY-MM-DD, or null",
  "service_date": "date of service (medical or legal) as YYYY-MM-DD, or null",
  "creditor_name": "original creditor name for collection notices, or null",
  "collection_agency": "name of the collection agency if this is a collection notice, or null",
  "patient_name": "patient name for medical documents, or null",
  "provider_name": "healthcare provider or legal provider name, or null",
  "legal_deadline": "any legal response deadline as YYYY-MM-DD, or null",
  "is_collection_notice": true or false,
  "is_medical": true or false,
  "is_legal": true or false,
  "is_receipt": true or false,
  "requires_response": true if there is a deadline or action required, false otherwise,
  "urgency": "high" | "medium" | "low",
  "signals": array of applicable strings from: ["task", "contact", "deal", "receipt", "calendar", "medical", "legal", "financial", "collection"],
  "summary": "2-3 sentence plain-English summary of what this document is and what action, if any, is required",
  "vendor": "vendor or store name for receipts/invoices, or null",
  "amount": total transaction amount as a number for receipts/invoices or null,
  "currency": "USD" or other currency code,
  "line_items": [{"description": "item description", "amount": 0.00}] or []
}

All fields not applicable to this document type should be null (or [] for arrays).`;

/**
 * Parse the raw Haiku response text into a structured result object.
 * Maintains backward compatibility: always populates rawText, structured (for receipts).
 */
function parseOcrResponse(text, filename, log) {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    log.warn(`OCR response not valid JSON for ${filename}, using raw response as text`);
    return { rawText: text, structured: null, parsed: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (err) {
    log.warn(`OCR JSON parse failed for ${filename}: ${err.message}`);
    return { rawText: text, structured: null, parsed: null };
  }

  const rawText = parsed.raw_text || text;

  const structured = parsed.is_receipt ? {
    vendor: parsed.vendor || parsed.sender_name,
    amount: parsed.amount || parsed.amount_owed,
    currency: parsed.currency || 'USD',
    date: parsed.date,
    line_items: parsed.line_items || [],
  } : null;

  return { rawText, structured, parsed };
}

/**
 * OCR a PDF buffer using Claude Haiku vision.
 * @param {Buffer} pdfBuffer - Raw PDF bytes
 * @param {string} filename - Original filename (for logging)
 * @param {object} [opts] - { costTracker: {isCapReached, record}, log: {info,warn,error} }
 * @returns {Promise<object|null>} Result with rawText, structured, parsed, usage, cost
 */
export async function ocrImagePdf(pdfBuffer, filename, opts = {}) {
  const costTracker = opts.costTracker || NOOP_COST_TRACKER;
  const log = opts.log || NOOP_LOG;

  if (pdfBuffer.length > MAX_FILE_SIZE) {
    log.warn(`PDF too large for OCR: ${filename} (${(pdfBuffer.length / 1024 / 1024).toFixed(1)}MB > 30MB)`);
    return null;
  }

  if (costTracker.isCapReached()) {
    log.warn(`Daily cost cap reached — skipping OCR for ${filename}`);
    return null;
  }

  try {
    const anthropic = getClient();
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: pdfBuffer.toString('base64'),
            },
          },
          {
            type: 'text',
            text: UNIVERSAL_PROMPT,
          },
        ],
      }],
    });

    const usage = response.usage || {};
    const cost = costTracker.record(usage);
    log.info(`OCR cost: $${(cost || 0).toFixed(4)} — ${filename}`);

    const text = response.content[0]?.text || '';
    const { rawText, structured, parsed } = parseOcrResponse(text, filename, log);

    return { rawText, structured, parsed, usage, cost };
  } catch (err) {
    log.error(`OCR failed for ${filename}`, { error: err.message });
    return null;
  }
}

const EXT_TO_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.tiff': 'image/tiff',
  '.heic': 'image/heic',
};

/**
 * OCR an image buffer (JPG/PNG) using Claude Haiku vision.
 * @param {Buffer} imageBuffer - Raw image bytes
 * @param {string} filename - Original filename
 * @param {string} ext - File extension (e.g. '.jpg')
 * @param {object} [opts] - { costTracker: {isCapReached, record}, log: {info,warn,error} }
 * @returns {Promise<object|null>} Result with rawText, structured, parsed, usage, cost
 */
export async function ocrImage(imageBuffer, filename, ext, opts = {}) {
  const costTracker = opts.costTracker || NOOP_COST_TRACKER;
  const log = opts.log || NOOP_LOG;

  if (imageBuffer.length > MAX_FILE_SIZE) {
    log.warn(`Image too large for OCR: ${filename} (${(imageBuffer.length / 1024 / 1024).toFixed(1)}MB)`);
    return null;
  }

  if (costTracker.isCapReached()) {
    log.warn(`Daily cost cap reached — skipping OCR for ${filename}`);
    return null;
  }

  const mediaType = EXT_TO_MIME[ext.toLowerCase()] || 'image/jpeg';

  try {
    const anthropic = getClient();
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: imageBuffer.toString('base64'),
            },
          },
          {
            type: 'text',
            text: UNIVERSAL_PROMPT,
          },
        ],
      }],
    });

    const usage = response.usage || {};
    const cost = costTracker.record(usage);
    log.info(`Image OCR cost: $${(cost || 0).toFixed(4)} — ${filename}`);

    const text = response.content[0]?.text || '';
    const { rawText, structured, parsed } = parseOcrResponse(text, filename, log);

    return { rawText, structured, parsed, usage, cost };
  } catch (err) {
    log.error(`Image OCR failed for ${filename}`, { error: err.message });
    return null;
  }
}
