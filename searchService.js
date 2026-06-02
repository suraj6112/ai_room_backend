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
  indexCloudFile,
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
const autoReindexState = new Map(); // key: basePath -> { running, lastStartedAt }
const staleChunkDeleteState = new Set(); // key: `${basePath}::${fileId}`
const AUTO_REINDEX_COOLDOWN_MS = Number(process.env.SEARCH_AUTO_REINDEX_COOLDOWN_MS) || 10 * 60 * 1000;
const AUTO_REINDEX_LIMIT = Math.min(Math.max(Number(process.env.SEARCH_AUTO_REINDEX_LIMIT) || 200, 1), 1000);

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
  if (/[\s,()[\]&|`/]/.test(s)) return '`' + s.replace(/`/g, '') + '`';
  return s;
}

function summarizeHitForDebug(hit) {
  if (!hit) return null;
  return {
    file_id: hit.file_id,
    base_path: hit.base_path,
    file_name: hit.file_name,
    folder_id: hit.folder_id,
    similarity: hit.similarity,
  };
}

function scheduleAutoReindexForLegacyIndex(basePath, reason = 'legacy_index_fallback') {
  if (process.env.SEARCH_AUTO_REINDEX_ON_LEGACY === 'false') return;
  if (!basePath || typeof basePath !== 'string') return;

  const now = Date.now();
  const state = autoReindexState.get(basePath);
  if (state?.running) {
    console.log('[searchService][debug] Auto reindex already running', { basePath, reason });
    return;
  }
  if (state?.lastStartedAt && now - state.lastStartedAt < AUTO_REINDEX_COOLDOWN_MS) {
    console.log('[searchService][debug] Auto reindex skipped by cooldown', {
      basePath,
      reason,
      nextAllowedInMs: AUTO_REINDEX_COOLDOWN_MS - (now - state.lastStartedAt),
    });
    return;
  }

  autoReindexState.set(basePath, { running: true, lastStartedAt: now });
  setImmediate(async () => {
    const startedAt = Date.now();
    const db = admin.firestore();
    const summary = { total: 0, indexed: 0, skipped: 0, failed: 0, chunksIndexed: 0 };

    console.warn('[searchService][debug] Auto reindex started for legacy search index', {
      basePath,
      reason,
      limit: AUTO_REINDEX_LIMIT,
    });

    try {
      const filesSnap = await db
        .collection(`${basePath}/files`)
        .orderBy('createdAt', 'desc')
        .limit(AUTO_REINDEX_LIMIT)
        .get();

      summary.total = filesSnap.size;

      for (const docSnap of filesSnap.docs) {
        const fileId = docSnap.id;
        const fileData = docSnap.data() || {};
        if (fileData.processingStatus && fileData.processingStatus !== 'completed') {
          summary.skipped += 1;
          continue;
        }

        try {
          const result = await indexCloudFile(fileId, basePath, fileData);
          if (result?.skipped) {
            summary.skipped += 1;
          } else {
            summary.indexed += 1;
            summary.chunksIndexed += Number(result?.chunksIndexed) || 0;
          }
        } catch (err) {
          summary.failed += 1;
          console.warn('[searchService][debug] Auto reindex file failed', {
            basePath,
            fileId,
            error: err.message,
          });
        }
      }

      console.warn('[searchService][debug] Auto reindex finished', {
        basePath,
        durationMs: Date.now() - startedAt,
        ...summary,
      });
    } catch (err) {
      console.warn('[searchService][debug] Auto reindex failed', {
        basePath,
        error: err.message,
      });
    } finally {
      autoReindexState.set(basePath, { running: false, lastStartedAt: startedAt });
    }
  });
}

function scheduleDeleteIndexedChunks(basePath, fileId, reason) {
  if (!basePath || !fileId) return;
  const key = `${basePath}::${fileId}`;
  if (staleChunkDeleteState.has(key)) return;
  staleChunkDeleteState.add(key);

  setImmediate(async () => {
    try {
      const client = getDocTypesenseClient();
      if (!client) return;
      const collectionName = getCollectionName(basePath);
      const deleteResult = await client.collections(collectionName).documents().delete({
        filter_by: `cloudfile_id:=${escapeFilterValue(fileId)}`,
      });
      console.warn('[searchService][debug] Deleted stale Typesense chunks for invalid search file', {
        basePath,
        fileId,
        reason,
        deleted: deleteResult?.num_deleted || 0,
      });
    } catch (err) {
      console.warn('[searchService][debug] Failed to delete stale Typesense chunks', {
        basePath,
        fileId,
        reason,
        error: err.message,
      });
    } finally {
      staleChunkDeleteState.delete(key);
    }
  });
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
  if (fileIds.length === 0) {
    console.log('[searchService][debug] Firestore validation skipped: no file_ids in hits', {
      basePath,
      hitCount: hits.length,
    });
    return hits;
  }

  const db = admin.firestore();
  const refs = fileIds.map(id => db.doc(`${basePath}/files/${id}`));
  console.log('[searchService][debug] Firestore validating search hits', {
    basePath,
    fileIds,
    hitCount: hits.length,
  });
  const snaps = await db.getAll(...refs);
  const filesById = new Map();
  for (const snap of snaps) {
    if (snap.exists) filesById.set(snap.id, snap.data() || {});
  }

  const storageExistsByPath = new Map();
  const storagePaths = Array.from(new Set(
    Array.from(filesById.values())
      .map(fileData => fileData.storagePath)
      .filter(path => typeof path === 'string' && path.length > 0)
  ));
  if (storagePaths.length > 0) {
    try {
      const bucket = admin.storage().bucket();
      await Promise.all(storagePaths.map(async storagePath => {
        try {
          const [exists] = await bucket.file(storagePath).exists();
          storageExistsByPath.set(storagePath, !!exists);
        } catch (err) {
          storageExistsByPath.set(storagePath, null);
          console.warn('[searchService][debug] Storage existence check failed', {
            basePath,
            storagePath,
            error: err.message,
          });
        }
      }));
    } catch (err) {
      console.warn('[searchService][debug] Storage bucket unavailable during search validation', {
        basePath,
        error: err.message,
      });
    }
  }

  const folderIds = Array.from(new Set(
    Array.from(filesById.values())
      .flatMap(fileData => {
        const ids = [];
        if (fileData.folderId && fileData.folderId !== 'root') ids.push(fileData.folderId);
        if (Array.isArray(fileData.folderPathIds)) {
          ids.push(...fileData.folderPathIds.filter(id => id && id !== 'root'));
        }
        return ids;
      })
  ));
  const foldersById = new Map();
  if (folderIds.length > 0) {
    try {
      const folderRefs = folderIds.map(id => db.doc(`${basePath}/file_folders/${id}`));
      const folderSnaps = await db.getAll(...folderRefs);
      for (const snap of folderSnaps) {
        if (snap.exists) foldersById.set(snap.id, snap.data() || {});
      }
    } catch (err) {
      console.warn('[searchService][debug] Folder validation lookup failed', {
        basePath,
        folderIds,
        error: err.message,
      });
    }
  }

  const kept = [];
  for (const h of hits) {
    const fileData = filesById.get(h.file_id);
    const debugBase = summarizeHitForDebug(h);
    if (!fileData) {
      console.log('[searchService][debug] DROP search hit: file doc missing in requested workspace', {
        basePath,
        ...debugBase,
        expectedDocPath: `${basePath}/files/${h.file_id}`,
      });
      scheduleDeleteIndexedChunks(basePath, h.file_id, 'file_doc_missing');
      continue;
    }

    if (fileData.deleted === true || fileData.isDeleted === true || fileData.trashed === true || fileData.archived === true) {
      console.log('[searchService][debug] DROP search hit: file marked deleted/hidden', {
        basePath,
        ...debugBase,
        deleted: fileData.deleted || null,
        isDeleted: fileData.isDeleted || null,
        trashed: fileData.trashed || null,
        archived: fileData.archived || null,
      });
      scheduleDeleteIndexedChunks(basePath, h.file_id, 'file_marked_deleted_or_hidden');
      continue;
    }

    if (fileData.processingStatus && fileData.processingStatus !== 'completed') {
      console.log('[searchService][debug] DROP search hit: file is not completed', {
        basePath,
        ...debugBase,
        processingStatus: fileData.processingStatus,
      });
      continue;
    }

    const storagePath = fileData.storagePath || '';
    if (!storagePath) {
      console.log('[searchService][debug] DROP search hit: file has no storagePath', {
        basePath,
        ...debugBase,
      });
      scheduleDeleteIndexedChunks(basePath, h.file_id, 'missing_storage_path');
      continue;
    }

    if (storagePath && !storagePath.startsWith(`${basePath}/files/${h.file_id}/`)) {
      console.log('[searchService][debug] DROP search hit: storagePath belongs elsewhere', {
        basePath,
        ...debugBase,
        firestoreStoragePath: storagePath,
        expectedPrefix: `${basePath}/files/${h.file_id}/`,
      });
      scheduleDeleteIndexedChunks(basePath, h.file_id, 'storage_path_wrong_workspace');
      continue;
    }

    if (storageExistsByPath.get(storagePath) === false) {
      console.log('[searchService][debug] DROP search hit: storage object missing', {
        basePath,
        ...debugBase,
        firestoreStoragePath: storagePath,
      });
      scheduleDeleteIndexedChunks(basePath, h.file_id, 'storage_object_missing');
      continue;
    }

    const firestoreName = fileData.name || '';
    const firestoreExt = (fileData.extension || '').toLowerCase();
    const firestoreFolderId = fileData.folderId || 'root';
    const hitName = h.file_name || '';
    const hitExt = (h.file_extension || '').toLowerCase();
    const hitFolderId = h.folder_id || 'root';
    const firestoreFolderPathIds = Array.isArray(fileData.folderPathIds)
      ? fileData.folderPathIds
      : [];
    const hitFolderPathIds = Array.isArray(h.folder_path_ids)
      ? h.folder_path_ids
      : [];
    const folderPathIdsToValidate = Array.from(new Set([
      ...firestoreFolderPathIds,
      ...hitFolderPathIds,
      firestoreFolderId,
      hitFolderId,
    ].filter(id => id && id !== 'root')));

    const missingFolderId = folderPathIdsToValidate.find(id => !foldersById.has(id));
    if (missingFolderId) {
      console.log('[searchService][debug] DROP search hit: folder path missing in workspace', {
        basePath,
        ...debugBase,
        missingFolderId,
        firestoreFolderId,
        hitFolderId,
        firestoreFolderPathIds,
        hitFolderPathIds,
      });
      scheduleDeleteIndexedChunks(basePath, h.file_id, 'folder_path_missing');
      continue;
    }

    const hiddenFolderId = folderPathIdsToValidate.find(id => {
      const folderData = foldersById.get(id) || {};
      return folderData.deleted === true
        || folderData.isDeleted === true
        || folderData.trashed === true
        || folderData.archived === true;
    });
    if (hiddenFolderId) {
      console.log('[searchService][debug] DROP search hit: folder path hidden/deleted', {
        basePath,
        ...debugBase,
        hiddenFolderId,
      });
      scheduleDeleteIndexedChunks(basePath, h.file_id, 'folder_path_hidden_or_deleted');
      continue;
    }

    if (hitName && firestoreName && hitName !== firestoreName) {
      console.log('[searchService][debug] DROP search hit: file name mismatch', {
        basePath,
        ...debugBase,
        hitName,
        firestoreName,
      });
      continue;
    }
    if (hitExt && firestoreExt && hitExt !== firestoreExt) {
      console.log('[searchService][debug] DROP search hit: extension mismatch', {
        basePath,
        ...debugBase,
        hitExt,
        firestoreExt,
      });
      continue;
    }
    if (hitFolderId && firestoreFolderId && hitFolderId !== firestoreFolderId) {
      console.log('[searchService][debug] DROP search hit: folder mismatch', {
        basePath,
        ...debugBase,
        hitFolderId,
        firestoreFolderId,
      });
      continue;
    }

    console.log('[searchService][debug] KEEP search hit: Firestore file matched workspace', {
      basePath,
      ...debugBase,
      firestoreStoragePath: storagePath || null,
      firestoreName,
      firestoreFolderId,
    });
    kept.push(h);
  }

  console.log('[searchService][debug] Firestore validation complete', {
    basePath,
    before: hits.length,
    after: kept.length,
    dropped: hits.length - kept.length,
  });

  return kept;
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

  const filters = [
    'source_type:=cloudfile',
    `base_path:=${escapeFilterValue(basePath)}`,
  ];
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
  const overFetch = Math.min(safeLimit * 5, MAX_LIMIT * 5);
  let legacyIndexFallbackUsed = false;

  // Construct search options for TypeSense hybrid or semantic query
  const searchPayload = {
    collection: collectionName,
    filter_by: filters.join(' && '),
    per_page: overFetch,
    include_fields: 'base_path,cloudfile_id,file_name,file_extension,mime_type,folder_id,folder_path_ids,folder_path_display,chunk_index,chunk_total,page_number,page_span_json,text,metadata_json,schema_version,doc_parties,doc_type,doc_governing_law,doc_change_of_control,doc_metadata_text',
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
    console.log('[searchService][debug] Typesense search request', {
      collectionName,
      basePath,
      query: trimmedQuery,
      mode: isHybrid ? 'hybrid' : 'semantic',
      filter_by: searchPayload.filter_by,
      per_page: searchPayload.per_page,
      note: 'strict base_path filter enabled; run POST /search/reindex for old indexes without base_path',
      min_similarity: safeMinSim,
      requestedLimit: limit,
      safeLimit,
    });
    multiSearchResult = await client.multiSearch.perform({
      searches: [searchPayload],
    });

    const strictHits = (multiSearchResult.results && multiSearchResult.results[0] && multiSearchResult.results[0].hits) || [];
    const hasStrictBasePathFilter = filters.some(f => f.startsWith('base_path:='));
    if (hasStrictBasePathFilter && strictHits.length === 0) {
      const legacyFilters = filters.filter(f => !f.startsWith('base_path:='));
      const legacyPayload = {
        ...searchPayload,
        filter_by: legacyFilters.join(' && '),
      };
      console.warn('[searchService][debug] Strict base_path search returned 0 hits; retrying legacy index candidates', {
        collectionName,
        basePath,
        strictFilter: searchPayload.filter_by,
        legacyFilter: legacyPayload.filter_by,
        query: trimmedQuery,
      });
      multiSearchResult = await client.multiSearch.perform({
        searches: [legacyPayload],
      });
      legacyIndexFallbackUsed = true;
    }
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
  console.log('[searchService][debug] Typesense raw hits', {
    collectionName,
    basePath,
    legacyIndexFallbackUsed,
    rawCount: rawHits.length,
    firstHits: rawHits.slice(0, 5).map(h => {
      const doc = h.document || {};
      return {
        file_id: doc.cloudfile_id || null,
        base_path: doc.base_path || null,
        file_name: doc.file_name || null,
        folder_id: doc.folder_id || null,
        vector_distance: h.vector_distance,
        text_match: h.text_match,
      };
    }),
  });

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
        base_path: doc.base_path || null,
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
    .filter(h => !h.base_path || h.base_path === basePath)
    .filter(h => !requireLexicalGate || h._lexicalRelevance.isRelevant)
    .sort((a, b) => {
      const aRel = a._lexicalRelevance || {};
      const bRel = b._lexicalRelevance || {};
      if (aRel.exactPhrase !== bRel.exactPhrase) return aRel.exactPhrase ? -1 : 1;
      if ((aRel.matchedTokenCount || 0) !== (bRel.matchedTokenCount || 0)) {
        return (bRel.matchedTokenCount || 0) - (aRel.matchedTokenCount || 0);
      }
      return b.similarity - a.similarity;
    });

  console.log('[searchService][debug] Hits after relevance/basePath filters', {
    basePath,
    beforeFirestoreValidation: hits.length,
    firstHits: hits.slice(0, 5).map(summarizeHitForDebug),
  });

  hits = await filterExistingCloudFiles(hits, basePath);
  if (legacyIndexFallbackUsed) {
    scheduleAutoReindexForLegacyIndex(basePath);
  }
  hits = hits
    .slice(0, safeLimit)
    .map(({ _lexicalRelevance, ...hit }) => hit);

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
  if (legacyIndexFallbackUsed) {
    result.warning = 'Using legacy search index without base_path. Background reindex has been queued for this workspace.';
  }
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
