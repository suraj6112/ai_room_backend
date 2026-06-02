/**
 * Tabular Review — Pure helpers for AI-powered cross-document extraction.
 *
 * REVIEWS-ONLY MODULE. This file (and everything else under
 * microservices/file-processor/reviews/) is part of the Tabular Review feature
 * and depends on core (search, profile, indexing, etc.) but NOT vice versa.
 * The file-processor would still ship as a usable RAG box if this entire
 * directory were removed (the /extract and /extract-batch endpoints would go
 * with it; nothing core-side imports anything from reviews/).
 *
 * Frontend mirror: src/services/reviewColumnTypes.js (keep the two in sync).
 *
 * @see microservices/file-processor/reviews/README.md (layering rules)
 * @see docs/design/TABULAR_REVIEW.md
 */

const DEFAULT_MAX_INPUT_CHARS = 120000;

const SUPPORTED_COLUMN_TYPES = [
  'text',
  'long_text',
  'number',
  'currency',
  'date',
  'boolean',
  'list',
  'classification'
];

/**
 * Build the extraction prompt sent to the LLM for a single (file, column) pair.
 *
 * @param {string} columnName
 * @param {string} columnType - one of SUPPORTED_COLUMN_TYPES
 * @param {string} columnPrompt - User-defined instruction
 * @param {string} documentContent - The file's `extractedText`
 * @param {Object} [opts]
 * @param {number} [opts.maxInputChars=120000] - Truncate documentContent to this length
 * @param {Object} [opts.columnOptions] - Per-type configuration (e.g., classification values, currencyCode)
 * @returns {string}
 */
function buildExtractionPrompt(columnName, columnType, columnPrompt, documentContent, opts = {}) {
  const maxChars = opts.maxInputChars || DEFAULT_MAX_INPUT_CHARS;
  const columnOptions = opts.columnOptions || {};

  const truncated = documentContent.length > maxChars;
  const content = truncated
    ? documentContent.slice(0, maxChars) + '\n\n[... document truncated for length ...]'
    : documentContent;

  const typeMeta = buildTypeMetaForPrompt(columnType, columnOptions);
  const typeRules = buildTypeRulesForPrompt(columnType, columnOptions);

  return `You are a document analysis assistant. Extract the requested information from the document content below.

## Extraction Task
Field: ${columnName}
Type: ${columnType}${typeMeta ? `\n${typeMeta}` : ''}
Instructions: ${columnPrompt}

## Output Format
Respond with JSON matching this exact schema:
{
  "value": <the extracted answer per the type rules below, or null if not found>,
  "confidence": "high" | "medium" | "low",
  "quote": <verbatim text from the document that supports your answer, or null>,
  "page": <integer page number where the answer was found, or null>,
  "reasoning": <brief explanation of why you extracted this value>
}

## Rules for Field Type "${columnType}"
${typeRules}

## General Rules
- For type "boolean": value must be true or false (or null if not found)
- For type "number" / "currency": value must be a number with no formatting (e.g., 1500000 not "$1.5M") (or null)
- For type "date": value must be ISO format YYYY-MM-DD (or null)
- For type "list": value must be a string with items joined by "; " (or null)
- For type "text": value must be a string (or null)
- If the information is not found in the document, set value to null and confidence to "low"
- The "quote" must be verbatim text from the document (no paraphrasing). If you cannot quote directly, set quote to null
- Page numbers are usually marked in the document with "## Page N" or similar headers; cite the page where the supporting quote appears

## Critical: Do not substitute related concepts
- Answer the EXACT question asked. Do not infer, generalize, or substitute a related but distinct concept just because the document mentions one.
- A customer is NOT a counterparty unless they are a named party to the specific contract being asked about.
- A mentioned date is NOT an effective date unless explicitly identified as such.
- A partner, supplier, or business contact is NOT a contracting party unless the document directly says so.
- The presence of a quote that is merely on-topic is not enough — the quote must directly answer the specific question.
- If the document does not directly contain the requested fact, set value to null with confidence "low" and explain in reasoning why the information was not found. Do not guess.
- High confidence is reserved for answers that are stated explicitly and unambiguously in the document.

## Concise output style — get straight to the answer
The "value" field is rendered in a dense table; every word of preface is wasted screen space repeated across every row. Lead with the substantive answer.

- Do NOT begin the value with meta-commentary about the document. Forbidden openings include: "The document presents…", "The document describes…", "The document outlines…", "The document states…", "This document is a…", "This document mentions…", "Based on the document…", "According to the document…", "The text mentions…", "It appears that…", "It can be inferred that…".
- Start with the substantive answer itself. For "Counterparty", begin with the counterparty's name. For "Term", begin with the duration or operative phrase. For "Governing Law", begin with the jurisdiction.
- Do NOT restate the question in the answer. The column header already shows what was asked.
- This applies to every column type, but especially to "text" and "long_text".

## Document Content
${content}`;
}

