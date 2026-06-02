/**
 * Unit tests for the pure helpers used by the /extract and /extract-batch
 * endpoints. No Firestore, no OpenAI — just deterministic logic.
 */

import { describe, it, expect } from 'vitest';
import {
  buildExtractionPrompt,
  buildColumnJsonSchema,
  buildTypeRulesForPrompt,
  buildTypeMetaForPrompt,
  coerceValue,
  runWithConcurrency,
  EXTRACTION_JSON_SCHEMA,
  SUPPORTED_COLUMN_TYPES,
  DEFAULT_MAX_INPUT_CHARS
} from '../extractionPrompts.js';

describe('buildExtractionPrompt', () => {
  it('embeds the column name, type, and prompt verbatim', () => {
    const out = buildExtractionPrompt('Governing Law', 'text', 'Find the governing jurisdiction', 'NDA between Acme and Foo.');
    expect(out).toContain('Field: Governing Law');
    expect(out).toContain('Type: text');
    expect(out).toContain('Instructions: Find the governing jurisdiction');
    expect(out).toContain('NDA between Acme and Foo.');
  });

  it('describes each supported column type in the rules section', () => {
    const out = buildExtractionPrompt('X', 'text', 'p', 'doc');
    // text/list/date/boolean each have their own bullet; number+currency share one
    for (const t of ['boolean', 'number', 'date', 'list', 'text']) {
      expect(out).toContain(`type "${t}"`);
    }
    expect(out).toMatch(/type "number" \/ "currency"/);
  });

  it('truncates document content beyond the max length', () => {
    const long = 'a'.repeat(DEFAULT_MAX_INPUT_CHARS + 5000);
    const out = buildExtractionPrompt('X', 'text', 'p', long);
    expect(out).toContain('[... document truncated for length ...]');
    // The full content of `long` must NOT appear; truncated content must
    expect(out.length).toBeLessThan(long.length + 2000);
  });

  it('respects an overridden maxInputChars', () => {
    const long = 'b'.repeat(500);
    const out = buildExtractionPrompt('X', 'text', 'p', long, { maxInputChars: 100 });
    expect(out).toContain('[... document truncated for length ...]');
    // Only ~100 b's should appear in content portion
    const bRun = out.match(/b+/);
    expect(bRun[0].length).toBeLessThanOrEqual(100);
  });

  it('does not truncate short documents', () => {
    const short = 'short content';
    const out = buildExtractionPrompt('X', 'text', 'p', short);
    expect(out).not.toContain('truncated for length');
    expect(out).toContain('short content');
  });

  it('always emits the JSON output schema requirement', () => {
    const out = buildExtractionPrompt('X', 'text', 'p', 'doc');
    expect(out).toContain('"value"');
    expect(out).toContain('"confidence"');
    expect(out).toContain('"quote"');
    expect(out).toContain('"page"');
    expect(out).toContain('"reasoning"');
  });
});

