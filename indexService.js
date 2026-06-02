/**
 * CloudFiles RAG indexing — local (file-processor) edition.
 *
 * Ported from functions/fileProcessingService.js so the local file-processor
 * can index extracted markdown into TypeSense without requiring the Cloud
 * Functions pipeline. Same chunk schema, same collection naming, same
 * stable-IDs upsert behavior — drop-in compatible with the deployed Cloud
 * Function.
 *
 * @see docs/design/CONTENT_SEARCH.md
 */

'use strict';

const admin = require('firebase-admin');
const crypto = require('crypto');
const Typesense = require('typesense');
const { chunkPages } = require('./chunker');

const SCHEMA_VERSION = 4;
const TYPESENSE_COLLECTION_PREFIX = 'pdf2md_';

const TYPESENSE_DOC_API_KEY = process.env.TYPESENSE_DOC_API_KEY;
const TYPESENSE_DOC_HOST = process.env.TYPESENSE_DOC_HOST || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

let docTypesenseClient = null;
function getDocTypesenseClient() {
  if (!docTypesenseClient && TYPESENSE_DOC_API_KEY && TYPESENSE_DOC_HOST) {
    docTypesenseClient = new Typesense.Client({
      nodes: [{
        host: TYPESENSE_DOC_HOST,
        port: '443',
        protocol: 'https',
      }],
      apiKey: TYPESENSE_DOC_API_KEY,
      connectionTimeoutSeconds: 10,
    });
  }
  return docTypesenseClient;
}

function getCollectionName(basePath) {
  if (basePath.startsWith('workspaces/')) {
    const workspaceId = basePath.split('/')[1];
    return `${TYPESENSE_COLLECTION_PREFIX}workspaces_${workspaceId}_chunks`;
  } else {
    const userId = basePath.split('/')[1];
    return `${TYPESENSE_COLLECTION_PREFIX}${userId}_chunks`;
  }
}

