/**
 * HyDE — Hypothetical Document Embeddings.
 *
 * Standard RAG-quality lift: instead of embedding the user's literal query,
 * ask an LLM to write a brief hypothetical "ideal answer" document, embed
 * THAT, and use its vector for the search. Better recall on sparse or
 * abstract queries — the hypothetical text contains the kind of language
 * a relevant chunk would actually use.
 *
 * Tradeoffs:
 *   + Better recall on abstract queries ("change of control implications").
 *   + Cheap: one Haiku call (~$0.0001-0.0003 per query).
 *   - Adds latency: ~500ms-1s of model time on top of the embed call.
 *   - Useless / mildly harmful for exact-token queries (section numbers,
 *     dollar figures). Hybrid retrieval (BM25 + vector) at the search layer
 *     compensates; the user can also disable HyDE explicitly.
 *
 * The HyDE expansion is a different ROLE from profile-building, so the
 * single-model-per-role rule is satisfied with Haiku here independently of
 * Sonnet for profiles.
 *
 * @see docs/design/DUE_DILIGENCE_API.md (§3.5 hybrid retrieval; HyDE toggle)
 */

'use strict';

const Anthropic = require('@anthropic-ai/sdk');

// ════════════════════════════════════════════════════════════════════════
// CONFIGURATION — resolved + logged at module load (no silent fallbacks).
// ════════════════════════════════════════════════════════════════════════

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

  const hydeModel = stringEnv(process.env.HYDE_MODEL, 'claude-haiku-4-5');
  const hydeMaxTokens = positiveIntEnv(process.env.HYDE_MAX_TOKENS, 350, 'HYDE_MAX_TOKENS');
  // 8s timeout — Haiku usually responds in well under 1s; if we're past 8s
  // something's wrong upstream and the search should proceed without HyDE.
  const hydeTimeoutMs = positiveIntEnv(process.env.HYDE_TIMEOUT_MS, 8000, 'HYDE_TIMEOUT_MS');

  if (errors.length) {
    throw new Error('[Hyde] invalid configuration:\n  ' + errors.join('\n  '));
  }

  const isTestEnv = process.env.NODE_ENV === 'test' || process.env.VITEST;
  if (!isTestEnv) {
    console.log('[Hyde] resolved configuration:');
    console.log(`  HYDE_MODEL = ${hydeModel.value} (${hydeModel.fromEnv ? 'from env' : 'default'})`);
    console.log(`  HYDE_MAX_TOKENS = ${hydeMaxTokens.value} (${hydeMaxTokens.fromEnv ? 'from env' : 'default'})`);
    console.log(`  HYDE_TIMEOUT_MS = ${hydeTimeoutMs.value} (${hydeTimeoutMs.fromEnv ? 'from env' : 'default'})`);
  }

  return {
    HYDE_MODEL: hydeModel.value,
    HYDE_MAX_TOKENS: hydeMaxTokens.value,
    HYDE_TIMEOUT_MS: hydeTimeoutMs.value
  };
})();

const HYDE_MODEL = CONFIG.HYDE_MODEL;
const HYDE_MAX_TOKENS = CONFIG.HYDE_MAX_TOKENS;
const HYDE_TIMEOUT_MS = CONFIG.HYDE_TIMEOUT_MS;

let anthropicClient = null;
function getAnthropicClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('[Hyde] ANTHROPIC_API_KEY not set');
  }
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

// ════════════════════════════════════════════════════════════════════════
// PROMPT
// ════════════════════════════════════════════════════════════════════════

const HYDE_SYSTEM_PROMPT = `You are a HyDE (Hypothetical Document Embeddings) helper. Your job: given a user's search query, write a short, concrete hypothetical passage — 2-4 sentences — that would plausibly appear in a document that answers the query.

The passage will be embedded and used for vector search against an M&A diligence data room (contracts, CIMs, financial statements, board memos). Match the tone and vocabulary of those documents.

Rules:

1. Write as if quoting from a document, not as an answer to the user.
2. Use specific, concrete language — name parties / clauses / sections in the way a real contract would. Don't be generic.
3. Don't invent specific numbers, names, or dates. Use phrasing like "the parties", "such period", "the Customer".
4. Don't write a summary or preamble — just the hypothetical passage.
5. Output PLAIN TEXT only — no markdown, no quotes around the output, no labels.

Examples:

Query: "change of control consent"
Output: In the event of a Change of Control of either party, the other party's prior written consent shall be required, such consent not to be unreasonably withheld. Failure to obtain consent within thirty (30) days of notice shall entitle the non-affected party to terminate this Agreement upon written notice without further liability.

Query: "indemnification cap"
Output: The aggregate liability of either party arising out of or relating to this Agreement shall not exceed the amount of fees paid by Customer in the twelve (12) months preceding the event giving rise to the claim. The cap set forth herein shall not apply to indemnification obligations under Section 9 (IP Indemnity) or breaches of confidentiality.`;

// ════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ════════════════════════════════════════════════════════════════════════

/**
 * Generate a HyDE expansion for a query — a hypothetical passage that would
 * appear in a relevant document, intended for embedding (NOT for display).
 *
 * Honors a wall-clock timeout: if Haiku takes longer than HYDE_TIMEOUT_MS,
 * the call is abandoned and the caller falls back to the original query.
 *
 * @param {string} query
 * @param {Object} [opts]
 * @param {Object} [opts.anthropicOverride] - inject a mock client for tests
 * @param {number} [opts.timeoutMs] - override the default timeout
 * @returns {Promise<{ text: string, durationMs: number, usage?: Object }>}
 */
async function generateHydeExpansion(query, opts = {}) {
  if (typeof query !== 'string' || !query.trim()) {
    throw new Error('[Hyde] query must be a non-empty string');
  }
  const client = opts.anthropicOverride || getAnthropicClient();
  const timeoutMs = opts.timeoutMs || HYDE_TIMEOUT_MS;
  const startedAt = Date.now();

  // AbortController so the timeout actually cancels the underlying Anthropic
  // call instead of leaving it running silently (rate-limit budget hygiene).
  // The Anthropic SDK accepts a signal in the second-arg request options.
  const controller = new AbortController();
  let timeoutFired = false;
  const timer = setTimeout(() => {
    timeoutFired = true;
    controller.abort();
  }, timeoutMs);

  let response;
  try {
    response = await client.messages.create(
      {
        model: HYDE_MODEL,
        max_tokens: HYDE_MAX_TOKENS,
        system: HYDE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `Query: ${query.trim()}\nOutput:` }]
      },
      { signal: controller.signal }
    );
  } catch (err) {
    if (timeoutFired) {
      throw new Error(`[Hyde] timeout after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const durationMs = Date.now() - startedAt;

  const blocks = response?.content || [];
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  if (!text) {
    throw new Error('[Hyde] empty response from model');
  }

  return { text, durationMs, usage: response?.usage };
}

module.exports = {
  generateHydeExpansion,
  HYDE_SYSTEM_PROMPT,
  HYDE_MODEL,
  HYDE_MAX_TOKENS,
  HYDE_TIMEOUT_MS
};
