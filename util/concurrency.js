/**
 * Generic concurrency primitive. Bounded parallelism over a list of items,
 * each processed by an async worker. Items are dispatched in lane-pull order
 * (no Promise.all-style burst), so back-pressure on slow workers naturally
 * spreads the load.
 *
 * Used today by /extract-batch (reviews) but lives in core util because it's
 * domain-agnostic — any other concurrent-work path in the file-processor
 * (search batch, indexing fan-out, etc.) can pull from here without dragging
 * a review-only module in.
 */

'use strict';

/**
 * Run an async worker over `items` with at most `concurrency` lanes in
 * flight. Preserves input order in the result array.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function pump() {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }

  const lanes = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: lanes }, () => pump()));
  return results;
}

module.exports = { runWithConcurrency };
