// Covers: `adaptAssistantMessage` — ChatResponse → AssistantMessagePayload.
//
// Slice 2.0 regressions:
//   - Fix 1 (§8 row 14): thinking.signature must round-trip through thinkSignature
//   - Fix 2 (§8 row 15): cache_write_tokens must be mapped from ChatResponse.usage

import { describe, expect, it } from 'vitest';

import { adaptAssistantMessage } from '../../src/soul/adapters.js';
import type { ChatResponse, TokenUsage } from '../../src/soul/index.js';

function makeChatResponse(overrides: Partial<ChatResponse> = {}): ChatResponse {
  return {
    message: { role: 'assistant', content: [] },
    toolCalls: [],
    usage: { input: 0, output: 0 },
    ...overrides,
  };
}

describe('adaptAssistantMessage — thinking.signature round-trip (Fix 1)', () => {
  it('extracts thinkSignature from ContentBlock with signature', () => {
    const response = makeChatResponse({
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'let me think...', signature: 'sig123' }],
      },
    });
    const payload = adaptAssistantMessage(response, 'test-model');
    expect(payload.think).toBe('let me think...');
    expect(payload.thinkSignature).toBe('sig123');
  });

  it('thinkSignature is undefined when thinking block has no signature', () => {
    const response = makeChatResponse({
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'some thought' }],
      },
    });
    const payload = adaptAssistantMessage(response, 'test-model');
    expect(payload.think).toBe('some thought');
    expect(payload.thinkSignature).toBeUndefined();
  });

  it('thinkSignature is undefined when there are no thinking blocks', () => {
    const response = makeChatResponse({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
      },
    });
    const payload = adaptAssistantMessage(response, 'test-model');
    expect(payload.think).toBeNull();
    expect(payload.thinkSignature).toBeUndefined();
  });

  it('uses the last thinking block signature when multiple thinking blocks exist', () => {
    const response = makeChatResponse({
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'first', signature: 'sig_a' },
          { type: 'thinking', thinking: 'second', signature: 'sig_b' },
        ],
      },
    });
    const payload = adaptAssistantMessage(response, 'test-model');
    // Multiple thinking blocks get joined; the last signature wins
    // because Anthropic streaming yields one final signature.
    expect(payload.think).toBe('firstsecond');
    expect(payload.thinkSignature).toBe('sig_b');
  });
});

describe('adaptAssistantMessage — cache_write_tokens (Fix 2)', () => {
  it('maps cache_write from ChatResponse.usage to payload.usage.cache_write_tokens', () => {
    const usage: TokenUsage = { input: 100, output: 50, cache_read: 20, cache_write: 30 };
    const response = makeChatResponse({ usage });
    const payload = adaptAssistantMessage(response, 'test-model');
    expect(payload.usage?.cache_write_tokens).toBe(30);
    expect(payload.usage?.cache_read_tokens).toBe(20);
  });

  it('omits cache_write_tokens when cache_write is undefined', () => {
    const usage: TokenUsage = { input: 100, output: 50 };
    const response = makeChatResponse({ usage });
    const payload = adaptAssistantMessage(response, 'test-model');
    expect(payload.usage?.cache_write_tokens).toBeUndefined();
  });
});