async function generateEmbeddings(texts) {
  if (!OPENAI_API_KEY) {
    throw new Error('[CloudFiles RAG] OPENAI_API_KEY not configured');
  }
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: texts,
    }),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI embeddings failed: ${response.status} ${err.substring(0, 200)}`);
  }
  const result = await response.json();
  return result.data.map(d => d.embedding);
}

async function generateEmbeddingsWithRetry(texts, attempt = 0) {
  try {
    return await generateEmbeddings(texts);
  } catch (err) {
    const msg = err.message || '';
    const statusMatch = msg.match(/failed:\s*(\d{3})/);
    const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
    const transient = status === 429
      || (status >= 500 && status < 600)
      || /timeout|ECONN|ETIMEDOUT|fetch failed|socket hang up/i.test(msg);
    if (transient && attempt < 5) {
      const delayMs = Math.min(1000 * Math.pow(2, attempt), 30000) + Math.floor(Math.random() * 500);
      console.warn(`[CloudFiles RAG] Embeddings transient error (attempt ${attempt + 1}/5), retrying in ${delayMs}ms: ${msg}`);
      await new Promise(r => setTimeout(r, delayMs));
      return generateEmbeddingsWithRetry(texts, attempt + 1);
    }
    throw err;
  }
}

async function loadPagesForFile(fileId, basePath, fileData) {
  // Scaling fix: Large documents only store a small preview (e.g. 20 pages) on the main document.
  // We must fetch the subcollection if markdownPages is missing or truncated.
  const hasPagesOnMainDoc = fileData && 
    fileData.markdownPages && 
    typeof fileData.markdownPages === 'object' && 
    Object.keys(fileData.markdownPages).length > 0;

  const isCompleteOnMainDoc = hasPagesOnMainDoc && 
    (!fileData.pageCount || Object.keys(fileData.markdownPages).length >= fileData.pageCount);

  if (isCompleteOnMainDoc) {
    return fileData.markdownPages;
  }
  try {
    const db = admin.firestore();
    const snap = await db.collection(`${basePath}/files/${fileId}/pages`).get();
    if (snap.empty) return null;
    const pages = {};
    snap.forEach(doc => {
      const d = doc.data();
      const n = Number.isFinite(d.page_number) ? d.page_number : Number(doc.id);
      if (d.markdown_text && Number.isFinite(n)) pages[String(n)] = d.markdown_text;
    });
    return Object.keys(pages).length > 0 ? pages : null;
  } catch (e) {
    console.warn(`[CloudFiles RAG] Failed to read pages subcollection for ${fileId}:`, e.message);
    return null;
  }
}

function computeFileContentHash(markdownPages) {
  const sorted = Object.entries(markdownPages).sort((a, b) => Number(a[0]) - Number(b[0]));
  const concat = sorted.map(([n, t]) => `==PAGE ${n}==\n${t}`).join('\n\n');
  return crypto.createHash('sha256').update(concat).digest('hex');
}

function parseImportFailures(result) {
  if (Array.isArray(result)) {
    return result.filter(r => r && r.error).map(r => r.error);
  }
  if (typeof result === 'string') {
    return result
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(obj => obj && (obj.success === false || obj.error))
      .map(obj => obj.error || 'unknown');
  }
  return [];
}

async function getFolderPathDisplay(folderId, basePath) {
  if (!folderId) return 'Root';
  const db = admin.firestore();
  const parts = [];
  let fid = folderId;
  let depth = 0;
  while (fid && depth < 50) {
    const folderDoc = await db.doc(`${basePath}/file_folders/${fid}`).get();
    if (!folderDoc.exists) break;
    const data = folderDoc.data();
    if (data.name) parts.unshift(data.name);
    fid = data.parentId || null;
    depth++;
  }
  return parts.length > 0 ? parts.join(' > ') : 'Root';
}

async function recordEmbeddingCost(tokens) {
  if (!tokens || tokens <= 0) return;
  const month = new Date().toISOString().slice(0, 7);
  try {
    const db = admin.firestore();
    await db.doc(`embeddings_usage/${month}`).set({
      tokens: admin.firestore.FieldValue.increment(tokens),
      requests: admin.firestore.FieldValue.increment(1),
      estimated_cost_usd: admin.firestore.FieldValue.increment(tokens * 0.02 / 1_000_000),
      model: 'text-embedding-3-small',
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch (e) {
    console.warn('[CloudFiles RAG] Failed to record embedding cost:', e.message);
  }
}

async function buildFolderPathIds(folderId, basePath) {
  if (!folderId) return ['root'];
  const db = admin.firestore();
  const pathIds = [];
  let currentId = folderId;
  while (currentId) {
    pathIds.unshift(currentId);
    const doc = await db.doc(`${basePath}/file_folders/${currentId}`).get();
    if (!doc.exists) break;
    currentId = doc.data().parentId;
  }
  pathIds.unshift('root');
  return pathIds;
}

const CLOUDFILES_REQUIRED_FIELDS = [
  { name: 'source_type',          type: 'string',   optional: true, facet: true },
  { name: 'base_path',            type: 'string',   optional: true, facet: true },
  { name: 'cloudfile_id',         type: 'string',   optional: true, facet: true },
  { name: 'folder_id',            type: 'string',   optional: true, facet: true },
  { name: 'folder_path_ids',      type: 'string[]', optional: true, facet: true },
  { name: 'file_extension',       type: 'string',   optional: true, facet: true },
  { name: 'chunk_total',          type: 'int32',    optional: true },
  { name: 'file_name',            type: 'string',   optional: true },
  { name: 'folder_path_display',  type: 'string',   optional: true },
  { name: 'mime_type',            type: 'string',   optional: true, facet: true },
  { name: 'language',             type: 'string',   optional: true, facet: true },
  { name: 'schema_version',       type: 'int32',    optional: true, facet: true },
  { name: 'indexed_at_unix',      type: 'int64',    optional: true },
  { name: 'file_updated_at_unix', type: 'int64',    optional: true },
  { name: 'file_content_hash',    type: 'string',   optional: true },
  { name: 'created_by',           type: 'string',   optional: true, facet: true },
  { name: 'doc_parties',          type: 'string[]', optional: true, facet: true },
  { name: 'doc_type',             type: 'string',   optional: true, facet: true },
  { name: 'doc_governing_law',    type: 'string',   optional: true },
  { name: 'doc_change_of_control',type: 'string',   optional: true },
  { name: 'doc_metadata_text',    type: 'string',   optional: true },
];

function buildCollectionSchema(collectionName) {
  return {
    name: collectionName,
    fields: [
      { name: 'id',             type: 'string' },
      { name: 'user_uid',       type: 'string' },
      { name: 'doc_id',         type: 'string',   optional: true },
      { name: 'attachment_id',  type: 'string',   optional: true },
      { name: 'text',           type: 'string' },
      { name: 'page_number',    type: 'int32' },
      { name: 'chunk_index',    type: 'int32' },
      { name: 'token_count',    type: 'int32' },
      { name: 'embedding',      type: 'float[]', num_dim: 1536 },
      { name: 'metadata_json',  type: 'string' },
      { name: 'page_span_json', type: 'string' },
      ...CLOUDFILES_REQUIRED_FIELDS,
    ],
    default_sorting_field: 'chunk_index',
    enable_nested_fields: true,
  };
}

async function ensureCloudFilesSchema(basePath) {
  const client = getDocTypesenseClient();
  if (!client) return;
  const collectionName = getCollectionName(basePath);
  try {
    const collection = await client.collections(collectionName).retrieve();
    const existing = new Set(collection.fields.map(f => f.name));
    for (const fieldDef of CLOUDFILES_REQUIRED_FIELDS) {
      if (existing.has(fieldDef.name)) continue;
      try {
        await client.collections(collectionName).update({ fields: [fieldDef] });
        console.log(`[CloudFiles RAG] Added field "${fieldDef.name}" (${fieldDef.type}) to ${collectionName}`);
      } catch (e) {
        if (!String(e.message || '').includes('already exists')) {
          console.warn(`[CloudFiles RAG] Could not add field ${fieldDef.name}:`, e.message);
        }
      }
    }
  } catch (err) {
    if (err.httpStatus === 404) {
      await client.collections().create(buildCollectionSchema(collectionName));
      console.log(`[CloudFiles RAG] Created TypeSense collection: ${collectionName} (schema v${SCHEMA_VERSION})`);
    } else {
      throw err;
    }
  }
}

/**
 * Index a CloudFile for RAG search.
 *
 * @param {string} fileId
 * @param {string} basePath - 'users/{uid}' or 'workspaces/{wsid}'
 * @param {object} fileData - File document data from Firestore
 * @returns {Promise<{chunksIndexed: number, skipped?: string}>}
 */
async function indexCloudFile(fileId, basePath, fileData) {
  const client = getDocTypesenseClient();
  if (!client) {
    console.warn(`[CloudFiles RAG] TypeSense doc cluster not configured (TYPESENSE_DOC_API_KEY / TYPESENSE_DOC_HOST), skipping index for ${fileId}`);
    return { chunksIndexed: 0, skipped: 'no_typesense' };
  }

  const db = admin.firestore();
  const fileDoc = await db.doc(`${basePath}/files/${fileId}`).get();
  const latestFileData = fileDoc.exists ? fileDoc.data() : fileData;
  const collectionName = getCollectionName(basePath);

  async function deleteExistingChunks(reason) {
    try {
      const deleteResult = await client.collections(collectionName).documents().delete({
        filter_by: `cloudfile_id:=${fileId}`
      });
      console.log(`[CloudFiles RAG] Removed chunks for ${fileId} (${reason}, deleted: ${deleteResult.num_deleted || 0})`);
    } catch (e) {
      if (e.httpStatus !== 404) {
        console.warn(`[CloudFiles RAG] Non-fatal: Could not remove chunks for ${fileId}:`, e.message);
      }
    }
  }

  const storagePath = latestFileData && latestFileData.storagePath;
  if (!storagePath) {
    await deleteExistingChunks('missing_storage_path');
    return { chunksIndexed: 0, skipped: 'missing_storage_path' };
  }

  try {
    const [storageExists] = await admin.storage().bucket().file(storagePath).exists();
    if (!storageExists) {
      await deleteExistingChunks('storage_object_missing');
      return { chunksIndexed: 0, skipped: 'storage_object_missing' };
    }
  } catch (e) {
    console.warn(`[CloudFiles RAG] Could not verify storage object for ${fileId}, continuing:`, e.message);
  }

  const pages = await loadPagesForFile(fileId, basePath, latestFileData);
  if (!pages || Object.keys(pages).length === 0) {
    console.log(`[CloudFiles RAG] No page content for ${fileId}, skipping`);
    return { chunksIndexed: 0, skipped: 'no_pages' };
  }

  const fileContentHash = computeFileContentHash(pages);
  if (latestFileData.fileContentHash === fileContentHash && latestFileData.hasEmbeddings && latestFileData.schemaVersion === SCHEMA_VERSION) {
    console.log(`[CloudFiles RAG] Content and schema version unchanged for ${fileId}, skipping reindex`);
    return { chunksIndexed: 0, skipped: 'unchanged' };
  }

  const folderPathIds = await buildFolderPathIds(latestFileData.folderId, basePath);
  const folderPathDisplay = await getFolderPathDisplay(latestFileData.folderId, basePath);

  const chunks = chunkPages(pages);
  if (chunks.length === 0) {
    console.log(`[CloudFiles RAG] No chunks produced for ${fileId}, skipping`);
    return { chunksIndexed: 0, skipped: 'no_chunks' };
  }

  const embeddings = await generateEmbeddingsWithRetry(chunks.map(c => c.text));

  await ensureCloudFilesSchema(basePath);

  const safeBasePath = basePath.replace(/\//g, '_');
  const nowUnix = Math.floor(Date.now() / 1000);
  const fileUpdatedAtUnix = latestFileData.updatedAt && typeof latestFileData.updatedAt.toMillis === 'function'
    ? Math.floor(latestFileData.updatedAt.toMillis() / 1000)
    : null;

  // Extract metadata denormalization fields (Approach A)
  const profile = latestFileData.documentProfileSummary || {};
  const kf = profile.keyFacts || {};
  const docParties = Array.isArray(kf.parties) ? kf.parties : [];
  const docType = profile.type || 'other';
  const docGoverningLaw = kf.governingLaw || '';
  const docChangeOfControl = kf.changeOfControl || '';

  const metaParts = [];
  if (docParties.length > 0) metaParts.push(docParties.join(', '));
  if (docType) metaParts.push(docType);
  if (docGoverningLaw) metaParts.push(docGoverningLaw);
  if (kf.venue) metaParts.push(kf.venue);
  if (docChangeOfControl) metaParts.push(docChangeOfControl);
  if (kf.assignmentRequiresConsent !== null && kf.assignmentRequiresConsent !== undefined) {
    metaParts.push(`assignmentRequiresConsent:${kf.assignmentRequiresConsent}`);
  }
  if (profile.title) metaParts.push(profile.title);
  if (profile.summary) metaParts.push(profile.summary);
  if (folderPathDisplay) {
    metaParts.push(folderPathDisplay);
    // Replace underscores, hyphens, and slashes with spaces to enable term matching on directories (e.g. folder "Klaviyo" gets tokenized)
    const normalizedFolder = folderPathDisplay.replace(/[_\-\./]/g, ' ');
    if (normalizedFolder !== folderPathDisplay) {
      metaParts.push(normalizedFolder);
    }
  }
  if (latestFileData.name) {
    metaParts.push(latestFileData.name);
    // Replace underscores, hyphens, and dot/extension separators with spaces to enable individual term matching in filenames (e.g. "03_NDA_Mutual" becomes "03 NDA Mutual")
    const normalizedName = latestFileData.name.replace(/[_\-\.]/g, ' ');
    if (normalizedName !== latestFileData.name) {
      metaParts.push(normalizedName);
    }
  }

  // Append entity names from the profile so every chunk is BM25-searchable by
  // company name, person name, product, risk, etc. — without needing to re-embed.
  // Entities are validated by the profile builder before reaching here.
  const profileEntities = Array.isArray(profile.entities) ? profile.entities : [];
  if (profileEntities.length > 0) {
    const entityNames = profileEntities
      .map(e => e.name)
      .filter(Boolean);
    if (entityNames.length > 0) metaParts.push(entityNames.join(', '));
  }

  const docMetadataText = metaParts.join(' | ');

  const documents = chunks.map((chunk, i) => ({
    id: `cf_${safeBasePath}_${fileId}_${i}`,
    user_uid: latestFileData.createdBy || basePath.split('/')[1],
    source_type: 'cloudfile',
    base_path: basePath,
    cloudfile_id: fileId,
    schema_version: SCHEMA_VERSION,
    embedding: embeddings[i],
    text: chunk.text,
    chunk_index: i,
    chunk_total: chunks.length,
    token_count: chunk.token_count,
    page_number: chunk.page_number,
    page_span_json: JSON.stringify(chunk.page_span),
    file_name: latestFileData.name || '',
    file_extension: (latestFileData.extension || '').toLowerCase(),
    mime_type: latestFileData.mimeType || null,
    metadata_json: JSON.stringify({
      file_name: latestFileData.name,
      folder_path_display: folderPathDisplay,
    }),
    folder_id: latestFileData.folderId || 'root',
    folder_path_ids: folderPathIds,
    folder_path_display: folderPathDisplay,
    created_by: latestFileData.createdBy || null,
    indexed_at_unix: nowUnix,
    file_updated_at_unix: fileUpdatedAtUnix,
    file_content_hash: fileContentHash,
    doc_id: '',
    attachment_id: '',
    doc_parties: docParties,
    doc_type: docType,
    doc_governing_law: docGoverningLaw,
    doc_change_of_control: docChangeOfControl,
    doc_metadata_text: docMetadataText,
  }));

  // Apply deduplication fix: Delete existing stale chunks for this cloudfile_id before importing new ones
  try {
    const deleteResult = await client.collections(collectionName).documents().delete({
      filter_by: `cloudfile_id:=${fileId}`
    });
    console.log(`[CloudFiles RAG] Cleared existing stale chunks for ${fileId} (deleted: ${deleteResult.num_deleted || 0})`);
  } catch (e) {
    if (e.httpStatus !== 404) {
      console.warn(`[CloudFiles RAG] Non-fatal: Could not clear existing chunks for ${fileId}:`, e.message);
    }
  }

  const importResult = await client.collections(collectionName).documents().import(
    documents,
    { action: 'upsert' }
  );
  const failures = parseImportFailures(importResult);
  if (failures.length > 0) {
    console.error(`[CloudFiles RAG] ${failures.length}/${chunks.length} chunks failed for ${fileId}:`, failures.slice(0, 3));
  }

  await db.doc(`${basePath}/files/${fileId}`).update({
    hasEmbeddings: true,
    fileContentHash,
    schemaVersion: SCHEMA_VERSION,
    embeddingsUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await recordEmbeddingCost(chunks.reduce((sum, c) => sum + c.token_count, 0));

  const indexed = chunks.length - failures.length;
  const startPage = chunks[0].page_span[0];
  const endPage = chunks[chunks.length - 1].page_span[1];
  console.log(`[CloudFiles RAG] Indexed ${indexed} chunks for ${fileId} (${folderPathDisplay}) — pages ${startPage}–${endPage}`);
  return { chunksIndexed: indexed };
}

module.exports = {
  indexCloudFile,
  getDocTypesenseClient,
  getCollectionName,
  generateEmbeddingsWithRetry,
  ensureCloudFilesSchema,
  SCHEMA_VERSION,
};