/**
 * Per-type rule block embedded in the prompt. Tighter than the generic rules
 * above and (for classification/currency) injects the configured options.
 */
function buildTypeRulesForPrompt(type, options) {
  switch (type) {
    case 'boolean':
      return '- value MUST be true or false (or null if not found in the document).';
    case 'number':
      return '- value MUST be a JSON number with no formatting (e.g., 1500000 not "$1.5M", 0.05 not "5%"). Return null if not found.';
    case 'currency': {
      const code = options?.currencyCode || 'USD';
      return `- value MUST be a JSON number representing the amount in ${code}. Convert any abbreviations (K/M/B/bn) to the full integer (e.g., $1.5M → 1500000). Do not include currency symbols. Return null if not found.`;
    }
    case 'date':
      return '- value MUST be an ISO date string YYYY-MM-DD. If only a month and year are given, return the first day of that month. Return null if not found.';
    case 'list':
      return '- value MUST be a single string with items joined by "; " (e.g., "Acme Corp; Globex Inc"). Return null if no items are found.';
    case 'long_text':
      return '- value is a multi-paragraph string capturing the full extracted information. Begin with the substantive answer (e.g., the operative clause language). Do NOT preface with "The document presents/describes/outlines…" or similar meta-commentary. Reproduce key terms verbatim where they materially affect the answer. Return null if not found.';
    case 'classification': {
      const values = (options?.values || []).map((o) => `"${o.value}"`);
      const allowed = values.length ? values.join(' | ') : '<no options configured>';
      return `- value MUST be exactly one of the allowed values (case-sensitive): ${allowed}. Return null if none of the categories applies.`;
    }
    case 'text':
    default:
      return '- value MUST be a single-line string (no newlines). Keep it concise — names, identifiers, short phrases. Do NOT begin with "The document…", "This document…", "Based on the document…", or similar preface — start with the substantive answer. Return null if not found.';
  }
}

/**
 * Optional metadata block shown above Instructions for types that need it
 * (currency code, classification options).
 */
function buildTypeMetaForPrompt(type, options) {
  if (type === 'classification' && Array.isArray(options?.values) && options.values.length) {
    const lines = options.values.map((o) => `  - "${o.value}"${o.label && o.label !== o.value ? ` (${o.label})` : ''}`).join('\n');
    return `Allowed Values:\n${lines}`;
  }
  if (type === 'currency' && options?.currencyCode) {
    return `Currency: ${options.currencyCode}`;
  }
  return '';
}

/**
 * Build the OpenAI structured-output JSON schema for a column. The shape of
 * `value` varies by type; the rest of the schema (confidence/quote/page/reasoning)
 * is identical across types.
 *
 * Notes about OpenAI strict mode:
 *   - Every property listed in `properties` MUST be in `required`.
 *   - `null` is allowed only via a multi-type union (not via enum).
 *   - `additionalProperties: false` is required at every object level.
 *
 * @param {string} columnType
 * @param {Object} [columnOptions]
 * @returns {Object}
 */
function buildColumnJsonSchema(columnType, columnOptions) {
  const valueSchema = buildValueSchema(columnType, columnOptions);
  return {
    name: 'extraction',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        value: valueSchema,
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        quote: { type: ['string', 'null'] },
        page: { type: ['integer', 'null'] },
        reasoning: { type: ['string', 'null'] }
      },
      required: ['value', 'confidence', 'quote', 'page', 'reasoning'],
      additionalProperties: false
    }
  };
}