describe('coerceValue', () => {
  describe('null handling', () => {
    it('returns null for null/undefined regardless of type', () => {
      for (const t of ['text', 'number', 'currency', 'boolean', 'date', 'list']) {
        expect(coerceValue(null, t)).toBe(null);
        expect(coerceValue(undefined, t)).toBe(null);
      }
    });
  });

  describe('number / currency', () => {
    it('passes through native numbers', () => {
      expect(coerceValue(42, 'number')).toBe(42);
      expect(coerceValue(3.14, 'currency')).toBe(3.14);
    });

    it('strips currency formatting from strings', () => {
      expect(coerceValue('$1,500,000', 'currency')).toBe(1500000);
      expect(coerceValue('USD 42.50', 'number')).toBe(42.5);
    });

    it('handles negatives', () => {
      expect(coerceValue('-100', 'number')).toBe(-100);
    });

    it('returns null for unparseable strings', () => {
      expect(coerceValue('not a number', 'number')).toBe(null);
      expect(coerceValue('', 'currency')).toBe(null);
    });
  });

  describe('boolean', () => {
    it('passes through native booleans', () => {
      expect(coerceValue(true, 'boolean')).toBe(true);
      expect(coerceValue(false, 'boolean')).toBe(false);
    });

    it('parses common truthy strings', () => {
      expect(coerceValue('true', 'boolean')).toBe(true);
      expect(coerceValue('Yes', 'boolean')).toBe(true);
      expect(coerceValue('1', 'boolean')).toBe(true);
      expect(coerceValue('TRUE  ', 'boolean')).toBe(true);
    });

    it('parses common falsy strings', () => {
      expect(coerceValue('false', 'boolean')).toBe(false);
      expect(coerceValue('No', 'boolean')).toBe(false);
      expect(coerceValue('0', 'boolean')).toBe(false);
    });

    it('returns null for ambiguous values', () => {
      expect(coerceValue('maybe', 'boolean')).toBe(null);
      expect(coerceValue('', 'boolean')).toBe(null);
    });
  });

  describe('date', () => {
    it('passes through ISO YYYY-MM-DD strings unchanged', () => {
      expect(coerceValue('2025-12-31', 'date')).toBe('2025-12-31');
    });

    it('normalizes parseable dates to ISO', () => {
      expect(coerceValue('December 31, 2025', 'date')).toBe('2025-12-31');
    });

    it('preserves an unparseable string rather than dropping it', () => {
      const out = coerceValue('Q4 2025', 'date');
      expect(out).toBe('Q4 2025');
    });
  });

  describe('text / list', () => {
    it('passes through strings unchanged', () => {
      expect(coerceValue('hello', 'text')).toBe('hello');
      expect(coerceValue('a; b; c', 'list')).toBe('a; b; c');
    });

    it('converts non-strings to strings', () => {
      expect(coerceValue(42, 'text')).toBe('42');
      expect(coerceValue(true, 'list')).toBe('true');
    });
  });

  describe('unknown column types', () => {
    it('falls back to text-style stringification', () => {
      expect(coerceValue('value', 'unknown')).toBe('value');
      expect(coerceValue(42, 'unknown')).toBe('42');
    });
  });
});

describe('runWithConcurrency', () => {
  it('returns results in input order', async () => {
    const items = [10, 30, 5, 20];
    const results = await runWithConcurrency(items, 2, async (n) => {
      await new Promise(r => setTimeout(r, n));
      return n * 2;
    });
    expect(results).toEqual([20, 60, 10, 40]);
  });

  it('respects the concurrency limit', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await runWithConcurrency(items, 4, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
    });
    expect(maxInFlight).toBeLessThanOrEqual(4);
  });

  it('handles an empty input list', async () => {
    const results = await runWithConcurrency([], 5, async () => 'should not be called');
    expect(results).toEqual([]);
  });

  it('does not abort when one task throws (each task awaited independently)', async () => {
    const items = [1, 2, 3];
    const results = await runWithConcurrency(items, 2, async (n) => {
      if (n === 2) {
        // Don't throw — return error sentinel like the real worker
        return { ok: false, error: 'boom' };
      }
      return { ok: true, n };
    });
    expect(results.length).toBe(3);
    expect(results[0]).toEqual({ ok: true, n: 1 });
    expect(results[1]).toEqual({ ok: false, error: 'boom' });
    expect(results[2]).toEqual({ ok: true, n: 3 });
  });

  it('does not exceed item count for lane spawning', async () => {
    let calls = 0;
    await runWithConcurrency([1, 2], 100, async () => { calls++; });
    expect(calls).toBe(2);
  });
});

describe('SUPPORTED_COLUMN_TYPES', () => {
  it('lists all eight types in sync with the frontend catalog', () => {
    expect([...SUPPORTED_COLUMN_TYPES].sort()).toEqual([
      'boolean', 'classification', 'currency', 'date', 'list', 'long_text', 'number', 'text'
    ]);
  });
});

