/**
 * Unit tests for hyde.js — HyDE expansion + timeout + error paths.
 */

import { describe, it, expect } from 'vitest';

const hyde = await import('../hyde.js');
const {
  generateHydeExpansion,
  HYDE_MODEL,
  HYDE_MAX_TOKENS,
  HYDE_TIMEOUT_MS,
  HYDE_SYSTEM_PROMPT
} = hyde.default || hyde;

// ───────────────────────────────────────────────────────────────────────────
// Configuration
// ───────────────────────────────────────────────────────────────────────────

describe('hyde configuration', () => {
  it('uses Haiku 4.5 by default (single-model-per-role for the HyDE role)', () => {
    expect(HYDE_MODEL).toBe('claude-haiku-4-5');
  });

  it('exports positive numeric defaults', () => {
    expect(HYDE_MAX_TOKENS).toBeGreaterThan(0);
    expect(HYDE_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('system prompt instructs against generic / labeled output', () => {
    expect(HYDE_SYSTEM_PROMPT).toMatch(/PLAIN TEXT/);
    expect(HYDE_SYSTEM_PROMPT).toMatch(/no markdown/);
    expect(HYDE_SYSTEM_PROMPT).toMatch(/Don't.*invent/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// generateHydeExpansion
// ───────────────────────────────────────────────────────────────────────────

describe('generateHydeExpansion', () => {
  // Mock client observes the AbortSignal on the second arg so the timeout
  // path tests the real production semantics (signal-driven cancellation).
  function mockClient(responseText, options = {}) {
    return {
      messages: {
        create: async (params, requestOpts) => {
          if (options.captureCall) options.captureCall(params);
          const signal = requestOpts?.signal;
          if (options.delayMs) {
            await new Promise((resolve, reject) => {
              const timer = setTimeout(resolve, options.delayMs);
              if (signal) {
                if (signal.aborted) {
                  clearTimeout(timer);
                  const err = new Error('aborted');
                  err.name = 'AbortError';
                  reject(err);
                  return;
                }
                signal.addEventListener('abort', () => {
                  clearTimeout(timer);
                  const err = new Error('aborted');
                  err.name = 'AbortError';
                  reject(err);
                });
              }
            });
          }
          if (options.shouldThrow) throw new Error(options.shouldThrow);
          return {
            content: [{ type: 'text', text: responseText }],
            usage: { input_tokens: 50, output_tokens: 100 }
          };
        }
      }
    };
  }

  it('returns the model output as text', async () => {
    const result = await generateHydeExpansion('change of control', {
      anthropicOverride: mockClient('A change of control of either party shall require prior written consent...')
    });
    expect(result.text).toContain('change of control');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.usage.input_tokens).toBe(50);
    expect(result.usage.output_tokens).toBe(100);
  });

  it('trims surrounding whitespace from the response', async () => {
    const result = await generateHydeExpansion('term', {
      anthropicOverride: mockClient('   \n\nThe initial term shall be five years.   \n')
    });
    expect(result.text.startsWith('The initial term')).toBe(true);
    expect(result.text.endsWith('five years.')).toBe(true);
  });

  it('passes the configured model + max_tokens to Anthropic', async () => {
    const calls = [];
    await generateHydeExpansion('test', {
      anthropicOverride: mockClient('output', { captureCall: (params) => calls.push(params) })
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe(HYDE_MODEL);
    expect(calls[0].max_tokens).toBe(HYDE_MAX_TOKENS);
    expect(calls[0].system).toBe(HYDE_SYSTEM_PROMPT);
    expect(calls[0].messages).toEqual([
      { role: 'user', content: 'Query: test\nOutput:' }
    ]);
  });

  it('rejects when query is empty', async () => {
    await expect(generateHydeExpansion('', {})).rejects.toThrow(/non-empty string/);
    await expect(generateHydeExpansion('   ', {})).rejects.toThrow(/non-empty string/);
    await expect(generateHydeExpansion(null, {})).rejects.toThrow(/non-empty string/);
  });

  it('rejects when the model returns empty text', async () => {
    const client = {
      messages: { create: async () => ({ content: [{ type: 'text', text: '   ' }] }) }
    };
    await expect(generateHydeExpansion('q', { anthropicOverride: client })).rejects.toThrow(/empty response/);
  });

  it('respects a per-call timeout', async () => {
    const slowClient = mockClient('eventually', { delayMs: 200 });
    await expect(
      generateHydeExpansion('q', { anthropicOverride: slowClient, timeoutMs: 50 })
    ).rejects.toThrow(/timeout/);
  });

  it('propagates underlying API errors', async () => {
    const failingClient = mockClient('', { shouldThrow: 'rate limited' });
    await expect(
      generateHydeExpansion('q', { anthropicOverride: failingClient })
    ).rejects.toThrow(/rate limited/);
  });
});
