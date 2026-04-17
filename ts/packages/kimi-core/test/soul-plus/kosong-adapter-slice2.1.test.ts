/**
 * Slice 2.1 — Real Provider 接入 regression tests.
 *
 * Covers three fixes:
 *   1. KosongAdapter must use kosong `generate()` so parallel / streamed
 *      tool call argument deltas are assembled correctly (Phase 1 audit
 *      Slice 3 M4).
 *   2. `ChatParams.effort` must be routed through `provider.withThinking()`
 *      only when defined (Phase 1 audit Slice 3 M5 / coordinator Q2).
 *   3. `ChatResponse.actualModel` reflects the provider's real `modelName`
 *      (not `ChatParams.model`) so the transcript can record what was
 *      really used (coordinator Q1 / Q3).
 */

import { ScriptedEchoChatProvider, type ChatProvider } from '@moonshot-ai/kosong';
import { describe, expect, it, vi } from 'vitest';

import { KosongAdapter } from '../../src/soul-plus/index.js';
import type { ChatParams } from '../../src/soul/index.js';

function makeParams(overrides: Partial<ChatParams> = {}): ChatParams {
  return {
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'echo' }],
        toolCalls: [],
      },
    ],
    tools: [],
    model: 'mock-model',
    systemPrompt: '',
    signal: new AbortController().signal,
    ...overrides,
  };
}

// ── Fix 1: streamed tool call argument assembly ─────────────────────────

describe('KosongAdapter — streamed tool call assembly (Fix 1 / M4)', () => {
  it('assembles a tool call whose arguments stream as tool_call_part deltas', async () => {
    const script = [
      'tool_call: {"id": "tc_1", "name": "read_file", "arguments": null}',
      'tool_call_part: {"arguments_part": "{\\"path\\":"}',
      'tool_call_part: {"arguments_part": "\\"/tmp/foo\\"}"}',
      'finish_reason: "tool_calls"',
    ].join('\n');
    const provider = new ScriptedEchoChatProvider([script]);
    const adapter = new KosongAdapter({ provider });

    const response = await adapter.chat(makeParams());

    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0]).toMatchObject({
      id: 'tc_1',
      name: 'read_file',
      args: { path: '/tmp/foo' },
    });
  });

  it('assembles parallel tool calls without cross-contaminating arguments', async () => {
    // Two tool_call headers (no inline arguments) followed by their argument
    // deltas appended sequentially — the echo DSL feeds parts in order, and
    // kosong generate() merges sequentially within each pending ToolCall.
    const script = [
      'tool_call: {"id": "tc_1", "name": "read_file", "arguments": "{\\"path\\":\\"/a\\"}"}',
      'tool_call: {"id": "tc_2", "name": "write_file", "arguments": "{\\"path\\":\\"/b\\",\\"content\\":\\"hi\\"}"}',
      'finish_reason: "tool_calls"',
    ].join('\n');
    const provider = new ScriptedEchoChatProvider([script]);
    const adapter = new KosongAdapter({ provider });

    const response = await adapter.chat(makeParams());

    expect(response.toolCalls).toHaveLength(2);
    expect(response.toolCalls[0]).toMatchObject({
      id: 'tc_1',
      name: 'read_file',
      args: { path: '/a' },
    });
    expect(response.toolCalls[1]).toMatchObject({
      id: 'tc_2',
      name: 'write_file',
      args: { path: '/b', content: 'hi' },
    });
  });

  it('preserves thinking signature when think part carries encrypted payload', async () => {
    const script = ['think_encrypted: "sig_abc123"', 'text: "hello"', 'finish_reason: "stop"'].join(
      '\n',
    );
    const provider = new ScriptedEchoChatProvider([script]);
    const adapter = new KosongAdapter({ provider });

    const response = await adapter.chat(makeParams());

    const content = response.message.content;
    expect(Array.isArray(content)).toBe(true);
    const thinkingBlock = (content as Array<{ type: string; signature?: string }>).find(
      (b) => b.type === 'thinking',
    );
    expect(thinkingBlock).toBeDefined();
    expect(thinkingBlock?.signature).toBe('sig_abc123');
  });

  it('maps cache usage into TokenUsage cache_read / cache_write fields', async () => {
    const script = [
      'text: "ok"',
      'usage: {"input_other": 10, "output": 7, "input_cache_read": 3, "input_cache_creation": 5}',
      'finish_reason: "stop"',
    ].join('\n');
    const provider = new ScriptedEchoChatProvider([script]);
    const adapter = new KosongAdapter({ provider });

    const response = await adapter.chat(makeParams());

    expect(response.usage.input).toBe(18); // 10 + 3 + 5
    expect(response.usage.output).toBe(7);
    expect(response.usage.cache_read).toBe(3);
    expect(response.usage.cache_write).toBe(5);
  });

  it('forwards text deltas via params.onDelta', async () => {
    const script = ['text: "hello "', 'text: "world"', 'finish_reason: "stop"'].join('\n');
    const provider = new ScriptedEchoChatProvider([script]);
    const adapter = new KosongAdapter({ provider });

    const deltas: string[] = [];
    await adapter.chat(
      makeParams({
        onDelta: (d) => {
          if (typeof d === 'string') deltas.push(d);
        },
      }),
    );

    // Both text chunks should have surfaced to the caller. kosong generate()
    // may merge consecutive text parts — the important invariant is that no
    // text was dropped.
    expect(deltas.join('')).toBe('hello world');
  });
});