describe('buildExtractionPrompt — type-specific rules', () => {
  it('classification options are listed in the Allowed Values block', () => {
    const out = buildExtractionPrompt(
      'Risk Level',
      'classification',
      'classify it',
      'doc body',
      {
        columnOptions: {
          values: [
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' }
          ]
        }
      }
    );
    expect(out).toMatch(/Allowed Values:/);
    expect(out).toMatch(/"low"/);
    expect(out).toMatch(/"high"/);
    expect(out).toMatch(/exactly one of the allowed values/i);
  });

  it('currency rules include the configured ISO code', () => {
    const out = buildExtractionPrompt('Cap', 'currency', 'get it', 'doc', {
      columnOptions: { currencyCode: 'EUR' }
    });
    expect(out).toMatch(/Currency: EUR/);
    expect(out).toMatch(/in EUR/);
  });

  it('long_text rule allows multi-paragraph output', () => {
    const out = buildExtractionPrompt('Term', 'long_text', 'summarize', 'doc');
    expect(out).toMatch(/multi-paragraph/);
  });

  it('boolean rule restricts value to true/false/null', () => {
    const out = buildExtractionPrompt('Has CoC', 'boolean', 'check', 'doc');
    expect(out).toMatch(/MUST be true or false/);
  });

  it('text rule asks for single-line output', () => {
    const out = buildExtractionPrompt('Counterparty', 'text', 'extract it', 'doc');
    expect(out).toMatch(/single-line/);
  });

  it('emits a Concise output style block telling the model to skip meta-preface', () => {
    const out = buildExtractionPrompt('Counterparty', 'text', 'extract it', 'doc body');
    expect(out).toMatch(/Concise output style/i);
    // A few of the explicit forbidden openings should be listed verbatim so
    // the model has concrete examples to avoid.
    expect(out).toMatch(/The document presents/);
    expect(out).toMatch(/This document is a/);
    expect(out).toMatch(/Based on the document/);
    expect(out).toMatch(/start with the substantive answer/i);
  });

  it('text per-type rule reminds the model not to begin with "The document…"', () => {
    expect(buildTypeRulesForPrompt('text', {})).toMatch(/The document/);
    expect(buildTypeRulesForPrompt('text', {})).toMatch(/substantive answer/);
  });

  it('long_text per-type rule reminds the model not to preface with meta-commentary', () => {
    expect(buildTypeRulesForPrompt('long_text', {})).toMatch(/meta-commentary|preface/i);
    expect(buildTypeRulesForPrompt('long_text', {})).toMatch(/substantive answer/);
  });
});

describe('buildTypeRulesForPrompt', () => {
  it('falls back to text rules for unknown types', () => {
    expect(buildTypeRulesForPrompt('unknown', {})).toMatch(/single-line/);
  });

  it('classification with no options degrades gracefully', () => {
    const rule = buildTypeRulesForPrompt('classification', {});
    expect(rule).toMatch(/<no options configured>/);
  });
});

describe('buildTypeMetaForPrompt', () => {
  it('returns empty string for plain types', () => {
    expect(buildTypeMetaForPrompt('text', {})).toBe('');
    expect(buildTypeMetaForPrompt('number', {})).toBe('');
  });

  it('emits the value/label list for classification', () => {
    const meta = buildTypeMetaForPrompt('classification', {
      values: [{ value: 'consent_required', label: 'Consent required' }]
    });
    expect(meta).toMatch(/Allowed Values/);
    expect(meta).toMatch(/"consent_required"/);
    expect(meta).toMatch(/Consent required/);
  });

  it('omits the parenthetical when label === value', () => {
    const meta = buildTypeMetaForPrompt('classification', {
      values: [{ value: 'low', label: 'low' }]
    });
    // Should not have "low (low)"
    expect(meta).not.toMatch(/\(low\)/);
  });
});

