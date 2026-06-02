/**
 * Document Profile Builder
 *
 * Produces a per-document structured "card" at ingestion: type, summary,
 * headings tree (TOC with page anchors and per-section bullets), keyFacts
 * (parties / effectiveDate / term / governingLaw / changeOfControl /
 * assignmentRequiresConsent — each with `{page, quote}` source pointer),
 * bundleHints.
 *
 * The profile powers two things:
 *   1. The keyFacts short-circuit in review extraction (cells whose column
 *      maps to a known field skip the LLM and read from the profile).
 *   2. The row agent's pre-loaded context — it gets the TOC + keyFacts +
 *      summary in its first user message before any tool call.
 *
 * Stored at: {basePath}/files/{fileId}/profile/profile_v1
 * A small `documentProfileSummary` is also mirrored onto the parent file
 * doc for cheap list-view reads and keyFacts.X Firestore filters.
 *
 * Single-model rule (per ~/.claude/.../memory/feedback_single_model_per_role.md):
 *   This builder uses Claude Sonnet 4.6 ONLY. Long documents
 *   (> MAX_SINGLE_PASS_CHARS) are processed in multiple chunked passes via
 *   buildDocumentProfileChunked; the same model is used for every pass.
 *   Documents whose total content exceeds MAX_TOTAL_CHARS get their tail
 *   truncated with a logged warning.
 *
 * Pointer-rich profile (per ~/.claude/.../memory/project_ai_room_is_a_rag_box.md):
 *   Every heading, every keyFacts.X, every summary claim has a `{page, quote}`
 *   pointer back to the source page. Profiles whose pointers don't validate
 *   against `markdownPages[page]` get those entries dropped or flagged.
 *
 * @see docs/design/REASONING_DOCUMENT_QA.md
 * @see docs/design/DUE_DILIGENCE_API.md (§6 Document profile)
 */

'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const admin = require('firebase-admin');

// ════════════════════════════════════════════════════════════════════════
// CONFIGURATION
//
// All env-var-derived values are resolved at module load and logged so
// operators can see what's actually running. Numeric values fail loud on
// bad input — silent defaults hide misconfigurations in production.
// ════════════════════════════════════════════════════════════════════════

const PROFILE_VERSION = 1;

const CONFIG = (() => {
  const errors = [];

  const stringEnv = (raw, defaultValue) => {
    if (raw === undefined || raw === null || raw === '') {
      return { value: defaultValue, fromEnv: false };
    }
    return { value: raw, fromEnv: true };
  };

  const positiveIntEnv = (raw, defaultValue, name) => {
    if (raw === undefined || raw === null || raw === '') {
      return { value: defaultValue, fromEnv: false };
    }
    const trimmed = String(raw).trim();
    if (!/^\d+$/.test(trimmed)) {
      errors.push(`env ${name}=${JSON.stringify(raw)} is not a positive integer`);
      return { value: defaultValue, fromEnv: false };
    }
    const n = parseInt(trimmed, 10);
    if (n <= 0) {
      errors.push(`env ${name}=${n} must be > 0`);
      return { value: defaultValue, fromEnv: false };
    }
    return { value: n, fromEnv: true };
  };

  const profileModel = stringEnv(process.env.PROFILE_MODEL, 'claude-sonnet-4-6');

  // Maximum input chars sent to a SINGLE pass of the profile builder. Documents
  // larger than this go through buildDocumentProfileChunked. ~600k chars ≈
  // 100 pages of dense markdown, well within Sonnet 4.6's 200k-token context.
  // Same model used for every pass per the single-model-per-role rule.
  const maxSinglePass = positiveIntEnv(process.env.PROFILE_MAX_SINGLE_PASS_CHARS, 600000, 'PROFILE_MAX_SINGLE_PASS_CHARS');

  // Hard upper bound: documents whose total markdownPages exceed this get
  // their tail truncated with a logged warning. ~6M chars covers ~1000 pages
  // of dense markdown — beyond any realistic M&A document.
  const maxTotal = positiveIntEnv(process.env.PROFILE_MAX_TOTAL_CHARS, 6000000, 'PROFILE_MAX_TOTAL_CHARS');

  const maxOutputTokens = positiveIntEnv(process.env.PROFILE_MAX_OUTPUT_TOKENS, 8000, 'PROFILE_MAX_OUTPUT_TOKENS');

  if (maxTotal.value < maxSinglePass.value) {
    errors.push(`PROFILE_MAX_TOTAL_CHARS (${maxTotal.value}) cannot be less than PROFILE_MAX_SINGLE_PASS_CHARS (${maxSinglePass.value})`);
  }

  if (errors.length) {
    throw new Error('[ProfileBuilder] invalid configuration:\n  ' + errors.join('\n  '));
  }

  // Log resolved configuration so operators can see what's actually in effect.
  // Skipped in test envs to keep test output clean.
  const isTestEnv = process.env.NODE_ENV === 'test' || process.env.VITEST;
  if (!isTestEnv) {
    console.log('[ProfileBuilder] resolved configuration:');
    console.log(`  PROFILE_MODEL = ${profileModel.value} (${profileModel.fromEnv ? 'from env' : 'default'})`);
    console.log(`  PROFILE_MAX_SINGLE_PASS_CHARS = ${maxSinglePass.value} (${maxSinglePass.fromEnv ? 'from env' : 'default'})`);
    console.log(`  PROFILE_MAX_TOTAL_CHARS = ${maxTotal.value} (${maxTotal.fromEnv ? 'from env' : 'default'})`);
    console.log(`  PROFILE_MAX_OUTPUT_TOKENS = ${maxOutputTokens.value} (${maxOutputTokens.fromEnv ? 'from env' : 'default'})`);
  }

  return {
    PROFILE_MODEL: profileModel.value,
    MAX_SINGLE_PASS_CHARS: maxSinglePass.value,
    MAX_TOTAL_CHARS: maxTotal.value,
    MAX_OUTPUT_TOKENS: maxOutputTokens.value
  };
})();

