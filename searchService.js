/**
 * CloudFiles RAG search — local (file-processor) edition.
 *
 * Ported from functions/searchService.js. Same query-side semantics, same
 * highlighting, same grouping. Auth + tenant access checks are enforced by
 * the /search route in server.js (see app.post('/search', ...)).
 *
 * @see docs/design/CONTENT_SEARCH.md
 */

'use strict';

const admin = require('firebase-admin');
const Typesense = require('typesense');

const {
  getDocTypesenseClient,
  getCollectionName,
  generateEmbeddingsWithRetry,
} = require('./indexService');
const { generateHydeExpansion } = require('./hyde');

// ════════════════════════════════════════════════════════════════════════
// SCOPED KEY CACHE
// Per (uid, basePath) scoped Typesense search-only keys cached for
// slightly less than their TTL to reduce key-minting API calls.
// ════════════════════════════════════════════════════════════════════════
const scopedKeysCache = new Map(); // key: `${uid}::${basePath}` → { client, expiresAt }
const SCOPED_KEY_TTL_SECONDS = 60;   // Typesense key TTL
const SCOPED_KEY_CACHE_SECONDS = 50; // serve from cache until 10s before expiry

/**
 * Detects if the query contains entity-like tokens, quoted phrases, digits,
 * section symbols, or currency codes that indicate a high-value metadata search.
 */
function shouldBoostMetadata(query) {
  if (!query) return false;
  // 1. Quoted string
  if (/"[^"]+"/.test(query) || /'[^']+'/.test(query)) return true;
  // 2. Section markers or currency symbols
  if (/[§$€£¥]/.test(query)) return true;
  // 3. Digits
  if (/\d/.test(query)) return true;
  // 4. Two consecutive capitalized words (Title-Case run)
  if (/[A-Z][a-z]+\s+[A-Z][a-z]+/.test(query)) return true;
  // 5. Specific high-value keyword matches (case-insensitive)
  if (/\b(nda|dpa|ccpa|gdpr|m&a|agreement|contract|lease|shopify|klaviyo|hawkeye|hemab)\b/i.test(query)) return true;
  return false;
}

/**
 * Walks Firestore to resolve folder path strings to IDs.
 */
async function resolveFolderPaths(folderPaths, basePath) {
  const db = admin.firestore();
  const folderIds = [];

  for (const pathStr of folderPaths) {
    if (!pathStr || typeof pathStr !== 'string') continue;
    const segments = pathStr.split(/\s*[\/>]\s*/).map(s => s.trim()).filter(Boolean);
    if (segments.length === 0) continue;

    let currentParentId = 'root';
    let currentFolderId = null;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      let queryRef = db.collection(`${basePath}/file_folders`).where('name', '==', segment);
      const snap = await queryRef.get();
      if (snap.empty) {
        // Fallback: if root-level, try matching folders with null parentId
        if (currentParentId === 'root') {
          const rootSnap = await db.collection(`${basePath}/file_folders`).where('name', '==', segment).get();
          let foundDoc = null;
          rootSnap.forEach(doc => {
            const data = doc.data();
            if (!data.parentId || data.parentId === 'root') foundDoc = doc;
          });
          if (foundDoc) {
            currentFolderId = foundDoc.id;
            currentParentId = foundDoc.id;
            continue;
          }
        }
        throw new Error(`Folder path not found: "${pathStr}" (failed at segment: "${segment}")`);
      }

      let matchedDoc = null;
      snap.forEach(doc => {
        const data = doc.data();
        if (currentParentId === 'root') {
          if (!data.parentId || data.parentId === 'root') matchedDoc = doc;
        } else {
          if (data.parentId === currentParentId) matchedDoc = doc;
        }
      });

      if (!matchedDoc && snap.docs.length > 0) matchedDoc = snap.docs[0];
      if (!matchedDoc) {
        throw new Error(`Folder path not found: "${pathStr}" (failed at segment: "${segment}")`);
      }

      currentFolderId = matchedDoc.id;
      currentParentId = matchedDoc.id;
    }

    if (currentFolderId) {
      folderIds.push(currentFolderId);
    }
  }

  return folderIds;
}

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 10;
const DEFAULT_MIN_SIMILARITY = 0.62;
const MIN_ALLOWED_SIMILARITY = 0.55;
const HIGHLIGHT_WINDOW = 150;
const SNIPPET_FALLBACK = 300;
const QUERY_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'give',
  'has', 'have', 'in', 'into', 'is', 'it', 'me', 'of', 'on', 'or', 'show',
  'that', 'the', 'this', 'to', 'was', 'were', 'what', 'when', 'where', 'which',
  'with',
]);

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function makeHighlight(text, query, windowChars = HIGHLIGHT_WINDOW) {
  if (!text) return null;

  const tokens = (query || '')
    .toLowerCase()
    .split(/\W+/)
    .filter(t => t.length >= 3);

  if (tokens.length === 0) {
    const trimmed = text.length > SNIPPET_FALLBACK ? text.slice(0, SNIPPET_FALLBACK) + '…' : text;
    return escapeHtml(trimmed);
  }

  const lower = text.toLowerCase();
  let firstIdx = -1;
  for (const t of tokens) {
    const idx = lower.indexOf(t);
    if (idx >= 0 && (firstIdx < 0 || idx < firstIdx)) firstIdx = idx;
  }
  if (firstIdx < 0) {
    const trimmed = text.length > SNIPPET_FALLBACK ? text.slice(0, SNIPPET_FALLBACK) + '…' : text;
    return escapeHtml(trimmed);
  }

  const start = Math.max(0, firstIdx - windowChars);
  const end = Math.min(text.length, firstIdx + windowChars * 2);
  let snippet = text.slice(start, end);
  let safe = escapeHtml(snippet);
  if (start > 0) safe = '…' + safe;
  if (end < text.length) safe = safe + '…';

  for (const t of tokens) {
    const re = new RegExp(`(${escapeRegex(t)})`, 'gi');
    safe = safe.replace(re, '<mark>$1</mark>');
  }
  return safe;
}

