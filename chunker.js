/**
 * Page-aware chunker for CloudFiles RAG indexing.
 *
 * Reads `markdownPages: { "1": "...", "2": "...", ... }` (the per-page Vision
 * output stored on the file doc by the file-processor) and emits chunks built
 * from one page at a time (strict page-boundary policy).
 *
 * Behavior:
 * - **Strict page boundaries**: each page becomes its own chunk (1:1).
 *   Pages are NEVER merged. This ensures page_number on every chunk is exact,
 *   which is required for correct deep-linking and highlight display in the UI.
 * - **Large-page sub-splitting**: if a single page exceeds `maxSize`, it is
 *   sub-split via heading → paragraph → sentence → hard-cut cascade (unchanged).
 *   All sub-chunks reference the same `page_span: [pageNum, pageNum]`.
 * - **Cross-page overlap**: the paragraph-snapped tail of the previous page's
 *   text is prepended to the current page's text. This preserves keyword context
 *   at page seams without merging pages (industry-standard RAG overlap pattern).
 * - Each chunk records `page_number` (always the canonical page) and
 *   `page_span: [pageNum, pageNum]` so search results deep-link to the exact page.
 *
 * @see docs/design/CONTENT_SEARCH.md
 */

'use strict';

const DEFAULT_OPTIONS = {
  targetSize: 6000,  // not used for page-merging anymore; retained for sub-split sizing
  maxSize: 10000,
  minSize: 1500,     // not used for page-merging anymore; retained for legacy callers
  overlap: 600,      // paragraph-snapped chars prepended from the previous page's tail
};

function tokenEstimate(text) {
  return Math.ceil((text || '').length / 4);
}

function sliceOverlapAtParagraphBoundary(text, overlap) {
  if (!text || overlap <= 0) return '';
  if (text.length <= overlap) return text;
  const tail = text.slice(-overlap);
  const paraIdx = tail.indexOf('\n\n');
  if (paraIdx >= 0) return tail.slice(paraIdx + 2);
  const sentMatch = tail.match(/[.!?]\s+/);
  if (sentMatch) return tail.slice(sentMatch.index + sentMatch[0].length);
  return tail;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitByPriority(text, _targetSize, maxSize) {
  const headingSplits = text.split(/(?=\n#{1,3} )/);
  if (headingSplits.length > 1 && headingSplits.every(s => s.length <= maxSize)) {
    return headingSplits;
  }
  const paraParts = text.split(/\n\n+/);
  const paraSplits = paraParts.map((p, i) => (i === 0 ? p : '\n\n' + p));
  if (paraSplits.every(s => s.length <= maxSize)) return paraSplits;
  const sentParts = text.split(/(?<=[.!?])\s+/);
  const sentSplits = sentParts.map((s, i) => (i === 0 ? s : ' ' + s));
  if (sentSplits.every(s => s.length <= maxSize)) return sentSplits;
  const hard = [];
  for (let i = 0; i < text.length; i += maxSize) hard.push(text.slice(i, i + maxSize));
  return hard;
}

function findHardCut(text, maxSize) {
  if (text.length <= maxSize) return text.length;
  const slice = text.slice(0, maxSize);
  const candidates = [
    slice.lastIndexOf('\n\n'),
    slice.lastIndexOf('. '),
    slice.lastIndexOf('\n'),
    slice.lastIndexOf(' '),
  ].filter(i => i > maxSize * 0.7);
  return candidates.length > 0 ? Math.max(...candidates) : maxSize;
}

function subSplitPage(page, opts) {
  const { targetSize, maxSize, baseIndex } = opts;
  const segments = splitByPriority(page.text, targetSize, maxSize);
  const chunks = [];
  let buffer = '';

  const emit = () => {
    const trimmed = buffer.trim();
    if (trimmed.length === 0) return;
    chunks.push({
      text: trimmed,
      chunk_index: baseIndex + chunks.length,
      page_number: page.pageNumber,
      page_span: [page.pageNumber, page.pageNumber],
      token_count: tokenEstimate(trimmed),
    });
    buffer = '';
  };

  for (const seg of segments) {
    if (buffer.length + seg.length > targetSize && buffer.length > 0) {
      emit();
    }
    buffer = buffer ? buffer + seg : seg;
    while (buffer.length > maxSize) {
      const cut = findHardCut(buffer, maxSize);
      const head = buffer.slice(0, cut);
      const tail = buffer.slice(cut);
      buffer = head;
      emit();
      buffer = tail;
    }
  }
  emit();
  return chunks;
}

/**
 * chunkPages — strict page-boundary chunker.
 *
 * Each page is emitted as its own chunk (or set of sub-chunks when oversized).
 * Pages are NEVER merged across boundaries. A paragraph-snapped overlap tail
 * from the PREVIOUS page is prepended to maintain keyword context at seams.
 *
 * @param {Object<string, string>} markdownPages - { "1": "...", "2": "..." }
 * @param {Object} [options] - overrides for DEFAULT_OPTIONS
 * @returns {Array<{text, chunk_index, page_number, page_span, token_count}>}
 */
function chunkPages(markdownPages, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const { targetSize, maxSize, overlap } = opts;

  if (!markdownPages || typeof markdownPages !== 'object') return [];

  const pages = Object.entries(markdownPages)
    .map(([n, text]) => ({
      pageNumber: Number(n),
      text: typeof text === 'string' ? text.trim() : '',
    }))
    .filter(p => Number.isFinite(p.pageNumber) && p.pageNumber > 0 && p.text.length > 0)
    .sort((a, b) => a.pageNumber - b.pageNumber);

  if (pages.length === 0) return [];

  const chunks = [];
  let prevPageText = ''; // tracks the raw text of the previous page for overlap slicing

  for (const page of pages) {
    // Prepend paragraph-snapped overlap from the end of the previous page.
    // This keeps keyword context at page seams without merging page ownership.
    const overlapPrefix = sliceOverlapAtParagraphBoundary(prevPageText, overlap);
    const pageText = overlapPrefix
      ? overlapPrefix + '\n\n' + page.text
      : page.text;

    if (pageText.length > maxSize) {
      // Large page: sub-split, all sub-chunks reference the same page.
      const synthetic = { pageNumber: page.pageNumber, text: pageText };
      const subChunks = subSplitPage(synthetic, { targetSize, maxSize, baseIndex: chunks.length });
      chunks.push(...subChunks);
    } else {
      chunks.push({
        text: pageText,
        chunk_index: chunks.length,
        page_number: page.pageNumber,
        page_span: [page.pageNumber, page.pageNumber],
        token_count: tokenEstimate(pageText),
      });
    }

    prevPageText = page.text; // store raw (no overlap) for next iteration's overlap slicing
  }

  return chunks;
}

module.exports = {
  chunkPages,
  sliceOverlapAtParagraphBoundary,
  splitByPriority,
  subSplitPage,
  findHardCut,
  tokenEstimate,
  escapeRegex,
  DEFAULT_OPTIONS,
};