const PROFILE_MODEL = CONFIG.PROFILE_MODEL;
const MAX_SINGLE_PASS_CHARS = CONFIG.MAX_SINGLE_PASS_CHARS;
const MAX_TOTAL_CHARS = CONFIG.MAX_TOTAL_CHARS;
const MAX_OUTPUT_TOKENS = CONFIG.MAX_OUTPUT_TOKENS;
// Backward-compat alias — older callers and tests may still import this.
const MAX_INPUT_CHARS = MAX_SINGLE_PASS_CHARS;
const VALID_DOC_TYPES = [
  'frame_contract',
  'order_form',
  'amendment',
  'nda',
  'letter_of_intent',
  'cim',
  'financial_statement',
  'board_memo',
  'presentation',
  'email_correspondence',
  'regulatory_filing',
  'org_chart',
  'cap_table',
  'due_diligence_report',
  'other'
];

const VALID_CONFIDENCE = ['high', 'medium', 'low'];
const VALID_COC = ['consent_required', 'termination_right', 'notice_only', 'silent'];

/**
 * Entity categories the model is instructed to extract and that the
 * validator enforces. Matches the 6 categories requested by the client.
 */
const VALID_ENTITY_CATEGORIES = [
  'company_org',        // Companies / organizations / entities
  'person',             // People
  'issue_risk_failure', // Issues / risks / failures / critical constraints
  'idea_upside',        // Ideas / potential / upside / opportunities
  'product_service',    // Products / services
  'asset',              // Assets: buildings, patents, systems, IP, etc.
];

// Whitespace-normalized substring length for heading + citation validation.
const QUOTE_VALIDATION_LENGTH = 30;

let anthropicClient = null;
function getAnthropicClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('[ProfileBuilder] ANTHROPIC_API_KEY not set');
  }
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

// ════════════════════════════════════════════════════════════════════════
// PROMPTS
// ════════════════════════════════════════════════════════════════════════

const PROFILE_SYSTEM_PROMPT = `You are an M&A diligence analyst producing a structured profile of one document.

Your output is a single JSON object that another agent will use as a navigable map and as a source of pre-extracted structured facts. The profile must:

1. Be **accurate**. Every claim, every heading, every keyFact must be supported by verbatim text on a specific page of the document. Each entry carries a {page, quote} pointer that another system will validate by string-matching against the source page. Inaccurate pointers will be dropped.

2. Be **structurally complete**. Capture every meaningful heading (h1, h2, h3) so the TOC reflects the document's actual organization. Don't skip sections.

3. Use **canonical forms** for entity-typed keyFacts:
   - governingLaw: "{state-or-region}, {country-iso-alpha-3}" if a state/region is named (e.g., "Delaware, USA", "England, GBR"); otherwise just the ISO 3166-1 alpha-3 code (e.g., "DEU" for Germany, "FRA" for France). Apply standard ISO 3166 country codes.
   - parties: full legal names as written in the document (no normalization for parties — surface what's there).

4. **Cite or refuse** per field. If a keyFact isn't stated explicitly in the document, return null for that field and its source. Don't infer from industry, jurisdiction, or company name.

5. Use the **document type taxonomy** strictly. Pick from the enum; if none fits, use "other". Set typeConfidence honestly: "high" only when the cover or first pages plainly state what the document is.

6. Extract **entities**: identify 5–15 of the most important and distinctive entities mentioned in this document using these exact categories:
   - company_org: Companies, organizations, entities, counterparties, subsidiaries.
   - person: Named individuals (signatories, executives, key personnel, advisors).
   - issue_risk_failure: Risks, failures, critical constraints, compliance issues, red flags.
   - idea_upside: Opportunities, upsides, competitive advantages, growth ideas.
   - product_service: Products or services offered, licensed, or discussed.
   - asset: Tangible or intangible assets — buildings, facilities, patents, systems, IP, brands.
   Be selective: only extract entities that a diligence analyst would find material. Each entity MUST have a verbatim {page, quote} source citation that another system will validate. If you cannot ground an entity in the document text, do NOT include it.

7. ALWAYS escape any double quotes inside JSON string values as \\" so it is 100% valid, parseable JSON.

The document's pages are provided below with explicit "## Page N" anchors. Use the same page numbers verbatim in your output — never paraphrase a page reference.`;

const PROFILE_SYSTEM_PROMPT_CHUNKED = `You are an M&A diligence analyst producing a structured profile of one document. The document is too long to send in a single pass, so you receive it in sequential chunks. Each call provides:

  - The file name and folder path of the document (constant across calls).
  - The current profile-so-far (a JSON object), if any.
  - The next chunk of pages, with explicit "## Page N" anchors.
  - Metadata: which chunk number this is and the total chunk count.

Your output is the UPDATED profile JSON, reflecting everything observed in this chunk PLUS everything carried forward from prior chunks.

Discipline:

1. **Carry forward** every entry from the prior profile-so-far that the current chunk has not contradicted. Do NOT regress on facts you discovered earlier.

2. **Add or refine** entries based on this chunk:
   - Add new headings, keyFacts, bundleHints, entities that this chunk reveals.
   - Refine entries when this chunk supplies a more specific source quote on a fact you previously inferred from a different page.
   - If this chunk contradicts a prior entry (rare), prefer the more specific / later evidence and update.

3. **No-op is fine**. If this chunk adds nothing useful (boilerplate, repeated material), return the prior profile unchanged.

4. **Pointer-rich**. Every heading, every keyFact value, every bundleHint, every summarySource, every entity carries a {page, quote} pointer. The page MUST be a page that exists in this document; the quote MUST be verbatim from that page. Inaccurate pointers will be dropped after each call by the validator — be conservative.

5. **Canonical forms** (same as single-pass):
   - governingLaw: "{state-or-region}, {country-iso-alpha-3}" if a state/region is named (e.g., "Delaware, USA"); otherwise just the ISO 3166-1 alpha-3 code (e.g., "DEU"). Use standard ISO 3166.
   - parties: full legal names as written.

6. **Cite or refuse** per field. If you cannot ground a fact in the document, return null. Do not infer from industry, jurisdiction, or company name.

7. **Entities** (same rule as single-pass): extract 5–15 material entities across these categories:
   company_org, person, issue_risk_failure, idea_upside, product_service, asset.
   Accumulate across chunks — entities discovered in earlier chunks should be carried forward. Each entity MUST have a verified {page, quote} source citation.

The output schema is identical regardless of which chunk you're processing — always return the full profile JSON.`;

