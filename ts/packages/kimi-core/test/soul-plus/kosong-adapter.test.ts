/**
 * Covers: `KosongAdapter` class + `createKosongAdapter` factory
 * (v2 §5.1.5 / §5.8.2 / §11.1).
 *
 * Slice 3 scope: wrap a kosong `ChatProvider` so it satisfies Soul's
 * `KosongAdapter` interface. Tests pin the class shape, the factory, and
 * basic pass-through: given a mock `ChatProvider`, `chat(params)` must
 * return a valid `ChatResponse` with `{message, toolCalls, stopReason?,
 * usage}` that Soul can consume.
 *
 * These tests intentionally stay high-level. The line-by-line translation
 * (content-part adaptation / tool-call extraction / usage mapping / delta
 * streaming) is implementer-owned; the red bar simply requires the
 * adapter to exist and exercise the basic round-trip.
 */

import { MockChatProvider } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import { KosongAdapter, createKosongAdapter } from '../../src/soul-plus/index.js';
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

describe('KosongAdapter', () => {
  it('constructs via new with a ChatProvider', () => {
    const provider = new MockChatProvider([{ type: 'text', text: 'hello' }]);
    const adapter = new KosongAdapter({ provider });
    expect(adapter).toBeInstanceOf(KosongAdapter);
  });

  it('createKosongAdapter factory returns a KosongAdapter instance', () => {
    const provider = new MockChatProvider([{ type: 'text', text: 'ok' }]);
    const adapter = createKosongAdapter({ provider });
    expect(adapter).toBeInstanceOf(KosongAdapter);
  });

  it('exposes a `chat` method', () => {
    const provider = new MockChatProvider([{ type: 'text', text: 'ok' }]);
    const adapter = new KosongAdapter({ provider });
    expect(typeof adapter.chat).toBe('function');
  });

  it('chat() returns a ChatResponse with the canonical field shape', async () => {
    const provider = new MockChatProvider([{ type: 'text', text: 'hello world' }], {
      usage: { inputOther: 5, output: 3, inputCacheRead: 0, inputCacheCreation: 0 },
    });
    const adapter = new KosongAdapter({ provider });

    const response = await adapter.chat(makeParams());

    expect(response).toHaveProperty('message');
    expect(response).toHaveProperty('toolCalls');
    expect(response).toHaveProperty('usage');
    expect(response.message.role).toBe('assistant');
    expect(Array.isArray(response.toolCalls)).toBe(true);
    expect(typeof response.usage.input).toBe('number');
    expect(typeof response.usage.output).toBe('number');
  });

  it('chat() resolves the assistant text so Soul can assert on response.message', async () => {
    const provider = new MockChatProvider([{ type: 'text', text: 'greetings' }]);
    const adapter = new KosongAdapter({ provider });
    const response = await adapter.chat(makeParams());

    // The specific content-block shape is implementer-owned. We only
    // check that the scripted text surfaces somewhere in the response
    // so Soul's downstream assistant-message projection can find it.
    const blob = JSON.stringify(response.message);
    expect(blob).toContain('greetings');
  });

  it('chat() maps usage into Soul TokenUsage shape', async () => {
    const provider = new MockChatProvider([{ type: 'text', text: 'hi' }], {
      usage: { inputOther: 11, output: 7, inputCacheRead: 0, inputCacheCreation: 0 },
    });
    const adapter = new KosongAdapter({ provider });
    const response = await adapter.chat(makeParams());
    // Soul's TokenUsage.input is the total of inputOther + inputCacheRead
    // + inputCacheCreation (§5.1.5 / 附录 D.4). Here all cache fields are
    // 0, so input should equal inputOther.
    expect(response.usage.input).toBe(11);
    expect(response.usage.output).toBe(7);
  });

  it('chat() surfaces an abort-signal abort as a rejection', async () => {
    const provider = new MockChatProvider([{ type: 'text', text: 'hi' }]);
    const adapter = new KosongAdapter({ provider });
    const controller = new AbortController();
    controller.abort();
    await expect(adapter.chat(makeParams({ signal: controller.signal }))).rejects.toBeDefined();
  });
});