/**
 * Returns an in-memory-cached scoped Typesense search-only client for the
 * given (uid, basePath) pair. Mints a new key when the cached one is absent
 * or within 10 seconds of expiry.
 *
 * Falls back to the admin client if key minting fails (e.g., no Typesense
 * admin key available) — so search never hard-fails due to scoped key errors.
 *
 * @param {string} uid
 * @param {string} basePath
 * @returns {Promise<Object>} a Typesense Client instance restricted to the collection
 */
async function getScopedSearchClient(uid, basePath) {
  const cacheKey = `${uid}::${basePath}`;
  const now = Date.now();

  const cached = scopedKeysCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.client;
  }

  const adminClient = getDocTypesenseClient();
  if (!adminClient) return null;

  try {
    const collectionName = getCollectionName(basePath);
    // Mint a search-only key scoped to this tenant's collection.
    const keyResult = await adminClient.keys().create({
      description: `scoped-search uid=${uid} basePath=${basePath}`,
      actions: ['documents:search'],
      collections: [collectionName],
      expires_at: Math.floor(Date.now() / 1000) + SCOPED_KEY_TTL_SECONDS,
    });

    const host = process.env.TYPESENSE_DOC_HOST || 'localhost';
    const port = Number(process.env.TYPESENSE_DOC_PORT) || 443;
    const protocol = process.env.TYPESENSE_DOC_PROTOCOL || 'https';

    const scopedClient = new Typesense.Client({
      nodes: [{ host, port, protocol }],
      apiKey: keyResult.value,
      connectionTimeoutSeconds: 10,
    });

    scopedKeysCache.set(cacheKey, {
      client: scopedClient,
      expiresAt: now + SCOPED_KEY_CACHE_SECONDS * 1000,
    });
    console.log(`[searchService] Minted scoped search key for uid=${uid}, collection=${collectionName}`);
    return scopedClient;
  } catch (err) {
    console.warn(`[searchService] Failed to mint scoped key (falling back to admin client): ${err.message}`);
    return adminClient; // graceful degradation
  }
}

function groupByFile(hits) {
  const groups = new Map();
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i];
    const key = hit.file_id || `__unknown_${i}`;
    if (!groups.has(key)) {
      groups.set(key, {
        file_id: hit.file_id,
        file_name: hit.file_name,
        file_extension: hit.file_extension,
        folder_path_display: hit.folder_path_display,
        match_count: 0,
        best_similarity: 0,
        snippets: [],
        // first_index: position of this file's first hit in the hybrid-ranked list.
        // Used to preserve Typesense's combined BM25+vector ranking at the group level.
        first_index: i,
      });
    }
    const g = groups.get(key);
    g.match_count++;
    if (hit.similarity > g.best_similarity) g.best_similarity = hit.similarity;
    if (g.snippets.length < 3) g.snippets.push(hit);
  }
  // Sort by first_index ascending — preserves the hybrid ranking Typesense returned.
  // (Previously sorted by best_similarity, which discarded BM25 keyword signals.)
  return Array.from(groups.values()).sort((a, b) => a.first_index - b.first_index);
}