/**
 * Build the user-prompt content for a single-pass profile build.
 *
 * @param {Object} args
 * @param {string} args.fileName
 * @param {string|null} args.folderPath - human-readable folder path of the doc, e.g. "Customer Contracts / Acme"; null when at root
 * @param {Object<string, string>} args.markdownPages - { "1": "...", "2": "..." }
 * @returns {{ prompt: string, totalChars: number, truncated: boolean, includedPages: number[] }}
 */
function buildProfilePrompt({ fileName, folderPath, markdownPages }) {
  const pageNumbers = Object.keys(markdownPages || {})
    .map((k) => parseInt(k, 10))
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b);

  const parts = [];
  parts.push(`Document file name: ${fileName || 'unknown'}`);
  parts.push(`Folder path: ${folderPath || '(root)'}`);
  parts.push('');
  parts.push('=== DOCUMENT CONTENT ===');
  parts.push('');

  let totalChars = parts.join('\n').length;
  let truncated = false;
  const includedPages = [];

  for (const pageNum of pageNumbers) {
    const md = markdownPages[String(pageNum)] || '';
    const pageHeader = `## Page ${pageNum}\n\n`;
    const projectedSize = totalChars + pageHeader.length + md.length + 2;
    if (projectedSize > MAX_SINGLE_PASS_CHARS) {
      truncated = true;
      break;
    }
    parts.push(pageHeader + md);
    totalChars = projectedSize;
    includedPages.push(pageNum);
  }

  parts.push('');
  parts.push('=== END DOCUMENT CONTENT ===');
  parts.push('');
  parts.push(`Now produce the JSON profile per the schema in your system instructions. Total pages in the document: ${pageNumbers.length}. Pages included above: ${includedPages.length}${truncated ? ' (TRUNCATED — document exceeded the single-pass input cap; consider chunked processing for full coverage)' : ''}.`);
  parts.push('');
  parts.push('Output JSON ONLY — no prose before or after, no code fences. The JSON must conform to this schema:');
  parts.push('');
  parts.push(PROFILE_OUTPUT_SCHEMA_DESCRIPTION);

  return {
    prompt: parts.join('\n'),
    totalChars,
    truncated,
    includedPages
  };
}

/**
 * Build the user-prompt content for one pass of a chunked profile build.
 *
 * @param {Object} args
 * @param {string} args.fileName
 * @param {string|null} args.folderPath
 * @param {Object<string, string>} args.chunkPages - subset of markdownPages for this chunk
 * @param {number} args.chunkIndex - 0-based
 * @param {number} args.totalChunks
 * @param {number[]} args.allPages - sorted list of all page numbers in the doc (for context)
 * @param {Object|null} args.priorProfile - the profile-so-far from previous passes; null on first chunk
 * @returns {{ prompt: string, totalChars: number, includedPages: number[] }}
 */
function buildProfilePromptChunked({ fileName, folderPath, chunkPages, chunkIndex, totalChunks, allPages, priorProfile }) {
  const pageNumbers = Object.keys(chunkPages || {})
    .map((k) => parseInt(k, 10))
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b);

  const parts = [];
  parts.push(`Document file name: ${fileName || 'unknown'}`);
  parts.push(`Folder path: ${folderPath || '(root)'}`);
  parts.push(`Chunk: ${chunkIndex + 1} of ${totalChunks}`);
  parts.push(`Total pages in document: ${allPages.length} (pages ${allPages[0]}–${allPages[allPages.length - 1]})`);
  parts.push(`Pages in this chunk: ${pageNumbers.length === 0 ? 'none' : `${pageNumbers[0]}–${pageNumbers[pageNumbers.length - 1]}`}`);
  parts.push('');

  if (priorProfile) {
    parts.push('=== PROFILE-SO-FAR (carry forward unless this chunk contradicts) ===');
    parts.push('');
    parts.push(JSON.stringify(priorProfile, null, 2));
    parts.push('');
  } else {
    parts.push('=== NO PROFILE YET — this is the first chunk ===');
    parts.push('');
  }

  parts.push('=== THIS CHUNK ===');
  parts.push('');

  let totalChars = parts.join('\n').length;
  const includedPages = [];

  for (const pageNum of pageNumbers) {
    const md = chunkPages[String(pageNum)] || '';
    const pageHeader = `## Page ${pageNum}\n\n`;
    parts.push(pageHeader + md);
    totalChars += pageHeader.length + md.length + 2;
    includedPages.push(pageNum);
  }

  parts.push('');
  parts.push('=== END CHUNK ===');
  parts.push('');

  if (priorProfile) {
    parts.push(`Update the profile based on this chunk. Carry forward everything from the prior profile-so-far unless this chunk contradicts it. Add new headings, keyFacts, bundleHints, summarySources where this chunk reveals them. If this chunk adds nothing useful, return the prior profile unchanged.`);
  } else {
    parts.push(`This is the first chunk. Produce an initial profile from what you can observe here, knowing more chunks will follow. Don't speculate about content you haven't seen yet — the next chunk will refine the profile. Set typeConfidence to "high" only if the document type is plainly stated in the pages above.`);
  }

  parts.push('');
  parts.push('Output JSON ONLY — no prose before or after, no code fences. The JSON must conform to this schema:');
  parts.push('');
  parts.push(PROFILE_OUTPUT_SCHEMA_DESCRIPTION);

  return { prompt: parts.join('\n'), totalChars, includedPages };
}

/**
 * Split a markdownPages map into chunks, each ≤ charLimit chars (excluding
 * prompt overhead — the caller adds that). Page boundaries are respected; a
 * single page that exceeds charLimit is placed alone in its own chunk
 * (the caller's prompt construction will handle the truncation report).
 *
 * @param {Object<string, string>} markdownPages
 * @param {number} charLimit
 * @returns {Array<Object<string, string>>} array of chunk maps in page order
 */
function chunkPagesByCharLimit(markdownPages, charLimit) {
  const pageNumbers = Object.keys(markdownPages || {})
    .map((k) => parseInt(k, 10))
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b);

  const chunks = [];
  let current = {};
  let currentSize = 0;

  for (const n of pageNumbers) {
    const md = markdownPages[String(n)] || '';
    // Account for the page header/footer overhead the prompt will add.
    const projected = currentSize + md.length + 64;
    if (projected > charLimit && currentSize > 0) {
      chunks.push(current);
      current = {};
      currentSize = 0;
    }
    current[String(n)] = md;
    currentSize += md.length + 64;
  }
  if (Object.keys(current).length > 0) chunks.push(current);
  return chunks;
}

