/**
 * Layering guard: no core file may import from `reviews/`.
 *
 * The Tabular Review feature lives entirely under
 * `microservices/file-processor/reviews/` and depends on core (search,
 * profile, indexing, etc.) — but core must not depend on reviews. This
 * test enforces that boundary at CI time so accidental coupling can't
 * sneak in.
 *
 * The single allowed bridge is `server.js`, which intentionally mounts
 * review-specific HTTP routes by importing review handlers. That file is
 * whitelisted below.
 *
 * See: microservices/file-processor/reviews/README.md
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const FILE_PROCESSOR_DIR = join(__dirname, '..');
const REVIEWS_DIR = join(FILE_PROCESSOR_DIR, 'reviews');

// server.js is the documented bridge — it mounts /extract and the future
// /api/v1/reviews/* routes by importing from reviews/. No other file may.
const ALLOWED_BRIDGES = new Set(['server.js']);

// Walk the file-processor tree and collect every .js file outside reviews/
// and outside node_modules / __tests__.
function collectCoreSourceFiles(dir, accumulator = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === 'node_modules' || entry === '__tests__' || entry === 'reviews' || entry === 'storage') continue;
    const st = statSync(full);
    if (st.isDirectory()) {
      collectCoreSourceFiles(full, accumulator);
    } else if (entry.endsWith('.js')) {
      accumulator.push(full);
    }
  }
  return accumulator;
}

describe('reviews / core abstraction boundary', () => {
  it('no core source file imports from reviews/ (except the documented bridge in server.js)', () => {
    const offenders = [];
    const files = collectCoreSourceFiles(FILE_PROCESSOR_DIR);

    for (const file of files) {
      const relative = file.substring(FILE_PROCESSOR_DIR.length + 1);
      const source = readFileSync(file, 'utf8');
      // Match require('./reviews...') or require('./reviews/...') variations.
      const importMatches = source.match(/require\s*\(\s*['"]\.\/reviews(?:\/[^'"]*)?['"]/g);
      if (!importMatches) continue;
      if (ALLOWED_BRIDGES.has(relative)) continue;
      offenders.push({ file: relative, imports: importMatches });
    }

    if (offenders.length) {
      const detail = offenders
        .map(o => `  ${o.file}: ${o.imports.join(', ')}`)
        .join('\n');
      throw new Error(
        `Core files imported from reviews/. The Tabular Review feature must stay a leaf:\n${detail}`
      );
    }
    expect(offenders).toEqual([]);
  });

  it('reviews/ exists and contains extractionPrompts.js', () => {
    const entries = readdirSync(REVIEWS_DIR);
    expect(entries).toContain('extractionPrompts.js');
    expect(entries).toContain('README.md');
  });
});
