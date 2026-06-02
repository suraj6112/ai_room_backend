/**
 * Unit tests for profile.js — the document profile builder.
 *
 * Anthropic is mocked via injected client. Firestore is mocked via injected `db`.
 * Tests focus on:
 *   - prompt construction (page anchors, truncation)
 *   - response parsing (clean JSON, code-fenced JSON, malformed)
 *   - shape validation (missing fields, type errors)
 *   - heading + keyFacts + bundleHints + summarySources pointer validation
 *   - end-to-end buildDocumentProfile happy path
 *   - end-to-end buildAndStoreProfile failure path (marks profile failed)
 */

import { describe, it, expect, vi } from 'vitest';

// Mock firebase-admin BEFORE importing profile.js (which imports it).
vi.mock('firebase-admin', () => {
  const fieldValueSentinel = { __sentinel: 'serverTimestamp' };
  return {
    default: {
      firestore: Object.assign(
        () => ({}), // admin.firestore() returns an empty mock — tests pass `db` directly
        {
          FieldValue: { serverTimestamp: () => fieldValueSentinel }
        }
      ),
      initializeApp: () => {}
    }
  };
});

const profile = await import('../profile.js');
const {
  buildProfilePrompt,
  buildProfilePromptChunked,
  chunkPagesByCharLimit,
  parseProfileResponse,
  validateProfileShape,
  validateProfileHeadings,
  buildSummary,
  buildDocumentProfile,
  buildAndStoreProfile,
  PROFILE_VERSION,
  PROFILE_MODEL,
  MAX_INPUT_CHARS,
  MAX_SINGLE_PASS_CHARS,
  VALID_DOC_TYPES,
  VALID_COC,
  VALID_ENTITY_CATEGORIES
} = profile.default || profile;

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function validProfileFixture(overrides = {}) {
  return {
    type: 'frame_contract',
    typeConfidence: 'high',
    title: 'Master Services Agreement',
    summary: 'Five-year MSA between Acme and GIGA covering services.',
    summarySources: [{ page: 1, quote: 'This Master Services Agreement' }],
    headings: [
      {
        id: 'h1',
        level: 1,
        text: 'Definitions',
        page: 2,
        pageEnd: 4,
        summaryBullets: ['Defines Services', 'Defines Order Form'],
        children: []
      }
    ],
    keyFacts: {
      parties: ['Acme Corp', 'GIGA GmbH'],
      partiesSource: { page: 1, quote: 'between Acme Corp and GIGA' },
      effectiveDate: '2023-07-01',
      effectiveDateSource: { page: 1, quote: 'effective July 1, 2023' },
      term: { initial: '5 years', renewal: '1y auto-renewal', notice: '90 days' },
      termSource: { page: 5, quote: 'initial term of five (5) years' },
      governingLaw: 'Delaware, USA',
      governingLawSource: { page: 27, quote: 'governed by the laws of the State of Delaware' },
      venue: null,
      venueSource: null,
      changeOfControl: 'consent_required',
      changeOfControlSource: { page: 17, quote: 'consent of the other party' },
      assignmentRequiresConsent: true,
      assignmentSource: { page: 17, quote: 'No assignment without consent' }
    },
    entities: [
      {
        name: 'Acme Corp',
        category: 'company_org',
        description: 'Primary contracting party and service recipient.',
        source: { page: 1, quote: 'between Acme Corp and GIGA' }
      },
      {
        name: 'GIGA GmbH',
        category: 'company_org',
        description: 'Service provider under the agreement.',
        source: { page: 1, quote: 'This Master Services Agreement' }
      }
    ],
    bundleHints: [
      { kind: 'references', text: 'each Order Form executed under this Agreement', page: 4 }
    ],
    openQuestions: [],
    ...overrides
  };
}

const PAGES_FIXTURE = {
  '1': 'This Master Services Agreement is between Acme Corp and GIGA GmbH effective July 1, 2023.',
  '2': '## Definitions\n\nIn this Agreement, "Services" means consulting work.',
  '4': '## Order Forms\n\nEach Order Form executed under this Agreement details a specific engagement.',
  '5': 'Term: initial term of five (5) years commences on the Effective Date.',
  '17': '## Change of Control. No assignment without consent of the other party. Consent shall not be unreasonably withheld.',
  '27': 'This Agreement is governed by the laws of the State of Delaware.'
};

// ────────────────────────────────────────────────────────────────────────
// buildProfilePrompt
// ────────────────────────────────────────────────────────────────────────