function buildValueSchema(columnType, columnOptions) {
  switch (columnType) {
    case 'boolean':
      return { type: ['boolean', 'null'] };
    case 'number':
    case 'currency':
      return { type: ['number', 'null'] };
    case 'classification': {
      const values = (columnOptions?.values || [])
        .map((o) => o && typeof o.value === 'string' ? o.value : null)
        .filter((v) => v !== null && v !== '');
      // Strict mode: enums can't include null directly; nest in anyOf.
      if (values.length) {
        return { anyOf: [{ type: 'string', enum: values }, { type: 'null' }] };
      }
      // No options configured (shouldn't happen, but degrade gracefully)
      return { type: ['string', 'null'] };
    }
    case 'date':
    case 'list':
    case 'long_text':
    case 'text':
    default:
      return { type: ['string', 'null'] };
  }
}

/**
 * Coerce LLM-returned `value` to match the column type. The model already
 * follows the rules in the prompt, but a defensive coercion guards against
 * "$1.5M" creeping in as a number column or a classification result that
 * doesn't match any configured value.
 *
 * @param {*} value
 * @param {string} columnType
 * @param {Object} [columnOptions]
 * @returns {string|number|boolean|null}
 */
function coerceValue(value, columnType, columnOptions) {
  if (value === null || value === undefined) return null;
  switch (columnType) {
    case 'number':
    case 'currency': {
      if (typeof value === 'number') return Number.isFinite(value) ? value : null;
      const cleaned = String(value).replace(/[^0-9.\-]/g, '');
      const n = parseFloat(cleaned);
      return Number.isFinite(n) ? n : null;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      const s = String(value).toLowerCase().trim();
      if (['true', 'yes', '1'].includes(s)) return true;
      if (['false', 'no', '0'].includes(s)) return false;
      return null;
    }
    case 'date': {
      if (!value) return null;
      const s = String(value).trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
      const d = new Date(s);
      if (!Number.isNaN(d.getTime())) return d.toISOString().split('T')[0];
      return s;
    }
    case 'classification': {
      const s = String(value).trim();
      if (!s) return null;
      const allowed = (columnOptions?.values || [])
        .map((o) => (o && typeof o.value === 'string' ? o.value : null))
        .filter(Boolean);
      if (!allowed.length) return s;
      if (allowed.includes(s)) return s;
      // Best-effort: match by label (case-insensitive), then by value lower-case.
      const byLabel = (columnOptions?.values || []).find(
        (o) => o.label && o.label.toLowerCase() === s.toLowerCase()
      );
      if (byLabel) return byLabel.value;
      const byLower = allowed.find((v) => v.toLowerCase() === s.toLowerCase());
      return byLower || null;
    }
    case 'list':
    case 'long_text':
    case 'text':
    default:
      return typeof value === 'string' ? value : String(value);
  }
}

/**
 * Run an array of async tasks with a concurrency limit. Each task is awaited
 * independently — one failure does not stop the rest. Results are returned in
 * the same order as the input items.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
// runWithConcurrency moved to ../util/concurrency.js so non-review code can use it.
// We re-import + re-export here so existing callers keep working unchanged.
const { runWithConcurrency } = require('../util/concurrency');

/**
 * Legacy schema kept for backwards compat with code that imports
 * EXTRACTION_JSON_SCHEMA directly. New callers should use buildColumnJsonSchema.
 */
const EXTRACTION_JSON_SCHEMA = {
  name: 'extraction',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      value: { type: ['string', 'number', 'boolean', 'null'] },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      quote: { type: ['string', 'null'] },
      page: { type: ['integer', 'null'] },
      reasoning: { type: ['string', 'null'] }
    },
    required: ['value', 'confidence', 'quote', 'page', 'reasoning'],
    additionalProperties: false
  }
};

module.exports = {
  buildExtractionPrompt,
  buildColumnJsonSchema,
  buildTypeRulesForPrompt,
  buildTypeMetaForPrompt,
  coerceValue,
  runWithConcurrency,
  EXTRACTION_JSON_SCHEMA,
  SUPPORTED_COLUMN_TYPES,
  DEFAULT_MAX_INPUT_CHARS
};