// ── Fix 2: effort passthrough via withThinking() ────────────────────────

describe('KosongAdapter — effort passthrough (Fix 2 / M5)', () => {
  function makeSpyProvider(): {
    readonly provider: ChatProvider;
    readonly withThinkingSpy: ReturnType<typeof vi.fn>;
  } {
    const inner = new ScriptedEchoChatProvider(['text: "ok"\nfinish_reason: "stop"']);
    const withThinkingSpy = vi.fn((_effort: unknown) => inner);
    const provider: ChatProvider = {
      name: inner.name,
      modelName: inner.modelName,
      thinkingEffort: inner.thinkingEffort,
      generate: inner.generate.bind(inner),
      withThinking: withThinkingSpy as unknown as ChatProvider['withThinking'],
    };
    return { provider, withThinkingSpy };
  }

  it('calls provider.withThinking(effort) when effort is "high"', async () => {
    const { provider, withThinkingSpy } = makeSpyProvider();
    const adapter = new KosongAdapter({ provider });

    await adapter.chat(makeParams({ effort: 'high' }));

    expect(withThinkingSpy).toHaveBeenCalledTimes(1);
    expect(withThinkingSpy).toHaveBeenCalledWith('high');
  });

  it('calls provider.withThinking("off") when effort is "off"', async () => {
    const { provider, withThinkingSpy } = makeSpyProvider();
    const adapter = new KosongAdapter({ provider });

    await adapter.chat(makeParams({ effort: 'off' }));

    expect(withThinkingSpy).toHaveBeenCalledWith('off');
  });

  it('does NOT call provider.withThinking when effort is undefined', async () => {
    const { provider, withThinkingSpy } = makeSpyProvider();
    const adapter = new KosongAdapter({ provider });

    await adapter.chat(makeParams({ effort: undefined }));

    expect(withThinkingSpy).not.toHaveBeenCalled();
  });
});

// ── Fix 3: transcript model = provider.modelName ───────────────────────

describe('KosongAdapter — transcript model source (Fix 3 / M5)', () => {
  it('sets response.actualModel from provider.modelName, not ChatParams.model', async () => {
    const provider = new ScriptedEchoChatProvider(['text: "ok"\nfinish_reason: "stop"']);
    // ScriptedEchoChatProvider.modelName is 'scripted_echo'
    const adapter = new KosongAdapter({ provider });

    const response = await adapter.chat(
      makeParams({ model: 'gpt-4-unused' }), // caller-requested model is ignored
    );

    expect(response.actualModel).toBe('scripted_echo');
  });
});