describe('buildProfilePrompt', () => {
  it('emits one ## Page N anchor per page in numeric order', () => {
    const md = { '3': 'third', '1': 'first', '2': 'second' };
    const { prompt, includedPages } = buildProfilePrompt({ fileName: 'test.pdf', folderPath: null, markdownPages: md });
    expect(includedPages).toEqual([1, 2, 3]);
    const idx1 = prompt.indexOf('## Page 1');
    const idx2 = prompt.indexOf('## Page 2');
    const idx3 = prompt.indexOf('## Page 3');
    expect(idx1).toBeGreaterThan(-1);
    expect(idx2).toBeGreaterThan(idx1);
    expect(idx3).toBeGreaterThan(idx2);
  });

  it('includes the file name AND folder path', () => {
    const { prompt } = buildProfilePrompt({
      fileName: 'Acme MSA.pdf',
      folderPath: 'Customer Contracts / Acme',
      markdownPages: { '1': 'x' }
    });
    expect(prompt).toContain('Acme MSA.pdf');
    expect(prompt).toContain('Customer Contracts / Acme');
  });

  it('shows (root) when folderPath is null', () => {
    const { prompt } = buildProfilePrompt({ fileName: 'x.pdf', folderPath: null, markdownPages: { '1': 'x' } });
    expect(prompt).toContain('(root)');
  });

  it('truncates at the single-pass cap and reports it', () => {
    const small = 'x'.repeat(100);
    const huge = 'y'.repeat(MAX_INPUT_CHARS);
    const md = { '1': small, '2': huge };
    const { truncated, includedPages } = buildProfilePrompt({ fileName: 'big.pdf', folderPath: null, markdownPages: md });
    expect(truncated).toBe(true);
    expect(includedPages).toEqual([1]);
  });

  it('handles empty pages map', () => {
    const { prompt, includedPages } = buildProfilePrompt({ fileName: 'empty.pdf', folderPath: null, markdownPages: {} });
    expect(includedPages).toEqual([]);
    expect(prompt).toContain('Total pages in the document: 0');
  });

  it('mentions the JSON-only output requirement', () => {
    const { prompt } = buildProfilePrompt({ fileName: 'x.pdf', folderPath: null, markdownPages: { '1': 'a' } });
    expect(prompt).toMatch(/JSON ONLY/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// parseProfileResponse
// ────────────────────────────────────────────────────────────────────────

describe('parseProfileResponse', () => {
  it('parses clean JSON', () => {
    const r = parseProfileResponse({
      content: [{ type: 'text', text: '{"type":"cim","title":"T"}' }]
    });
    expect(r.ok).toBe(true);
    expect(r.parsed.type).toBe('cim');
  });

  it('strips ```json code fences', () => {
    const r = parseProfileResponse({
      content: [{ type: 'text', text: '```json\n{"a":1}\n```' }]
    });
    expect(r.ok).toBe(true);
    expect(r.parsed.a).toBe(1);
  });

  it('strips bare ``` code fences', () => {
    const r = parseProfileResponse({
      content: [{ type: 'text', text: '```\n{"a":2}\n```' }]
    });
    expect(r.ok).toBe(true);
    expect(r.parsed.a).toBe(2);
  });

  it('joins multiple text blocks', () => {
    const r = parseProfileResponse({
      content: [
        { type: 'text', text: '{"a":' },
        { type: 'text', text: '3}' }
      ]
    });
    expect(r.ok).toBe(true);
    expect(r.parsed.a).toBe(3);
  });

  it('returns error on empty content', () => {
    const r = parseProfileResponse({ content: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no text/);
  });

  it('returns error on malformed JSON', () => {
    const r = parseProfileResponse({ content: [{ type: 'text', text: '{not json}' }] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/parse failed/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// validateProfileShape
// ────────────────────────────────────────────────────────────────────────

describe('validateProfileShape', () => {
  it('accepts the valid fixture', () => {
    const r = validateProfileShape(validProfileFixture());
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('rejects unknown type', () => {
    const r = validateProfileShape(validProfileFixture({ type: 'banana' }));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('type must be'))).toBe(true);
  });

  it('rejects unknown typeConfidence', () => {
    const r = validateProfileShape(validProfileFixture({ typeConfidence: 'maybe' }));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('typeConfidence must be'))).toBe(true);
  });

  it('rejects non-array headings', () => {
    const r = validateProfileShape(validProfileFixture({ headings: 'nope' }));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('headings must be an array'))).toBe(true);
  });

  it('catches bad heading level', () => {
    const r = validateProfileShape(validProfileFixture({
      headings: [{ id: 'h1', level: 4, text: 'X', page: 1, pageEnd: null, summaryBullets: [], children: [] }]
    }));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('level must be 1 | 2 | 3'))).toBe(true);
  });

  it('catches bad nested children', () => {
    const r = validateProfileShape(validProfileFixture({
      headings: [{
        id: 'h1', level: 1, text: 'X', page: 1, pageEnd: null, summaryBullets: [],
        children: [{ id: '', level: 2, text: 'Y', page: 1, pageEnd: null, summaryBullets: [], children: [] }]
      }]
    }));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('children[0].id'))).toBe(true);
  });

  it('rejects unknown changeOfControl value', () => {
    const r = validateProfileShape(validProfileFixture({
      keyFacts: { ...validProfileFixture().keyFacts, changeOfControl: 'whatever' }
    }));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('changeOfControl must be'))).toBe(true);
  });

  it('rejects non-boolean assignmentRequiresConsent', () => {
    const r = validateProfileShape(validProfileFixture({
      keyFacts: { ...validProfileFixture().keyFacts, assignmentRequiresConsent: 'yes' }
    }));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('assignmentRequiresConsent must be boolean'))).toBe(true);
  });

  it('requires source object when keyFacts value is non-null', () => {
    const fix = validProfileFixture();
    fix.keyFacts.partiesSource = null;
    const r = validateProfileShape(fix);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('partiesSource'))).toBe(true);
  });

  it('allows nulls when value is null', () => {
    const fix = validProfileFixture();
    fix.keyFacts.venue = null;
    fix.keyFacts.venueSource = null;
    const r = validateProfileShape(fix);
    expect(r.ok).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────
// validateProfileHeadings
// ────────────────────────────────────────────────────────────────────────

describe('validateProfileHeadings', () => {
  it('keeps headings whose text appears on the cited page', () => {
    const profile = validProfileFixture();
    const r = validateProfileHeadings(profile, PAGES_FIXTURE);
    expect(r.profile.headings).toHaveLength(1);
    expect(r.droppedHeadings).toBe(0);
  });

  it('drops headings whose text is not on the cited page', () => {
    const profile = validProfileFixture({
      headings: [
        { id: 'h1', level: 1, text: 'Inventions and IP', page: 2, pageEnd: 4, summaryBullets: [], children: [] }
      ]
    });
    const r = validateProfileHeadings(profile, PAGES_FIXTURE);
    expect(r.profile.headings).toHaveLength(0);
    expect(r.droppedHeadings).toBe(1);
  });

  it('drops bad nested children but keeps good ones', () => {
    const profile = validProfileFixture({
      headings: [
        {
          id: 'h1', level: 1, text: 'Definitions', page: 2, pageEnd: 4, summaryBullets: [],
          children: [
            { id: 'h1.1', level: 2, text: 'Bogus Heading', page: 2, pageEnd: null, summaryBullets: [], children: [] },
            { id: 'h1.2', level: 2, text: 'Services', page: 2, pageEnd: null, summaryBullets: [], children: [] }
          ]
        }
      ]
    });
    const r = validateProfileHeadings(profile, PAGES_FIXTURE);
    expect(r.profile.headings).toHaveLength(1);
    expect(r.profile.headings[0].children).toHaveLength(1);
    expect(r.profile.headings[0].children[0].id).toBe('h1.2');
    expect(r.droppedHeadings).toBe(1);
  });

  it('drops keyFacts whose source quote does not match', () => {
    const profile = validProfileFixture();
    profile.keyFacts.governingLawSource = { page: 27, quote: 'governed by the laws of Mars and Pluto' };
    const r = validateProfileHeadings(profile, PAGES_FIXTURE);
    expect(r.profile.keyFacts.governingLaw).toBeNull();
    expect(r.profile.keyFacts.governingLawSource).toBeNull();
    expect(r.droppedKeyFacts).toContain('governingLaw');
  });

  it('keeps keyFacts whose source quote matches with whitespace tolerance', () => {
    const profile = validProfileFixture();
    profile.keyFacts.governingLawSource = { page: 27, quote: 'governed   by   the\n  laws of the State of Delaware' };
    const r = validateProfileHeadings(profile, PAGES_FIXTURE);
    expect(r.profile.keyFacts.governingLaw).toBe('Delaware, USA');
    expect(r.droppedKeyFacts).not.toContain('governingLaw');
  });

  it('drops bundleHints whose quote does not match', () => {
    const profile = validProfileFixture({
      bundleHints: [
        { kind: 'references', text: 'NOT IN ANY PAGE WHATSOEVER', page: 1 },
        { kind: 'references', text: 'Master Services Agreement', page: 1 }
      ]
    });
    const r = validateProfileHeadings(profile, PAGES_FIXTURE);
    expect(r.profile.bundleHints).toHaveLength(1);
    expect(r.profile.bundleHints[0].text).toContain('Master Services Agreement');
    expect(r.droppedBundleHints).toBe(1);
  });

  it('drops summarySources whose quote does not match', () => {
    const profile = validProfileFixture({
      summarySources: [
        { page: 1, quote: 'NOT FOUND ON THIS PAGE EITHER' },
        { page: 1, quote: 'Master Services Agreement' }
      ]
    });
    const r = validateProfileHeadings(profile, PAGES_FIXTURE);
    expect(r.profile.summarySources).toHaveLength(1);
    expect(r.droppedSummarySources).toBe(1);
  });

  it('handles non-existent page references gracefully', () => {
    const profile = validProfileFixture({
      headings: [
        { id: 'h1', level: 1, text: 'Definitions', page: 99, pageEnd: null, summaryBullets: [], children: [] }
      ]
    });
    const r = validateProfileHeadings(profile, PAGES_FIXTURE);
    expect(r.profile.headings).toHaveLength(0);
    expect(r.droppedHeadings).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────────
// buildSummary
// ────────────────────────────────────────────────────────────────────────

describe('buildSummary', () => {
  it('mirrors only structured filterable fields', () => {
    const p = validProfileFixture();
    const s = buildSummary(p);
    expect(s.status).toBe('completed');
    expect(s.hasProfile).toBe(true);
    expect(s.type).toBe(p.type);
    expect(s.title).toBe(p.title);
    expect(s.keyFacts.parties).toEqual(p.keyFacts.parties);
    expect(s.keyFacts.governingLaw).toBe(p.keyFacts.governingLaw);
    expect(s.keyFacts.changeOfControl).toBe(p.keyFacts.changeOfControl);
    expect(s.keyFacts.assignmentRequiresConsent).toBe(true);
    expect(s.keyFacts.term).toBeUndefined();
    expect(s.headings).toBeUndefined();
    expect(s.bundleHints).toBeUndefined();
  });

  it('preserves nulls for missing fields', () => {
    const p = validProfileFixture();
    p.keyFacts.governingLaw = null;
    p.keyFacts.governingLawSource = null;
    p.keyFacts.assignmentRequiresConsent = null;
    p.keyFacts.assignmentSource = null;
    const s = buildSummary(p);
    expect(s.keyFacts.governingLaw).toBeNull();
    expect(s.keyFacts.assignmentRequiresConsent).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────
// buildDocumentProfile — end-to-end
// ────────────────────────────────────────────────────────────────────────

describe('buildDocumentProfile (end-to-end with mock client)', () => {
  function mockClient(returnedProfile) {
    return {
      messages: {
        create: async () => ({
          content: [{ type: 'text', text: JSON.stringify(returnedProfile) }],
          usage: { input_tokens: 10000, output_tokens: 500 }
        })
      }
    };
  }

  it('produces a profile with version + meta on the happy path', async () => {
    const valid = validProfileFixture();
    const { profile, meta } = await buildDocumentProfile({
      fileName: 'msa.pdf',
      markdownPages: PAGES_FIXTURE,
      contentHash: 'sha-abc',
      anthropicOverride: mockClient(valid)
    });
    expect(profile.version).toBe(PROFILE_VERSION);
    expect(profile.producedByModel).toBe(PROFILE_MODEL);
    expect(profile.producedFromContentHash).toBe('sha-abc');
    expect(profile.type).toBe('frame_contract');
    expect(meta.callDurationMs).toBeGreaterThanOrEqual(0);
    expect(meta.inputPageCount).toBe(6);
    expect(meta.inputTruncated).toBe(false);
    expect(meta.inputTokens).toBe(10000);
    expect(meta.outputTokens).toBe(500);
  });

  it('throws on shape-validation failure', async () => {
    const bad = { ...validProfileFixture(), type: 'banana' };
    await expect(
      buildDocumentProfile({
        fileName: 'msa.pdf',
        markdownPages: PAGES_FIXTURE,
        anthropicOverride: mockClient(bad)
      })
    ).rejects.toThrow(/shape validation/);
  });

  it('throws on unparseable response', async () => {
    const client = { messages: { create: async () => ({ content: [{ type: 'text', text: 'not json' }] }) } };
    await expect(
      buildDocumentProfile({ fileName: 'x', markdownPages: PAGES_FIXTURE, anthropicOverride: client })
    ).rejects.toThrow(/parse failed/);
  });

  it('throws when markdownPages is empty', async () => {
    await expect(
      buildDocumentProfile({ fileName: 'x', markdownPages: {}, anthropicOverride: mockClient(validProfileFixture()) })
    ).rejects.toThrow(/no usable pages/);
  });

  it('drops bad pointers but keeps the profile', async () => {
    const fix = validProfileFixture();
    fix.headings.push({ id: 'h2', level: 1, text: 'Bogus heading not in any page', page: 2, pageEnd: null, summaryBullets: [], children: [] });
    fix.keyFacts.venue = 'Mars';
    fix.keyFacts.venueSource = { page: 27, quote: 'NOT IN PAGE EITHER' };
    const { profile } = await buildDocumentProfile({
      fileName: 'x',
      markdownPages: PAGES_FIXTURE,
      anthropicOverride: mockClient(fix)
    });
    expect(profile.headings).toHaveLength(1);
    expect(profile.keyFacts.venue).toBeNull();
    expect(profile.keyFacts.governingLaw).toBe('Delaware, USA');
  });
});

// ────────────────────────────────────────────────────────────────────────
// buildAndStoreProfile — failure path
// ────────────────────────────────────────────────────────────────────────

describe('buildAndStoreProfile', () => {
  function makeMockDb() {
    const writes = [];
    return {
      writes,
      doc: (path) => ({
        path,
        update: async (data) => writes.push({ op: 'update', path, data })
      }),
      batch: () => ({
        set: (ref, data) => writes.push({ op: 'set', path: ref.path, data }),
        update: (ref, data) => writes.push({ op: 'update', path: ref.path, data }),
        commit: async () => {}
      })
    };
  }

  it('marks documentProfileSummary failed on Anthropic error and does not throw', async () => {
    const failing = { messages: { create: async () => { throw new Error('rate limited'); } } };
    const db = makeMockDb();
    const result = await buildAndStoreProfile({
      basePath: 'users/u1',
      fileId: 'f1',
      fileName: 'x.pdf',
      markdownPages: { '1': 'hello' },
      db,
      anthropicOverride: failing
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/rate limited/);
    const failureWrite = db.writes.find(w => w.op === 'update' && w.path === 'users/u1/files/f1');
    expect(failureWrite).toBeDefined();
    expect(failureWrite.data.documentProfileSummary.status).toBe('failed');
    expect(failureWrite.data.documentProfileSummary.hasProfile).toBe(false);
  });

  it('writes the profile + summary on success', async () => {
    const valid = validProfileFixture();
    const client = {
      messages: {
        create: async () => ({
          content: [{ type: 'text', text: JSON.stringify(valid) }],
          usage: {}
        })
      }
    };
    const db = makeMockDb();
    const result = await buildAndStoreProfile({
      basePath: 'users/u1',
      fileId: 'f1',
      fileName: 'x.pdf',
      markdownPages: PAGES_FIXTURE,
      db,
      anthropicOverride: client
    });
    expect(result.ok).toBe(true);
    const profileWrite = db.writes.find(w => w.op === 'set' && w.path === 'users/u1/files/f1/profile/profile_v1');
    const summaryWrite = db.writes.find(w => w.op === 'update' && w.path === 'users/u1/files/f1');
    expect(profileWrite).toBeDefined();
    expect(profileWrite.data.type).toBe('frame_contract');
    expect(summaryWrite).toBeDefined();
    expect(summaryWrite.data.documentProfileSummary.status).toBe('completed');
    expect(summaryWrite.data.documentProfileSummary.keyFacts.governingLaw).toBe('Delaware, USA');
  });
});

// ────────────────────────────────────────────────────────────────────────
// Smoke
// ────────────────────────────────────────────────────────────────────────

describe('module constants', () => {
  it('exports expected types', () => {
    expect(VALID_DOC_TYPES).toContain('frame_contract');
    expect(VALID_DOC_TYPES).toContain('cim');
    expect(VALID_COC).toEqual(['consent_required', 'termination_right', 'notice_only', 'silent']);
    expect(MAX_INPUT_CHARS).toBeGreaterThan(0);
    expect(MAX_SINGLE_PASS_CHARS).toBe(MAX_INPUT_CHARS);
    // Specific assertion that profile uses Sonnet 4.6, not 4.5 — guards against the silent-fallback bug.
    expect(PROFILE_MODEL).toBe('claude-sonnet-4-6');
  });
});

// ────────────────────────────────────────────────────────────────────────
// chunkPagesByCharLimit
// ────────────────────────────────────────────────────────────────────────

describe('chunkPagesByCharLimit', () => {
  it('returns one chunk when all pages fit', () => {
    const md = { '1': 'a'.repeat(100), '2': 'b'.repeat(100) };
    const chunks = chunkPagesByCharLimit(md, 1000);
    expect(chunks).toHaveLength(1);
    expect(Object.keys(chunks[0]).sort()).toEqual(['1', '2']);
  });

  it('splits on page boundaries when exceeding the limit', () => {
    const md = { '1': 'a'.repeat(400), '2': 'b'.repeat(400), '3': 'c'.repeat(400) };
    const chunks = chunkPagesByCharLimit(md, 600);
    // Each page (400 chars + 64 overhead = 464) fits alone but 2 pages = 928 > 600.
    expect(chunks.length).toBeGreaterThan(1);
    // Pages are in order across chunks
    const flatPages = chunks.flatMap(c => Object.keys(c)).map(Number);
    expect(flatPages).toEqual([1, 2, 3]);
  });

  it('places a single oversized page alone in its own chunk', () => {
    const md = { '1': 'a'.repeat(50), '2': 'b'.repeat(2000), '3': 'c'.repeat(50) };
    const chunks = chunkPagesByCharLimit(md, 500);
    // Page 1 fits in chunk 1; page 2 alone in chunk 2; page 3 alone (or in chunk 3).
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const flatPages = chunks.flatMap(c => Object.keys(c)).map(Number);
    expect(flatPages).toEqual([1, 2, 3]);
  });

  it('returns empty array for empty input', () => {
    expect(chunkPagesByCharLimit({}, 1000)).toEqual([]);
    expect(chunkPagesByCharLimit(null, 1000)).toEqual([]);
  });

  it('respects numeric ordering of pages', () => {
    const md = { '10': 'x', '2': 'y', '1': 'z' };
    const chunks = chunkPagesByCharLimit(md, 10000);
    expect(chunks).toHaveLength(1);
    expect(Object.keys(chunks[0])).toEqual(['1', '2', '10']);
  });
});

// ────────────────────────────────────────────────────────────────────────
// buildProfilePromptChunked
// ────────────────────────────────────────────────────────────────────────

describe('buildProfilePromptChunked', () => {
  it('first chunk: tells the model there is no prior profile', () => {
    const { prompt } = buildProfilePromptChunked({
      fileName: 'big.pdf',
      folderPath: 'Contracts',
      chunkPages: { '1': 'page 1 text' },
      chunkIndex: 0,
      totalChunks: 3,
      allPages: [1, 2, 3, 4, 5],
      priorProfile: null
    });
    expect(prompt).toContain('NO PROFILE YET');
    expect(prompt).toContain('Chunk: 1 of 3');
    expect(prompt).toContain('big.pdf');
    expect(prompt).toContain('Contracts');
    expect(prompt).toContain('## Page 1');
  });

  it('subsequent chunk: shows profile-so-far + carry-forward instruction', () => {
    const priorProfile = { type: 'frame_contract', summary: 'Existing summary' };
    const { prompt } = buildProfilePromptChunked({
      fileName: 'big.pdf',
      folderPath: 'Contracts / Acme',
      chunkPages: { '5': 'new page' },
      chunkIndex: 1,
      totalChunks: 3,
      allPages: [1, 2, 3, 4, 5],
      priorProfile
    });
    expect(prompt).toContain('PROFILE-SO-FAR');
    expect(prompt).toContain('frame_contract');
    expect(prompt).toContain('Existing summary');
    expect(prompt).toContain('Chunk: 2 of 3');
    expect(prompt).toContain('Carry forward');
    expect(prompt).toContain('Acme');
  });

  it('reports the chunk page range correctly', () => {
    const { prompt } = buildProfilePromptChunked({
      fileName: 'x.pdf',
      folderPath: null,
      chunkPages: { '7': 'a', '8': 'b', '9': 'c' },
      chunkIndex: 1,
      totalChunks: 4,
      allPages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      priorProfile: null
    });
    expect(prompt).toContain('Pages in this chunk: 7–9');
    expect(prompt).toContain('Total pages in document: 12 (pages 1–12)');
  });
});

// ────────────────────────────────────────────────────────────────────────
// buildDocumentProfile — chunked path (multi-pass with mock client)
// ────────────────────────────────────────────────────────────────────────

describe('buildDocumentProfile (chunked path)', () => {
  function pageOf(content, char) {
    // Build a page that's about `char` chars long, padded with the content's
    // text so the heading + governing-law validators can still find their
    // quotes if needed.
    return content.padEnd(char, ' ');
  }

  it('routes a small doc through single-pass', async () => {
    const md = { '1': 'small page' };
    const valid = validProfileFixture({
      headings: [], // no headings to need pointer validation
      keyFacts: {
        ...validProfileFixture().keyFacts,
        // Wipe keyFacts so no source-validation against a stub page is needed
        parties: null, partiesSource: null,
        effectiveDate: null, effectiveDateSource: null,
        term: null, termSource: null,
        governingLaw: null, governingLawSource: null,
        venue: null, venueSource: null,
        changeOfControl: null, changeOfControlSource: null,
        assignmentRequiresConsent: null, assignmentSource: null
      },
      summarySources: [],
      bundleHints: []
    });
    const client = {
      messages: {
        create: async () => ({
          content: [{ type: 'text', text: JSON.stringify(valid) }],
          usage: { input_tokens: 100, output_tokens: 100 }
        })
      }
    };
    const { profile, meta } = await buildDocumentProfile({
      fileName: 'small.pdf',
      folderPath: null,
      markdownPages: md,
      anthropicOverride: client
    });
    expect(meta.mode).toBe('single-pass');
    expect(meta.chunkCount).toBe(1);
    expect(profile.chunkCount).toBe(1);
  });

  it('routes a large doc through chunked-pass with N model calls', async () => {
    // Build pages totalling > MAX_SINGLE_PASS_CHARS so chunking kicks in.
    const pageSize = Math.ceil(MAX_SINGLE_PASS_CHARS / 2);
    const md = {
      '1': pageOf('p1', pageSize),
      '2': pageOf('p2', pageSize),
      '3': pageOf('p3', pageSize)
    };
    // Empty profile fixture (no pointers to validate; no keyFacts to drop).
    const emptyish = {
      ...validProfileFixture(),
      summarySources: [],
      headings: [],
      bundleHints: [],
      keyFacts: {
        parties: null, partiesSource: null,
        effectiveDate: null, effectiveDateSource: null,
        term: null, termSource: null,
        governingLaw: null, governingLawSource: null,
        venue: null, venueSource: null,
        changeOfControl: null, changeOfControlSource: null,
        assignmentRequiresConsent: null, assignmentSource: null
      }
    };

    let calls = 0;
    const client = {
      messages: {
        create: async () => {
          calls++;
          return {
            content: [{ type: 'text', text: JSON.stringify(emptyish) }],
            usage: { input_tokens: 1000, output_tokens: 100 }
          };
        }
      }
    };

    const { profile, meta } = await buildDocumentProfile({
      fileName: 'big.pdf',
      folderPath: 'Contracts',
      markdownPages: md,
      anthropicOverride: client
    });
    expect(meta.mode).toBe('chunked');
    expect(meta.chunkCount).toBeGreaterThan(1);
    expect(calls).toBe(meta.chunkCount);
    expect(profile.chunkCount).toBe(meta.chunkCount);
    // Token totals are summed across all chunks.
    expect(meta.inputTokens).toBe(calls * 1000);
    expect(meta.outputTokens).toBe(calls * 100);
  });
});
// ────────────────────────────────────────────────────────────────────────
// Entity Tracking
// ────────────────────────────────────────────────────────────────────────

describe('VALID_ENTITY_CATEGORIES', () => {
  it('exports all 6 required diligence entity categories', () => {
    expect(VALID_ENTITY_CATEGORIES).toContain('company_org');
    expect(VALID_ENTITY_CATEGORIES).toContain('person');
    expect(VALID_ENTITY_CATEGORIES).toContain('issue_risk_failure');
    expect(VALID_ENTITY_CATEGORIES).toContain('idea_upside');
    expect(VALID_ENTITY_CATEGORIES).toContain('product_service');
    expect(VALID_ENTITY_CATEGORIES).toContain('asset');
    expect(VALID_ENTITY_CATEGORIES).toHaveLength(6);
  });
});

describe('validateProfileShape — entities', () => {
  it('accepts a profile with valid entities', () => {
    const r = validateProfileShape(validProfileFixture());
    expect(r.ok).toBe(true);
  });

  it('accepts a profile with no entities field (backward-compat)', () => {
    const fix = validProfileFixture();
    delete fix.entities;
    const r = validateProfileShape(fix);
    expect(r.ok).toBe(true);
  });

  it('rejects an entity with unknown category', () => {
    const r = validateProfileShape(validProfileFixture({
      entities: [
        { name: 'Foo', category: 'alien_entity', description: 'test', source: { page: 1, quote: 'x' } }
      ]
    }));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('category must be one of'))).toBe(true);
  });

  it('rejects an entity missing source', () => {
    const r = validateProfileShape(validProfileFixture({
      entities: [
        { name: 'Foo', category: 'company_org', description: 'test', source: null }
      ]
    }));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('source must be'))).toBe(true);
  });

  it('rejects an entity with non-integer source.page', () => {
    const r = validateProfileShape(validProfileFixture({
      entities: [
        { name: 'Foo', category: 'person', description: 'desc', source: { page: 'one', quote: 'text' } }
      ]
    }));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('source must be'))).toBe(true);
  });
});

describe('validateProfileHeadings — entities', () => {
  it('keeps entities whose source quote matches the cited page', () => {
    const p = validProfileFixture();
    const r = validateProfileHeadings(p, PAGES_FIXTURE);
    expect(r.profile.entities).toHaveLength(2);
    expect(r.droppedEntities).toBe(0);
  });

  it('drops entities whose source quote does NOT match the cited page', () => {
    const p = validProfileFixture({
      entities: [
        {
          name: 'Phantom Corp',
          category: 'company_org',
          description: 'Not in the document.',
          source: { page: 1, quote: 'This quote does not exist anywhere on page 1.' }
        },
        {
          name: 'Acme Corp',
          category: 'company_org',
          description: 'Real party.',
          source: { page: 1, quote: 'between Acme Corp and GIGA' }
        }
      ]
    });
    const r = validateProfileHeadings(p, PAGES_FIXTURE);
    expect(r.profile.entities).toHaveLength(1);
    expect(r.profile.entities[0].name).toBe('Acme Corp');
    expect(r.droppedEntities).toBe(1);
  });

  it('returns empty entities array when profile has none', () => {
    const p = validProfileFixture({ entities: [] });
    const r = validateProfileHeadings(p, PAGES_FIXTURE);
    expect(r.profile.entities).toEqual([]);
    expect(r.droppedEntities).toBe(0);
  });
});

describe('buildSummary — entities', () => {
  it('mirrors entity name+category into summary, deduplicated', () => {
    const p = validProfileFixture({
      entities: [
        { name: 'Acme Corp', category: 'company_org', description: 'd', source: { page: 1, quote: 'q' } },
        { name: 'Acme Corp', category: 'company_org', description: 'd2', source: { page: 1, quote: 'q' } }, // duplicate
        { name: 'Jane Smith', category: 'person', description: 'd', source: { page: 1, quote: 'q' } }
      ]
    });
    const s = buildSummary(p);
    expect(s.entities).toHaveLength(2); // duplicate removed
    expect(s.entities[0]).toEqual({ name: 'Acme Corp', category: 'company_org' });
    expect(s.entities[1]).toEqual({ name: 'Jane Smith', category: 'person' });
    // Source quotes and descriptions must NOT be in the summary (keep it small).
    expect(s.entities[0].source).toBeUndefined();
    expect(s.entities[0].description).toBeUndefined();
  });

  it('returns empty entities array when profile has none', () => {
    const p = validProfileFixture({ entities: [] });
    const s = buildSummary(p);
    expect(s.entities).toEqual([]);
  });

  it('does not include headings, bundleHints or entities source quotes in summary', () => {
    const s = buildSummary(validProfileFixture());
    expect(s.headings).toBeUndefined();
    expect(s.bundleHints).toBeUndefined();
    expect(s.keyFacts.term).toBeUndefined();
  });
});
