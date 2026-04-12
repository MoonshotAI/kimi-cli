import type { Runtime, TurnResult } from '@moonshot-ai/core';
import type {
  ChatProvider,
  Message,
  ThinkingEffort,
  ToolCall,
  Toolset,
  TokenUsage,
} from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

// ── Cross-package type compatibility ──────────────────────────────────

describe('cross-package type inference', () => {
  it('Runtime.llm is typed as ChatProvider from kosong', () => {
    // Verify that Runtime.llm has the ChatProvider shape
    // by constructing a minimal conforming object.
    const provider: ChatProvider = {
      name: 'test-provider',
      modelName: 'test-model',
      thinkingEffort: null,
      generate: async () => {
        throw new Error('not implemented');
      },
      withThinking(_effort: ThinkingEffort): ChatProvider {
        return this;
      },
    };

    const runtime: Runtime = {
      llm: provider,
      kaos: { emit: () => {} } as never, // minimal stub
      toolset: { names: [], get: () => {} } as unknown as Toolset,
      maxStepsPerTurn: 10,
    };

    // The key assertion: Runtime.llm should be assignable from ChatProvider
    const llm: ChatProvider = runtime.llm;
    expect(llm.name).toBe('test-provider');
    expect(llm.modelName).toBe('test-model');
  });

  it('TurnResult.usage is typed as TokenUsage | null from kosong', () => {
    const usage: TokenUsage = {
      inputOther: 100,
      output: 50,
      inputCacheRead: 20,
      inputCacheCreation: 10,
    };

    const result: TurnResult = {
      stopReason: 'done',
      stepCount: 3,
      usage,
    };

    // TurnResult.usage should be assignable to TokenUsage | null
    const extractedUsage: TokenUsage | null = result.usage;
    expect(extractedUsage).not.toBeNull();
    expect(extractedUsage!.inputOther).toBe(100);
    expect(extractedUsage!.output).toBe(50);
  });

  it('TurnResult.usage can be null', () => {
    const result: TurnResult = {
      stopReason: 'cancelled',
      stepCount: 0,
      usage: null,
    };

    expect(result.usage).toBeNull();
  });

  it('TurnResult.stopReason accepts only valid literals', () => {
    // These should all type-check:
    const reasons: TurnResult['stopReason'][] = ['done', 'cancelled', 'error', 'max_steps'];
    expect(reasons).toHaveLength(4);
  });

  it('Message type from kosong is usable in kimi-core context', () => {
    // Verify Message can be constructed and fields accessed
    const msg: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'hello from cross-package' }],
      toolCalls: [],
    };
    expect(msg.role).toBe('assistant');
    expect(msg.content[0]!.type).toBe('text');
  });

  it('ToolCall type from kosong is usable in kimi-core context', () => {
    const tc: ToolCall = {
      type: 'function',
      id: 'call-cross-1',
      function: { name: 'cross_tool', arguments: '{}' },
    };
    expect(tc.function.name).toBe('cross_tool');
  });
});