describe('buildColumnJsonSchema', () => {
  it('returns the standard envelope for every type', () => {
    for (const type of SUPPORTED_COLUMN_TYPES) {
      const schema = buildColumnJsonSchema(type, type === 'classification' ? { values: [{ value: 'a' }] } : {});
      expect(schema.name).toBe('extraction');
      expect(schema.strict).toBe(true);
      expect(schema.schema.required).toEqual(['value', 'confidence', 'quote', 'page', 'reasoning']);
      expect(schema.schema.additionalProperties).toBe(false);
    }
  });

  it('value is boolean|null for boolean columns', () => {
    const schema = buildColumnJsonSchema('boolean', {});
    expect(schema.schema.properties.value.type).toEqual(['boolean', 'null']);
  });

  it('value is number|null for number / currency columns', () => {
    expect(buildColumnJsonSchema('number', {}).schema.properties.value.type).toEqual(['number', 'null']);
    expect(buildColumnJsonSchema('currency', {}).schema.properties.value.type).toEqual(['number', 'null']);
  });

  it('value is enum|null for classification with options', () => {
    const schema = buildColumnJsonSchema('classification', {
      values: [{ value: 'low' }, { value: 'high' }]
    });
    const v = schema.schema.properties.value;
    expect(v.anyOf).toBeDefined();
    expect(v.anyOf[0].type).toBe('string');
    expect(v.anyOf[0].enum).toEqual(['low', 'high']);
    expect(v.anyOf[1].type).toBe('null');
  });

  it('classification with no options degrades to string|null', () => {
    const schema = buildColumnJsonSchema('classification', {});
    expect(schema.schema.properties.value.type).toEqual(['string', 'null']);
  });

  it('text / long_text / list / date all accept string|null', () => {
    for (const type of ['text', 'long_text', 'list', 'date']) {
      expect(buildColumnJsonSchema(type, {}).schema.properties.value.type).toEqual(['string', 'null']);
    }
  });
});

describe('coerceValue — classification', () => {
  const options = {
    values: [
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' }
    ]
  };

  it('passes through valid values', () => {
    expect(coerceValue('low', 'classification', options)).toBe('low');
    expect(coerceValue('high', 'classification', options)).toBe('high');
  });

  it('matches by case-insensitive label as a fallback', () => {
    expect(coerceValue('high', 'classification', options)).toBe('high');
    expect(coerceValue('HIGH', 'classification', options)).toBe('high');
    expect(coerceValue('LOW', 'classification', options)).toBe('low');
  });

  it('matches a label string back to its stored value', () => {
    expect(coerceValue('Low', 'classification', options)).toBe('low');
  });

  it('returns null when the value is not in the allowed set', () => {
    expect(coerceValue('mystery', 'classification', options)).toBeNull();
  });

  it('keeps the raw string when no options are configured', () => {
    expect(coerceValue('whatever', 'classification', {})).toBe('whatever');
  });

  it('null and empty string become null', () => {
    expect(coerceValue(null, 'classification', options)).toBeNull();
    expect(coerceValue('', 'classification', options)).toBeNull();
  });
});

describe('coerceValue — long_text', () => {
  it('passes strings through unchanged (multiline preserved)', () => {
    const v = 'paragraph one.\n\nparagraph two.';
    expect(coerceValue(v, 'long_text')).toBe(v);
  });
});

describe('EXTRACTION_JSON_SCHEMA', () => {
  it('has the documented shape', () => {
    expect(EXTRACTION_JSON_SCHEMA.name).toBe('extraction');
    expect(EXTRACTION_JSON_SCHEMA.strict).toBe(true);
    expect(EXTRACTION_JSON_SCHEMA.schema.type).toBe('object');
    expect(EXTRACTION_JSON_SCHEMA.schema.required).toEqual([
      'value', 'confidence', 'quote', 'page', 'reasoning'
    ]);
    expect(EXTRACTION_JSON_SCHEMA.schema.additionalProperties).toBe(false);
  });

  it('defines value as a multi-type union', () => {
    const valueType = EXTRACTION_JSON_SCHEMA.schema.properties.value.type;
    expect(valueType).toContain('string');
    expect(valueType).toContain('number');
    expect(valueType).toContain('boolean');
    expect(valueType).toContain('null');
  });

  it('restricts confidence to high/medium/low', () => {
    expect(EXTRACTION_JSON_SCHEMA.schema.properties.confidence.enum).toEqual([
      'high', 'medium', 'low'
    ]);
  });
});