const PROFILE_OUTPUT_SCHEMA_DESCRIPTION = `{
  "type": "frame_contract" | "order_form" | "amendment" | "nda" | "letter_of_intent" | "cim" | "financial_statement" | "board_memo" | "presentation" | "email_correspondence" | "regulatory_filing" | "org_chart" | "cap_table" | "due_diligence_report" | "other",
  "typeConfidence": "high" | "medium" | "low",
  "title": string,                    // human-readable doc title
  "summary": string,                  // 2-3 sentences
  "summarySources": [                 // {page, quote} for each material claim in the summary
    { "page": int, "quote": string }
  ],
  "headings": [                       // tree of h1/h2/h3
    {
      "id": string,                   // stable id like "h1", "h1.1"
      "level": 1 | 2 | 3,
      "text": string,                 // the heading text exactly as it appears
      "page": int,                    // page where the heading begins
      "pageEnd": int | null,          // page where its content ends (before next heading); null for last
      "summaryBullets": [string],     // 2-5 bullets of what's under this heading
      "children": [ ... ]             // recursive
    }
  ],
  "keyFacts": {                       // ALL fields nullable; ONLY emit non-null when explicit in the document
    "parties": [string] | null,                              // verbatim full legal names
    "partiesSource": { "page": int, "quote": string } | null,
    "effectiveDate": "YYYY-MM-DD" | null,
    "effectiveDateSource": { "page": int, "quote": string } | null,
    "term": { "initial": string, "renewal": string | null, "notice": string | null } | null,
    "termSource": { "page": int, "quote": string } | null,
    "governingLaw": string | null,                           // canonical form per system instructions
    "governingLawSource": { "page": int, "quote": string } | null,
    "venue": string | null,
    "venueSource": { "page": int, "quote": string } | null,
    "changeOfControl": "consent_required" | "termination_right" | "notice_only" | "silent" | null,
    "changeOfControlSource": { "page": int, "quote": string } | null,
    "assignmentRequiresConsent": boolean | null,
    "assignmentSource": { "page": int, "quote": string } | null
  },
  "entities": [                       // 5-15 material entities; each MUST have a verified {page, quote} source
    {
      "name": string,                 // canonical name as it appears in the document
      "category": "company_org" | "person" | "issue_risk_failure" | "idea_upside" | "product_service" | "asset",
      "description": string,          // 1-2 sentences on why this entity is relevant to diligence
      "source": { "page": int, "quote": string }  // verbatim quote from that page; will be validated
    }
  ],
  "bundleHints": [                    // textual references to other docs in this bundle
    { "kind": "references" | "incorporates_by_reference" | "amends" | "exhibit_to", "text": string, "page": int }
  ],
  "openQuestions": [string]           // optional notes about gaps (e.g., "Schedule 4 referenced but not present")
}`;

// ════════════════════════════════════════════════════════════════════════
// VALIDATION
// ════════════════════════════════════════════════════════════════════════

/**
 * Validate the basic shape of a parsed profile. Returns { ok, errors[] }.
 * Does NOT validate page-quote pointers — that's validateProfileHeadings.
 *
 * @param {*} parsed
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateProfileShape(parsed) {
  const errors = [];
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, errors: ['profile is not an object'] };
  }
  if (!VALID_DOC_TYPES.includes(parsed.type)) errors.push(`type must be one of: ${VALID_DOC_TYPES.join(', ')}`);
  if (!VALID_CONFIDENCE.includes(parsed.typeConfidence)) errors.push(`typeConfidence must be one of: ${VALID_CONFIDENCE.join(', ')}`);
  if (typeof parsed.title !== 'string') errors.push('title must be a string');
  if (typeof parsed.summary !== 'string') errors.push('summary must be a string');
  if (!Array.isArray(parsed.summarySources)) errors.push('summarySources must be an array');
  if (!Array.isArray(parsed.headings)) errors.push('headings must be an array');

  // Validate headings tree recursively (shape only; pointer validation later).
  const validateHeading = (h, prefix) => {
    if (!h || typeof h !== 'object') {
      errors.push(`${prefix}: not an object`);
      return;
    }
    if (typeof h.id !== 'string' || !h.id) errors.push(`${prefix}.id must be non-empty string`);
    if (![1, 2, 3].includes(h.level)) errors.push(`${prefix}.level must be 1 | 2 | 3`);
    if (typeof h.text !== 'string' || !h.text) errors.push(`${prefix}.text must be non-empty string`);
    if (typeof h.page !== 'number' || !Number.isInteger(h.page)) errors.push(`${prefix}.page must be integer`);
    if (h.pageEnd !== null && (!Number.isInteger(h.pageEnd))) errors.push(`${prefix}.pageEnd must be integer or null`);
    if (!Array.isArray(h.summaryBullets)) errors.push(`${prefix}.summaryBullets must be array`);
    if (!Array.isArray(h.children)) errors.push(`${prefix}.children must be array`);
    if (Array.isArray(h.children)) h.children.forEach((c, i) => validateHeading(c, `${prefix}.children[${i}]`));
  };
  if (Array.isArray(parsed.headings)) {
    parsed.headings.forEach((h, i) => validateHeading(h, `headings[${i}]`));
  }

  // keyFacts: all fields nullable; only check structure for non-null ones.
  const kf = parsed.keyFacts;
  if (!kf || typeof kf !== 'object') {
    errors.push('keyFacts must be an object');
  } else {
    if (kf.parties !== null && !Array.isArray(kf.parties)) errors.push('keyFacts.parties must be array or null');
    if (kf.changeOfControl !== null && kf.changeOfControl !== undefined && !VALID_COC.includes(kf.changeOfControl)) {
      errors.push(`keyFacts.changeOfControl must be one of: ${VALID_COC.join(', ')} or null`);
    }
    if (kf.assignmentRequiresConsent !== null && typeof kf.assignmentRequiresConsent !== 'boolean' && kf.assignmentRequiresConsent !== undefined) {
      errors.push('keyFacts.assignmentRequiresConsent must be boolean or null');
    }
    // Validate sources are { page, quote } when their value is non-null.
    const checkSource = (valueKey, sourceKey) => {
      if (kf[valueKey] !== null && kf[valueKey] !== undefined) {
        const src = kf[sourceKey];
        if (!src || typeof src !== 'object' || !Number.isInteger(src.page) || typeof src.quote !== 'string') {
          errors.push(`keyFacts.${sourceKey} must be { page: int, quote: string } when ${valueKey} is non-null`);
        }
      }
    };
    checkSource('parties', 'partiesSource');
    checkSource('effectiveDate', 'effectiveDateSource');
    checkSource('term', 'termSource');
    checkSource('governingLaw', 'governingLawSource');
    checkSource('venue', 'venueSource');
    checkSource('changeOfControl', 'changeOfControlSource');
    checkSource('assignmentRequiresConsent', 'assignmentSource');
  }

  if (!Array.isArray(parsed.bundleHints)) errors.push('bundleHints must be an array');

  // entities: optional array; when present validate each entry's shape.
  if (parsed.entities !== undefined && parsed.entities !== null) {
    if (!Array.isArray(parsed.entities)) {
      errors.push('entities must be an array or null/omitted');
    } else {
      parsed.entities.forEach((e, i) => {
        const prefix = `entities[${i}]`;
        if (!e || typeof e !== 'object') { errors.push(`${prefix}: not an object`); return; }
        if (typeof e.name !== 'string' || !e.name) errors.push(`${prefix}.name must be non-empty string`);
        if (!VALID_ENTITY_CATEGORIES.includes(e.category)) {
          errors.push(`${prefix}.category must be one of: ${VALID_ENTITY_CATEGORIES.join(', ')}`);
        }
        if (typeof e.description !== 'string') errors.push(`${prefix}.description must be a string`);
        if (!e.source || typeof e.source !== 'object'
          || !Number.isInteger(e.source.page)
          || typeof e.source.quote !== 'string') {
          errors.push(`${prefix}.source must be { page: int, quote: string }`);
        }
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Validate that every {page, quote} pointer in the profile actually
 * corresponds to text on the cited page in markdownPages. Returns the
 * profile with bad pointers DROPPED (or flagged on headings).
 *
 * Whitespace-normalized substring match: the first QUOTE_VALIDATION_LENGTH
 * non-whitespace characters of the quote must appear in the page's
 * normalized markdown.
 *
 * @param {Object} profile - shape-validated profile
 * @param {Object<string, string>} markdownPages
 * @returns {{ profile: Object, droppedHeadings: number, droppedKeyFacts: string[], droppedBundleHints: number, droppedSummarySources: number }}
 */
