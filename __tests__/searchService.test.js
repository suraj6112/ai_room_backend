/**
 * Unit tests for searchService.js
 *
 * Focuses on:
 *   - groupByFile: ranking preservation (first_index ordering)
 *   - groupByFile: similarity is still tracked (best_similarity)
 *   - groupByFile: handles duplicate files across multiple hits
 */

import { describe, it, expect } from 'vitest';

// groupByFile is a pure function — import it directly without mocking.
// (No Firebase or Typesense calls happen in groupByFile.)
const searchService = await import('../searchService.js');
const { groupByFile } = searchService.default || searchService;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeHit(file_id, similarity, extra = {}) {
  return {
    file_id,
    file_name: `${file_id}.pdf`,
    file_extension: 'pdf',
    folder_path_display: extra.folder_path_display || null,
    similarity,
    chunk_index: extra.chunk_index || 0,
    text: extra.text || 'some chunk text',
    page_number: 1,
    page_span: [1, 1],
    ...extra,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// groupByFile
// ─────────────────────────────────────────────────────────────────────────────

describe('groupByFile', () => {
  it('returns groups in first_index order, NOT similarity order', () => {
    // Hit list returned by Typesense hybrid search:
    //   Position 0 → file_b (similarity 0.75) — ranked first by Typesense (BM25 + vector)
    //   Position 1 → file_a (similarity 0.90) — higher similarity but ranked second by Typesense
    const hits = [
      makeHit('file_b', 0.75),
      makeHit('file_a', 0.90),
    ];
    const groups = groupByFile(hits);

    // Before fix: sorted by best_similarity → file_a would come first (wrong).
    // After fix:  sorted by first_index   → file_b comes first (correct).
    expect(groups).toHaveLength(2);
    expect(groups[0].file_id).toBe('file_b');
    expect(groups[1].file_id).toBe('file_a');
  });

  it('correctly accumulates match_count and best_similarity for repeated file hits', () => {
    const hits = [
      makeHit('file_a', 0.80, { chunk_index: 0 }),
      makeHit('file_b', 0.70, { chunk_index: 0 }),
      makeHit('file_a', 0.95, { chunk_index: 1 }), // second hit for file_a; higher similarity
    ];
    const groups = groupByFile(hits);

    // file_a appeared at index 0 (first_index=0), so it leads.
    expect(groups[0].file_id).toBe('file_a');
    expect(groups[0].match_count).toBe(2);
    expect(groups[0].best_similarity).toBeCloseTo(0.95);

    expect(groups[1].file_id).toBe('file_b');
    expect(groups[1].match_count).toBe(1);
  });

  it('collects at most 3 snippets per file group', () => {
    const hits = [
      makeHit('file_a', 0.9, { chunk_index: 0 }),
      makeHit('file_a', 0.8, { chunk_index: 1 }),
      makeHit('file_a', 0.7, { chunk_index: 2 }),
      makeHit('file_a', 0.6, { chunk_index: 3 }), // 4th hit — should NOT appear in snippets
    ];
    const groups = groupByFile(hits);
    expect(groups).toHaveLength(1);
    expect(groups[0].snippets).toHaveLength(3);
    expect(groups[0].match_count).toBe(4);
  });

  it('handles an empty hits array', () => {
    expect(groupByFile([])).toEqual([]);
  });

  it('handles hits with null file_id gracefully', () => {
    const hits = [makeHit(null, 0.8)];
    const groups = groupByFile(hits);
    expect(groups).toHaveLength(1);
    // file_id will be null; group should still exist with match_count 1
    expect(groups[0].match_count).toBe(1);
  });

  it('preserves folder_path_display on the group', () => {
    const hits = [makeHit('file_c', 0.8, { folder_path_display: 'Customer Contracts / Microsoft' })];
    const groups = groupByFile(hits);
    expect(groups[0].folder_path_display).toBe('Customer Contracts / Microsoft');
  });

  it('three-file scenario: first_index ordering matches Typesense hybrid rank', () => {
    // Simulate a query for "Klaviyo NDA" where:
    //   - Klaviyo folder doc appears at position 0 (highest BM25 rank)
    //   - Test folder doc appears at position 1
    //   - Unrelated doc appears at position 2 (also high similarity but wrong folder)
    const hits = [
      makeHit('klaviyo_doc', 0.72, { folder_path_display: 'Klaviyo' }),
      makeHit('test_doc',    0.88, { folder_path_display: 'Test' }),
      makeHit('other_doc',   0.91, { folder_path_display: 'Other' }),
    ];
    const groups = groupByFile(hits);

    // Groups must be in first_index order, not similarity order.
    expect(groups.map(g => g.file_id)).toEqual(['klaviyo_doc', 'test_doc', 'other_doc']);
    // Verify similarities are correct despite ordering.
    expect(groups[0].best_similarity).toBeCloseTo(0.72);
    expect(groups[2].best_similarity).toBeCloseTo(0.91);
  });
});
