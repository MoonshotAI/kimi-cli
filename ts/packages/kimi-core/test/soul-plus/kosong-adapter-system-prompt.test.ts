// Covers: §8 row 17 — systemPrompt 方案 B
// KosongAdapter must forward ChatParams.systemPrompt to provider.generate()
// as the first argument (replacing hardcoded '').

import { MockChatProvider } from '@moonshot-ai/kosong';
import { describe, expect, it, vi } from 'vitest';

import { KosongAdapter } from '../../src/soul-plus/index.js';
import type { ChatParams } from '../../src/soul/index.js';

function makeParams(overrides: Partial<ChatParams> = {}): ChatParams {
  return {
    messages: [],
    tools: [],
    model: 'mock-model',
    systemPrompt: '',
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('KosongAdapter — systemPrompt passthrough (Fix 4)', () => {
  it('passes systemPrompt to provider.generate() as first argument', async () => {
    const provider = new MockChatProvider([{ type: 'text', text: 'ok' }], {
      usage: { inputOther: 5, output: 3, inputCacheRead: 0, inputCacheCreation: 0 },
    });
    const generateSpy = vi.spyOn(provider, 'generate');
    const adapter = new KosongAdapter({ provider });

    await adapter.chat(makeParams({ systemPrompt: 'You are a helpful assistant' }));

    expect(generateSpy).toHaveBeenCalledOnce();
    expect(generateSpy.mock.calls[0]![0]).toBe('You are a helpful assistant');
  });

  it('passes empty string when systemPrompt is empty', async () => {
    const provider = new MockChatProvider([{ type: 'text', text: 'ok' }], {
      usage: { inputOther: 5, output: 3, inputCacheRead: 0, inputCacheCreation: 0 },
    });
    const generateSpy = vi.spyOn(provider, 'generate');
    const adapter = new KosongAdapter({ provider });

    await adapter.chat(makeParams({ systemPrompt: '' }));

    expect(generateSpy.mock.calls[0]![0]).toBe('');
  });
});