function validateProfileHeadings(profile, markdownPages) {
  const normalize = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const pageNorm = {};
  for (const [k, v] of Object.entries(markdownPages || {})) {
    pageNorm[k] = normalize(v);
  }

  const quoteMatches = (page, quote) => {
    if (!quote) return false;
    const norm = pageNorm[String(page)];
    if (!norm) return false;
    const cleanQuote = normalize(quote);
    if (!cleanQuote) return false;
    // Try the first 30 non-whitespace chars; if quote is shorter, take the whole thing.
    const probe = cleanQuote.length > QUOTE_VALIDATION_LENGTH
      ? cleanQuote.substring(0, QUOTE_VALIDATION_LENGTH)
      : cleanQuote;
    return norm.includes(probe);
  };

  let droppedHeadings = 0;
  const filterHeadings = (headings) => {
    const out = [];
    for (const h of headings || []) {
      // Headings: validate by checking heading.text appears on the cited page.
      const pageMd = pageNorm[String(h.page)];
      const headingNorm = normalize(h.text);
      if (!pageMd || !headingNorm) {
        droppedHeadings++;
        continue;
      }
      // Allow shorter probe for headings (they're short by nature).
      const probe = headingNorm.length > QUOTE_VALIDATION_LENGTH
        ? headingNorm.substring(0, QUOTE_VALIDATION_LENGTH)
        : headingNorm;
      if (!pageMd.includes(probe)) {
        droppedHeadings++;
        continue;
      }
      const filteredChildren = filterHeadings(h.children || []);
      out.push({ ...h, children: filteredChildren });
    }
    return out;
  };
  const filteredHeadings = filterHeadings(profile.headings || []);

  // keyFacts: drop a field's value AND its source if the source quote doesn't
  // validate. (We never keep a value without a verified source — the keyFacts
  // short-circuit relies on this.)
  const droppedKeyFacts = [];
  const kf = { ...(profile.keyFacts || {}) };
  const checkAndDrop = (valueKey, sourceKey) => {
    if (kf[valueKey] !== null && kf[valueKey] !== undefined) {
      const src = kf[sourceKey];
      if (!src || !quoteMatches(src.page, src.quote)) {
        droppedKeyFacts.push(valueKey);
        kf[valueKey] = null;
        kf[sourceKey] = null;
      }
    }
  };
  checkAndDrop('parties', 'partiesSource');
  checkAndDrop('effectiveDate', 'effectiveDateSource');
  checkAndDrop('term', 'termSource');
  checkAndDrop('governingLaw', 'governingLawSource');
  checkAndDrop('venue', 'venueSource');
  checkAndDrop('changeOfControl', 'changeOfControlSource');
  checkAndDrop('assignmentRequiresConsent', 'assignmentSource');

  // bundleHints: drop entries whose quote doesn't validate.
  let droppedBundleHints = 0;
  const filteredBundleHints = (profile.bundleHints || []).filter((bh) => {
    if (!bh || !Number.isInteger(bh.page) || typeof bh.text !== 'string') {
      droppedBundleHints++;
      return false;
    }
    if (!quoteMatches(bh.page, bh.text)) {
      droppedBundleHints++;
      return false;
    }
    return true;
  });

  // summarySources: drop entries whose quote doesn't validate.
  let droppedSummarySources = 0;
  const filteredSummarySources = (profile.summarySources || []).filter((s) => {
    if (!s || !Number.isInteger(s.page) || typeof s.quote !== 'string') {
      droppedSummarySources++;
      return false;
    }
    if (!quoteMatches(s.page, s.quote)) {
      droppedSummarySources++;
      return false;
    }
    return true;
  });

  // entities: drop entries whose source quote doesn't validate.
  let droppedEntities = 0;
  const filteredEntities = Array.isArray(profile.entities)
    ? profile.entities.filter((e) => {
        if (!e || !e.source || !Number.isInteger(e.source.page) || typeof e.source.quote !== 'string') {
          droppedEntities++;
          return false;
        }
        if (!quoteMatches(e.source.page, e.source.quote)) {
          droppedEntities++;
          return false;
        }
        return true;
      })
    : [];

  return {
    profile: {
      ...profile,
      headings: filteredHeadings,
      keyFacts: kf,
      entities: filteredEntities,
      bundleHints: filteredBundleHints,
      summarySources: filteredSummarySources
    },
    droppedHeadings,
    droppedKeyFacts,
    droppedEntities,
    droppedBundleHints,
    droppedSummarySources
  };
}