function escapeFilterValue(v) {
  const s = String(v);
  if (/[\s,()[\]&|`]/.test(s)) return '`' + s.replace(/`/g, '') + '`';
  return s;
}

function getQueryTokens(query) {
  return String(query || '')
    .toLowerCase()
    .split(/\W+/)
    .map(t => t.trim())
    .filter(t => t.length >= 2 && !QUERY_STOP_WORDS.has(t));
}

function getSearchableText(doc, meta) {
  return [
    doc.text,
    doc.doc_metadata_text,
    doc.file_name,
    doc.folder_path_display,
    meta.file_name,
    meta.folder_path_display,
    doc.doc_type,
    Array.isArray(doc.doc_parties) ? doc.doc_parties.join(' ') : doc.doc_parties,
    doc.doc_governing_law,
    doc.doc_change_of_control,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[_\-./]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSpecificPhraseQuery(queryTokens) {
  return queryTokens.length >= 2 && queryTokens.length <= 5;
}

function getLexicalRelevance(doc, meta, queryTokens, queryPhrase) {
  const haystack = getSearchableText(doc, meta);
  const normalizedPhrase = String(queryPhrase || '')
    .toLowerCase()
    .replace(/[_\-./]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const exactPhrase = normalizedPhrase.length >= 4 && haystack.includes(normalizedPhrase);
  const matchedTokens = queryTokens.filter(t => haystack.includes(t));

  let requiredTokenCount = queryTokens.length;
  if (queryTokens.length >= 4) {
    requiredTokenCount = Math.ceil(queryTokens.length * 0.75);
  }

  return {
    exactPhrase,
    matchedTokenCount: matchedTokens.length,
    requiredTokenCount,
    isSpecificPhrase: isSpecificPhraseQuery(queryTokens),
    isRelevant: exactPhrase || (
      !isSpecificPhraseQuery(queryTokens)
      && queryTokens.length > 0
      && matchedTokens.length >= requiredTokenCount
    ),
  };
}

async function filterExistingCloudFiles(hits, basePath) {
  const fileIds = Array.from(new Set(
    hits
      .map(h => h.file_id)
      .filter(id => typeof id === 'string' && id.length > 0)
  ));
  if (fileIds.length === 0) return hits;

  const db = admin.firestore();
  const refs = fileIds.map(id => db.doc(`${basePath}/files/${id}`));
  const snaps = await db.getAll(...refs);
  const existingIds = new Set(
    snaps
      .filter(snap => snap.exists)
      .map(snap => snap.id)
  );

  return hits.filter(h => existingIds.has(h.file_id));
}

async function semanticSearch(input) {
  const {
    query,
    basePath,
    uid = null,
    folder_id = null,
    folder_ids = null,
    folder_paths = null,
    include_subfolders = true,
    file_ids = null,
    extensions = null,
    language = null,
    limit = DEFAULT_LIMIT,
    min_similarity = DEFAULT_MIN_SIMILARITY,
    group_by_file = true,
    highlight = true,
    use_hyde = false,
    hybrid = true,
  } = input || {};

  const trimmedQuery = String(query || '').trim();
  if (!trimmedQuery || trimmedQuery.length < 2) {
    return {
      query: trimmedQuery,
      mode: hybrid ? 'hybrid' : 'semantic',
      count: 0,
      results: [],
      groups: [],
      timing_ms: { embed: 0, search: 0, total: 0 },
      hyde: null,
    };
  }
  if (!basePath || typeof basePath !== 'string') {
    const err = new Error('basePath is required');
    err.status = 400;
    throw err;
  }

  const safeLimit = Math.min(Math.max(Math.floor(Number(limit) || DEFAULT_LIMIT), 1), MAX_LIMIT);
  const requestedMinSim = Number.isFinite(Number(min_similarity)) ? Number(min_similarity) : DEFAULT_MIN_SIMILARITY;
  const safeMinSim = Math.max(MIN_ALLOWED_SIMILARITY, Math.min(1, requestedMinSim));
  const queryTokens = getQueryTokens(trimmedQuery);

  // Use a scoped search-only client when uid is supplied; fall back to admin client.
  const client = uid
    ? (await getScopedSearchClient(uid, basePath)) || getDocTypesenseClient()
    : getDocTypesenseClient();
  if (!client) {
    return {
      query: trimmedQuery, mode: hybrid ? 'hybrid' : 'semantic',
      count: 0, results: [], groups: [],
      timing_ms: { embed: 0, search: 0, total: 0 },
      hyde: null,
      warning: 'TypeSense not configured (TYPESENSE_DOC_API_KEY / TYPESENSE_DOC_HOST missing)',
    };
  }

  const collectionName = getCollectionName(basePath);

  // 1. Resolve folder paths to IDs if folder_paths provided
  let activeFolderIds = [];
  if (folder_id) {
    if (folder_id === 'root' && include_subfolders) {
      // Do nothing, no filter needed to search entire workspace
    } else {
      activeFolderIds.push(folder_id);
    }
  }
  if (Array.isArray(folder_ids) && folder_ids.length > 0) {
    activeFolderIds.push(...folder_ids.filter(Boolean));
  }
  if (Array.isArray(folder_paths) && folder_paths.length > 0) {
    try {
      const resolvedIds = await resolveFolderPaths(folder_paths, basePath);
      activeFolderIds.push(...resolvedIds);
    } catch (e) {
      // Throw direct 400 bad request error for missing directories as required by spec
      const badRequestError = new Error(e.message);
      badRequestError.status = 400;
      throw badRequestError;
    }
  }

  // Deduplicate folder IDs
  activeFolderIds = Array.from(new Set(activeFolderIds));

  const filters = ['source_type:=cloudfile'];
  if (Array.isArray(file_ids) && file_ids.length > 0) {
    const ids = file_ids.map(escapeFilterValue).join(',');
    filters.push(`cloudfile_id:[${ids}]`);
  } else if (activeFolderIds.length > 0) {
    const folderFilterStrings = activeFolderIds.map(escapeFilterValue).join(',');
    if (include_subfolders) {
      filters.push(`folder_path_ids:[${folderFilterStrings}]`);
    } else {
      filters.push(`folder_id:[${folderFilterStrings}]`);
    }
  }

  if (Array.isArray(extensions) && extensions.length > 0) {
    const exts = extensions
      .map(e => String(e).toLowerCase().replace(/^\./, ''))
      .filter(Boolean);
    if (exts.length > 0) filters.push(`file_extension:[${exts.join(',')}]`);
  }
  if (language) filters.push(`language:=${escapeFilterValue(language)}`);

  // HyDE expansion
  let hydeMeta = null;
  let textToEmbed = trimmedQuery;
  if (use_hyde) {
    try {
      const t0Hyde = Date.now();
      const hyde = await generateHydeExpansion(trimmedQuery);
      textToEmbed = hyde.text;
      hydeMeta = {
        used: true,
        text: hyde.text,
        durationMs: Date.now() - t0Hyde,
        inputTokens: hyde.usage?.input_tokens,
        outputTokens: hyde.usage?.output_tokens
      };
    } catch (err) {
      console.warn(`[searchService] HyDE expansion failed (falling back to raw query): ${err.message}`);
      hydeMeta = { used: false, error: err.message };
    }
  }

  const t0 = Date.now();
  const queryEmbeddings = await generateEmbeddingsWithRetry([textToEmbed]);
  const queryVec = queryEmbeddings[0];
  const tEmbed = Date.now() - t0;

  const t1 = Date.now();
  const overFetch = Math.min(safeLimit * 3, MAX_LIMIT * 3);

  // Construct search options for TypeSense hybrid or semantic query
  const searchPayload = {
    collection: collectionName,
    filter_by: filters.join(' && '),
    per_page: overFetch,
    include_fields: 'cloudfile_id,file_name,file_extension,mime_type,folder_id,folder_path_ids,folder_path_display,chunk_index,chunk_total,page_number,page_span_json,text,metadata_json,schema_version,doc_parties,doc_type,doc_governing_law,doc_change_of_control,doc_metadata_text',
  };

  const isHybrid = hybrid && trimmedQuery && trimmedQuery !== '*';
  const requireLexicalGate = isHybrid && queryTokens.length > 0;
  if (isHybrid) {
    searchPayload.q = trimmedQuery;
    searchPayload.query_by = 'text,doc_metadata_text,file_name,folder_path_display';
    const boost = shouldBoostMetadata(trimmedQuery);
    searchPayload.query_by_weights = boost ? '1,2,3,3' : '1,1,2,2';
    searchPayload.vector_query = `embedding:([${queryVec.join(',')}], k:${overFetch})`;
  } else {
    searchPayload.q = '*';
    searchPayload.vector_query = `embedding:([${queryVec.join(',')}], k:${overFetch})`;
  }

  let multiSearchResult;
  try {
    multiSearchResult = await client.multiSearch.perform({
      searches: [searchPayload],
    });
  } catch (e) {
    if (e.httpStatus === 404) {
      return {
        query: trimmedQuery, mode: isHybrid ? 'hybrid' : 'semantic',
        count: 0, results: [], groups: [],
        timing_ms: { embed: tEmbed, search: 0, total: tEmbed },
        hyde: hydeMeta,
      };
    }
    throw e;
  }
  const tSearch = Date.now() - t1;

  const rawHits = (multiSearchResult.results && multiSearchResult.results[0] && multiSearchResult.results[0].hits) || [];

  let hits = rawHits
    .map(h => {
      const doc = h.document || {};
      let meta = {};
      if (doc.metadata_json) {
        try { meta = JSON.parse(doc.metadata_json); } catch { /* ignore */ }
      }
      const fallbackPage = Number.isFinite(doc.page_number) && doc.page_number > 0 ? doc.page_number : 1;
      let span = [fallbackPage, fallbackPage];
      if (doc.page_span_json) {
        try {
          const parsed = JSON.parse(doc.page_span_json);
          if (Array.isArray(parsed) && parsed.length === 2
              && Number.isFinite(parsed[0]) && Number.isFinite(parsed[1])
              && parsed[0] > 0 && parsed[1] > 0) {
            span = parsed;
          }
        } catch { /* ignore */ }
      }
      const lexicalRelevance = getLexicalRelevance(doc, meta, queryTokens, trimmedQuery);
      const hasVectorDistance = typeof h.vector_distance === 'number';
      const distance = hasVectorDistance ? h.vector_distance : null;
      const similarity = hasVectorDistance
        ? Math.max(0, Math.min(1, 1 - (distance / 2)))
        : (lexicalRelevance.isRelevant ? 1 : 0);

      return {
        file_id: doc.cloudfile_id || null,
        file_name: doc.file_name || meta.file_name || null,
        file_extension: doc.file_extension || null,
        mime_type: doc.mime_type || null,
        folder_id: doc.folder_id || null,
        folder_path_ids: Array.isArray(doc.folder_path_ids) ? doc.folder_path_ids : [],
        folder_path_display: doc.folder_path_display || meta.folder_path_display || null,
        chunk_index: Number.isFinite(doc.chunk_index) ? doc.chunk_index : null,
        chunk_total: Number.isFinite(doc.chunk_total) ? doc.chunk_total : null,
        page_number: span[0],
        page_span: span,
        text: doc.text || '',
        similarity,
        schema_version: Number.isFinite(doc.schema_version) ? doc.schema_version : 1,
        doc_metadata: {
          doc_type: doc.doc_type || meta.doc_type || 'other',
          doc_parties: doc.doc_parties || meta.doc_parties || [],
          doc_governing_law: doc.doc_governing_law || meta.doc_governing_law || null,
          doc_change_of_control: doc.doc_change_of_control || meta.doc_change_of_control || null,
          folder_path_display: doc.folder_path_display || meta.folder_path_display || null,
        },
        _lexicalRelevance: lexicalRelevance,
      };
    })
    .filter(h => h.similarity >= safeMinSim)
    .filter(h => !requireLexicalGate || h._lexicalRelevance.isRelevant)
    .sort((a, b) => {
      const aRel = a._lexicalRelevance || {};
      const bRel = b._lexicalRelevance || {};
      if (aRel.exactPhrase !== bRel.exactPhrase) return aRel.exactPhrase ? -1 : 1;
      if ((aRel.matchedTokenCount || 0) !== (bRel.matchedTokenCount || 0)) {
        return (bRel.matchedTokenCount || 0) - (aRel.matchedTokenCount || 0);
      }
      return b.similarity - a.similarity;
    })
    .slice(0, safeLimit)
    .map(({ _lexicalRelevance, ...hit }) => hit);

  hits = await filterExistingCloudFiles(hits, basePath);

  if (highlight) {
    for (const h of hits) h.highlight = makeHighlight(h.text, trimmedQuery);
  }

  const result = {
    query: trimmedQuery,
    mode: isHybrid ? 'hybrid' : 'semantic',
    count: hits.length,
    results: hits,
    timing_ms: { embed: tEmbed, search: tSearch, total: tEmbed + tSearch },
    hyde: hydeMeta,
  };
  if (group_by_file) result.groups = groupByFile(hits);
  return result;
}

module.exports = {
  semanticSearch,
  makeHighlight,
  groupByFile,
  getScopedSearchClient,
  escapeFilterValue,
  escapeHtml,
};
