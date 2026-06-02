const { semanticSearch } = require('../../searchService');
const admin = require('firebase-admin');

const wrapPromptSafety = (text) => {
  return `<search_result>\n${text}\n</search_result>`;
};

/**
 * Semantic search across the workspace
 * POST /api/v1/search
 */
exports.searchChunks = async (req, res, next) => {
  try {
    const { basePath, uid } = req.identity;
    const { query, limit = 10, use_hyde = false, folder_paths } = req.body;

    if (!query || typeof query !== 'string') {
      return next({ status: 400, code: 'invalid_request', message: 'Missing or invalid query' });
    }

    const searchResult = await semanticSearch({
      uid,
      basePath,
      query,
      topK: limit,
      folderPaths: folder_paths,
      useHyde: use_hyde,
      highlight: true
    });

    const safeResults = searchResult.results.map(hit => ({
      ...hit,
      text: wrapPromptSafety(hit.text)
    }));

    res.json({
      success: true,
      data: {
        results: safeResults,
        count: searchResult.count
      },
      provenance: 'llm', // HyDE involves LLM, embeddings do too
      citations: safeResults.map(hit => `/files/${hit.file_id}?page=${hit.page_number}`),
      metadata: {
        latency_ms: searchResult.timing_ms.total,
        partial: false
      }
    });

  } catch (err) {
    next(err);
  }
};

/**
 * Expand context around a specific chunk search hit
 * POST /api/v1/retrieve
 * Body: { file_id, page_number }
 */
exports.retrieveChunks = async (req, res, next) => {
  try {
    const { basePath } = req.identity;
    const { file_id, page_number } = req.body;

    if (!file_id || !page_number) {
      return next({ status: 400, code: 'invalid_request', message: 'Missing file_id or page_number' });
    }

    const db = admin.firestore();
    const pageDoc = await db.doc(`${basePath}/files/${file_id}/pages/${page_number}`).get();

    if (!pageDoc.exists) {
      return next({ status: 404, code: 'not_found', message: 'Page not found' });
    }

    const text = pageDoc.data().markdown_text || '';

    res.json({
      success: true,
      data: {
        file_id,
        page_number,
        text: wrapPromptSafety(text)
      },
      provenance: 'database',
      citations: [`/files/${file_id}?page=${page_number}`],
      metadata: {}
    });

  } catch (err) {
    next(err);
  }
};