/**
 * Parse the model's response. Anthropic Sonnet returns content as an array
 * of blocks; we expect one or more text blocks whose joined content is JSON.
 * Tolerates code fences and surrounding whitespace.
 *
 * @param {Object} response - Anthropic messages.create result
 * @returns {{ ok: boolean, parsed?: any, error?: string }}
 */
function parseProfileResponse(response) {
  const blocks = response?.content || [];
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
  if (!text) return { ok: false, error: 'no text content in response' };

  let candidate = text.trim();

  try {
    const parsed = JSON.parse(candidate);
    return { ok: true, parsed };
  } catch (err) {
    // 2. Agar fail ho, toh code fences (```json) ko strip karein aur fir try karein
    const fenceMatch = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    if (fenceMatch) {
      candidate = fenceMatch[1].trim();
      try {
        const parsed = JSON.parse(candidate);
        return { ok: true, parsed };
      } catch (err2) {
        // Fall through
      }
    }

    const firstBrace = candidate.indexOf('{');
    const lastBrace = candidate.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      const extracted = candidate.slice(firstBrace, lastBrace + 1);
      try {
        const parsed = JSON.parse(extracted);
        return { ok: true, parsed };
      } catch (err3) {
        // Fall through
      }
    }

    console.error('\n🚨 [ProfileBuilder] RAW RESPONSE THAT FAILED TO PARSE:\n', text, '\n');
    return { ok: false, error: `JSON parse failed: ${err.message}` };
  }
}


// ════════════════════════════════════════════════════════════════════════
// THE BUILDER
// ════════════════════════════════════════════════════════════════════════

/**
 * Build a structured profile for one document.
 *
 * Best-effort: caller should treat any thrown error as "no profile produced;
 * mark documentProfileSummary.status = 'failed'" — which is what
 * processFileCore does when wiring this in.
 *
 * @param {Object} args
 * @param {string} args.fileName - for prompt context only
 * @param {Object<string, string>} args.markdownPages - { "1": "...", "2": "..." }
 * @param {string} [args.contentHash] - SHA256 of pages (for idempotency); stored on profile
 * @param {Object} [args.anthropicOverride] - inject a mock client for tests
 * @returns {Promise<{ profile: Object, meta: Object }>}
 */
async function buildDocumentProfile({ fileName, folderPath = null, markdownPages, contentHash, anthropicOverride }) {
  if (!markdownPages || typeof markdownPages !== 'object') {
    throw new Error('[ProfileBuilder] markdownPages is required');
  }
  const totalDocChars = Object.values(markdownPages).reduce((acc, s) => acc + (typeof s === 'string' ? s.length : 0), 0);

  // Truncate the absolute tail if the document somehow exceeds MAX_TOTAL_CHARS
  // — extremely rare in practice; warn loudly so it shows up in logs.
  let workingPages = markdownPages;
  let totalDocTruncated = false;
  if (totalDocChars > MAX_TOTAL_CHARS) {
    console.warn(`[ProfileBuilder] document exceeds MAX_TOTAL_CHARS (${totalDocChars} > ${MAX_TOTAL_CHARS}); truncating tail pages`);
    const sortedPages = Object.keys(markdownPages)
      .map((k) => parseInt(k, 10))
      .filter((n) => !Number.isNaN(n))
      .sort((a, b) => a - b);
    const trimmed = {};
    let acc = 0;
    for (const n of sortedPages) {
      const md = markdownPages[String(n)] || '';
      if (acc + md.length > MAX_TOTAL_CHARS) break;
      trimmed[String(n)] = md;
      acc += md.length;
    }
    workingPages = trimmed;
    totalDocTruncated = true;
  }

  const workingTotalChars = Object.values(workingPages).reduce((acc, s) => acc + s.length, 0);

  // Single-pass for documents that fit. Otherwise chunked (multi-pass).
  if (workingTotalChars <= MAX_SINGLE_PASS_CHARS) {
    return buildDocumentProfileSinglePass({
      fileName,
      folderPath,
      markdownPages: workingPages,
      contentHash,
      anthropicOverride,
      totalDocTruncated
    });
  }
  return buildDocumentProfileChunked({
    fileName,
    folderPath,
    markdownPages: workingPages,
    contentHash,
    anthropicOverride,
    totalDocTruncated
  });
}

/**
 * Single-pass profile build — for documents that fit in MAX_SINGLE_PASS_CHARS.
 * Internal; callers go through buildDocumentProfile().
 */
