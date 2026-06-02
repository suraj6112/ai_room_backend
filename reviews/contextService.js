const admin = require('firebase-admin');
const { semanticSearch } = require('../searchService');

/**
 * Service for abstracting how context is fetched for extraction.
 * Supports targeted reading via semantic search and neighbor page expansion.
 */
class ContextService {
  /**
   * Builds context by retrieving specific pages for long documents, 
   * or all pages for short documents.
   * 
   * @param {Object} params
   * @param {string} params.fileId - The document to extract from
   * @param {string} params.basePath - Tenant base path
   * @param {string} params.query - The column prompt or intent
   * @param {number} params.maxPages - Max top-k pages to retrieve (default 5)
   * @param {number} params.shortDocThreshold - Documents with fewer pages bypass search (default 15)
   */
  static async buildTargetedContext({ fileId, basePath, query, maxPages = 5, shortDocThreshold = 15 }) {
    const db = admin.firestore();
    const fileDoc = await db.doc(`${basePath}/files/${fileId}`).get();
    
    if (!fileDoc.exists) {
      throw new Error(`File ${fileId} not found`);
    }

    const fileData = fileDoc.data();
    const totalPages = fileData.pageCount || 0;
    
    let targetPageNumbers = new Set();
    let searchMetrics = null;

    // 1. Determine Target Pages
    if (totalPages <= shortDocThreshold) {
      // Short document: fetch everything
      for (let i = 1; i <= totalPages; i++) {
        targetPageNumbers.add(i);
      }
      searchMetrics = { strategy: 'full_document', totalPages };
    } else {
      // Long document: Targeted Semantic Search (RAG)
      const t0 = Date.now();
      
      const searchResult = await semanticSearch({
        query,
        basePath,
        file_ids: [fileId],
        limit: maxPages,
        use_hyde: true, // Generate synonyms/expansion
        group_by_file: false,
        highlight: false
      });

      const retrievedPages = searchResult.results.map(hit => hit.page_number).filter(p => typeof p === 'number');
      
      // Neighbor expansion
      retrievedPages.forEach(p => {
        if (p > 1) targetPageNumbers.add(p - 1); // Previous page
        targetPageNumbers.add(p);                // Retrieved page
        if (p < totalPages) targetPageNumbers.add(p + 1); // Next page
      });

      // Fallback: If search returned 0 results (e.g. index not synced yet)
      if (targetPageNumbers.size === 0) {
        for (let i = 1; i <= Math.min(maxPages, totalPages); i++) {
          targetPageNumbers.add(i);
        }
      }

      // Truncate to a reasonable max context size (e.g., maxPages * 3 neighbors)
      // We sort them so the document flows naturally
      targetPageNumbers = new Set(Array.from(targetPageNumbers).sort((a, b) => a - b));

      searchMetrics = {
        strategy: 'semantic_search',
        query,
        hydeUsed: searchResult.hyde?.used,
        hydeTokens: searchResult.hyde?.used ? searchResult.hyde.outputTokens : 0,
        rawHits: retrievedPages.length,
        retrievedPages,
        expandedPagesCount: targetPageNumbers.size,
        searchTimeMs: Date.now() - t0,
        topScore: searchResult.results[0]?.similarity || 0
      };
    }

    // 2. Fetch Pages from Subcollection
    const pagesArray = Array.from(targetPageNumbers);
    if (pagesArray.length === 0) {
      return { text: '', metrics: searchMetrics };
    }

    // Firestore 'in' queries are limited to 30 elements. Chunk if necessary.
    const pageDocs = [];
    for (let i = 0; i < pagesArray.length; i += 30) {
      const chunk = pagesArray.slice(i, i + 30).map(String);
      const pagesSnap = await db.collection(`${basePath}/files/${fileId}/pages`)
        .where(admin.firestore.FieldPath.documentId(), 'in', chunk)
        .get();
      
      pagesSnap.forEach(doc => {
        pageDocs.push({
          pageNum: parseInt(doc.id, 10),
          markdown_text: doc.data().markdown_text || ''
        });
      });
    }

    // 3. Assemble Markdown Context
    pageDocs.sort((a, b) => a.pageNum - b.pageNum);
    let combinedText = '';
    let totalContextChars = 0;

    for (const pDoc of pageDocs) {
      combinedText += `\n\n--- Page ${pDoc.pageNum} ---\n\n${pDoc.markdown_text}\n`;
      totalContextChars += pDoc.markdown_text.length;
    }

    if (searchMetrics) {
      searchMetrics.contextChars = totalContextChars;
    }

    return {
      text: combinedText,
      metrics: searchMetrics
    };
  }
}

module.exports = ContextService;