async function buildDocumentProfileSinglePass({ fileName, folderPath, markdownPages, contentHash, anthropicOverride, totalDocTruncated }) {
  const { prompt, totalChars, truncated, includedPages } = buildProfilePrompt({ fileName, folderPath, markdownPages });
  if (includedPages.length === 0) {
    throw new Error('[ProfileBuilder] markdownPages contains no usable pages');
  }
  if (truncated) {
    console.warn(`[ProfileBuilder] single-pass truncated: ${includedPages.length} of ${Object.keys(markdownPages).length} pages fit within ${MAX_SINGLE_PASS_CHARS} char cap`);
  }

  const client = anthropicOverride || getAnthropicClient();
  const startedAt = Date.now();

  const response = await client.messages.create({
    model: PROFILE_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: PROFILE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }]
  });

  const callDurationMs = Date.now() - startedAt;

  const parseResult = parseProfileResponse(response);
  if (!parseResult.ok) {
    throw new Error(`[ProfileBuilder] response parse failed: ${parseResult.error}`);
  }
  const shapeResult = validateProfileShape(parseResult.parsed);
  if (!shapeResult.ok) {
    throw new Error(`[ProfileBuilder] response failed shape validation: ${shapeResult.errors.join('; ')}`);
  }

  const validation = validateProfileHeadings(parseResult.parsed, markdownPages);

  const profile = {
    ...validation.profile,
    version: PROFILE_VERSION,
    producedByModel: PROFILE_MODEL,
    producedFromContentHash: contentHash || null,
    producedAt: admin.firestore.FieldValue.serverTimestamp(),
    inputCharCount: totalChars,
    inputPageCount: includedPages.length,
    inputTruncated: truncated || totalDocTruncated,
    chunkCount: 1
  };

  const meta = {
    mode: 'single-pass',
    callDurationMs,
    chunkCount: 1,
    inputCharCount: totalChars,
    inputPageCount: includedPages.length,
    inputTruncated: truncated || totalDocTruncated,
    droppedHeadings: validation.droppedHeadings,
    droppedKeyFacts: validation.droppedKeyFacts,
    droppedBundleHints: validation.droppedBundleHints,
    droppedSummarySources: validation.droppedSummarySources,
    inputTokens: response?.usage?.input_tokens,
    outputTokens: response?.usage?.output_tokens
  };

  return { profile, meta };
}

/**
 * Multi-pass (chunked) profile build for documents larger than
 * MAX_SINGLE_PASS_CHARS. The model receives the document in sequential
 * chunks; each pass updates the profile-so-far. Same model on every pass
 * (per single-model-per-role rule). Filename and folder path are echoed
 * on every call so the model never loses doc identity.
 *
 * @returns {Promise<{ profile: Object, meta: Object }>}
 */
async function buildDocumentProfileChunked({ fileName, folderPath, markdownPages, contentHash, anthropicOverride, totalDocTruncated }) {
  const chunks = chunkPagesByCharLimit(markdownPages, MAX_SINGLE_PASS_CHARS);
  if (chunks.length === 0) {
    throw new Error('[ProfileBuilder] no usable chunks (markdownPages empty)');
  }

  const allPageNumbers = Object.keys(markdownPages)
    .map((k) => parseInt(k, 10))
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b);

  const client = anthropicOverride || getAnthropicClient();
  const startedAt = Date.now();

  let priorProfile = null;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let lastResponse = null;

  for (let i = 0; i < chunks.length; i++) {
    const { prompt } = buildProfilePromptChunked({
      fileName,
      folderPath,
      chunkPages: chunks[i],
      chunkIndex: i,
      totalChunks: chunks.length,
      allPages: allPageNumbers,
      priorProfile
    });

    const response = await client.messages.create({
      model: PROFILE_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: PROFILE_SYSTEM_PROMPT_CHUNKED,
      messages: [{ role: 'user', content: prompt }]
    });
    lastResponse = response;
    totalInputTokens += response?.usage?.input_tokens || 0;
    totalOutputTokens += response?.usage?.output_tokens || 0;

    const parseResult = parseProfileResponse(response);
    if (!parseResult.ok) {
      throw new Error(`[ProfileBuilder] chunk ${i + 1}/${chunks.length} parse failed: ${parseResult.error}`);
    }
    const shapeResult = validateProfileShape(parseResult.parsed);
    if (!shapeResult.ok) {
      throw new Error(`[ProfileBuilder] chunk ${i + 1}/${chunks.length} shape validation failed: ${shapeResult.errors.join('; ')}`);
    }

    // Validate pointers against the FULL document (not just this chunk's pages)
    // so a fact carried forward from a prior chunk keeps its source pointer.
    const validation = validateProfileHeadings(parseResult.parsed, markdownPages);
    priorProfile = validation.profile;
  }

  const callDurationMs = Date.now() - startedAt;

  // Re-run heading/source validation on the final profile against the full
  // document one more time (defensive — every intermediate pass already did
  // this, so the result should be unchanged on the final pass).
  const finalValidation = validateProfileHeadings(priorProfile, markdownPages);

  const profile = {
    ...finalValidation.profile,
    version: PROFILE_VERSION,
    producedByModel: PROFILE_MODEL,
    producedFromContentHash: contentHash || null,
    producedAt: admin.firestore.FieldValue.serverTimestamp(),
    inputCharCount: Object.values(markdownPages).reduce((a, s) => a + s.length, 0),
    inputPageCount: allPageNumbers.length,
    inputTruncated: totalDocTruncated,
    chunkCount: chunks.length
  };

  const meta = {
    mode: 'chunked',
    callDurationMs,
    chunkCount: chunks.length,
    inputCharCount: profile.inputCharCount,
    inputPageCount: allPageNumbers.length,
    inputTruncated: totalDocTruncated,
    droppedHeadings: finalValidation.droppedHeadings,
    droppedKeyFacts: finalValidation.droppedKeyFacts,
    droppedBundleHints: finalValidation.droppedBundleHints,
    droppedSummarySources: finalValidation.droppedSummarySources,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    finalResponseUsage: lastResponse?.usage
  };

  return { profile, meta };
}

// ════════════════════════════════════════════════════════════════════════
// FIRESTORE I/O
// ════════════════════════════════════════════════════════════════════════

/**
 * Write the profile subdoc and the documentProfileSummary on the parent
 * file doc. Atomic via a batched write.
 *
 * @param {string} basePath
 * @param {string} fileId
 * @param {Object} profile - validated profile from buildDocumentProfile
 * @param {Object} [opts]
 * @param {Object} [opts.db] - injected Firestore instance (defaults to admin.firestore())
 */
async function writeProfile(basePath, fileId, profile, opts = {}) {
  const db = opts.db || admin.firestore();
  const profileRef = db.doc(`${basePath}/files/${fileId}/profile/profile_v1`);
  const fileRef = db.doc(`${basePath}/files/${fileId}`);

  const summary = buildSummary(profile);
  const batch = db.batch();
  batch.set(profileRef, profile);
  batch.update(fileRef, {
    documentProfileSummary: summary,
    documentProfileUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  await batch.commit();
}

/**
 * Mark a file as "profile build failed" without throwing — used by the
 * processFileCore wiring as the error path.
 */
async function markProfileFailed(basePath, fileId, errorMessage, opts = {}) {
  const db = opts.db || admin.firestore();
  const fileRef = db.doc(`${basePath}/files/${fileId}`);
  await fileRef.update({
    documentProfileSummary: {
      status: 'failed',
      hasProfile: false,
      error: String(errorMessage).slice(0, 500),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    documentProfileUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
}

/**
 * Build the indexable subset of the profile that gets mirrored onto the file
 * doc. Keep it small (< 1KB target) and only structured fields callers will
 * actually filter on. Long-form fields (headings tree, full keyFacts source
 * quotes, bundleHints) stay in the subdoc.
 */
function buildSummary(profile) {
  const kf = profile.keyFacts || {};
  // Mirror only the name+category of validated entities (no description/source quotes
  // to keep the summary small). Deduped by name+category.
  const seenEntityKeys = new Set();
  const summaryEntities = (profile.entities || []).reduce((acc, e) => {
    if (!e || !e.name || !e.category) return acc;
    const dedupeKey = `${e.category}::${e.name.toLowerCase()}`;
    if (seenEntityKeys.has(dedupeKey)) return acc;
    seenEntityKeys.add(dedupeKey);
    acc.push({ name: e.name, category: e.category });
    return acc;
  }, []);

  return {
    status: 'completed',
    hasProfile: true,
    version: PROFILE_VERSION,
    type: profile.type,
    typeConfidence: profile.typeConfidence,
    title: profile.title,
    summary: profile.summary,
    keyFacts: {
      parties: kf.parties || null,
      effectiveDate: kf.effectiveDate || null,
      governingLaw: kf.governingLaw || null,
      venue: kf.venue || null,
      changeOfControl: kf.changeOfControl || null,
      assignmentRequiresConsent: typeof kf.assignmentRequiresConsent === 'boolean' ? kf.assignmentRequiresConsent : null
      // term is intentionally NOT mirrored — it's structured ({initial, renewal, notice})
      // and not commonly used as a Firestore filter; the row agent reads it via the profile subdoc.
    },
    entities: summaryEntities
  };
}

// ════════════════════════════════════════════════════════════════════════
// ENTRYPOINT — to be called from processFileCore
// ════════════════════════════════════════════════════════════════════════

/**
 * Build and write a profile for one file. Best-effort: errors are caught,
 * the file's documentProfileSummary is marked 'failed', and no exception
 * propagates (matching the existing indexCloudFile pattern).
 *
 * Idempotency: callers can pass `contentHash` (e.g., the SHA256 of sorted
 * markdownPages); the builder records it on the profile, and a future
 * caller can decide to skip if hash matches.
 *
 * @param {Object} args
 * @param {string} args.basePath
 * @param {string} args.fileId
 * @param {string} args.fileName
 * @param {string|null} [args.folderPath] - human-readable folder path for the model's context, e.g. "Customer Contracts / Acme"; null when at root
 * @param {Object<string, string>} args.markdownPages
 * @param {string} [args.contentHash]
 * @param {Object} [args.db] - injected Firestore for tests
 * @param {Object} [args.anthropicOverride] - injected client for tests
 * @returns {Promise<{ ok: boolean, meta?: Object, error?: string }>}
 */
async function buildAndStoreProfile({ basePath, fileId, fileName, folderPath = null, markdownPages, contentHash, db, anthropicOverride }) {
  if (!basePath || !fileId) {
    throw new Error('[ProfileBuilder] basePath and fileId are required');
  }
  let authoritativeMarkdownPages = markdownPages;
  const firestoreDb = db || admin.firestore();

  // Check if we should fetch authoritative content from the subcollection
  // (Scaling fix: large documents only store a preview on the main doc)
  try {
    const pagesSnapshot = await firestoreDb.collection(`${basePath}/files/${fileId}/pages`).get();
    if (!pagesSnapshot.empty) {
      authoritativeMarkdownPages = {};
      pagesSnapshot.docs.forEach(doc => {
        authoritativeMarkdownPages[doc.id] = doc.data().markdown_text || '';
      });
      console.log(`[ProfileBuilder] Loaded ${pagesSnapshot.size} pages from subcollection for ${fileId}`);
    }
  } catch (err) {
    console.warn(`[ProfileBuilder] Failed to fetch subcollection for ${fileId}, falling back to provided markdownPages:`, err.message);
  }

  try {
    const { profile, meta } = await buildDocumentProfile({
      fileName,
      folderPath,
      markdownPages: authoritativeMarkdownPages,
      contentHash,
      anthropicOverride
    });
    await writeProfile(basePath, fileId, profile, { db: firestoreDb });
    console.log(`[ProfileBuilder] built profile for ${fileId}: type=${profile.type} confidence=${profile.typeConfidence} headings=${profile.headings.length} keyFactsDropped=${meta.droppedKeyFacts.length} duration=${meta.callDurationMs}ms`);
    return { ok: true, meta };
  } catch (err) {
    const errorMessage = err && err.message ? err.message : String(err);
    console.error(`[ProfileBuilder] failed for ${fileId}: ${errorMessage}`);
    try {
      await markProfileFailed(basePath, fileId, errorMessage, { db: firestoreDb });
    } catch (markErr) {
      console.error(`[ProfileBuilder] failed to mark failure status for ${fileId}: ${markErr.message}`);
    }
    return { ok: false, error: errorMessage };
  }
}

module.exports = {
  // Public entrypoints
  buildAndStoreProfile,
  buildDocumentProfile,
  writeProfile,
  markProfileFailed,
  // Pure helpers exposed for tests + reuse
  buildProfilePrompt,
  buildProfilePromptChunked,
  chunkPagesByCharLimit,
  validateProfileShape,
  validateProfileHeadings,
  parseProfileResponse,
  buildSummary,
  // Constants
  PROFILE_VERSION,
  PROFILE_MODEL,
  MAX_INPUT_CHARS,
  MAX_SINGLE_PASS_CHARS,
  MAX_TOTAL_CHARS,
  VALID_DOC_TYPES,
  VALID_COC,
  VALID_ENTITY_CATEGORIES,
  PROFILE_SYSTEM_PROMPT,
  PROFILE_SYSTEM_PROMPT_CHUNKED
};
