import { describe, expect, it } from 'vitest';

import { generate } from '../../src/generate.js';
import { extractText } from '../../src/message.js';
import type { Message, StreamedMessagePart } from '../../src/message.js';
import type {
  ChatProvider,
  GenerateOptions,
  StreamedMessage,
  ThinkingEffort,
} from '../../src/provider.js';
import type { Tool } from '../../src/tool.js';
import type { TokenUsage } from '../../src/usage.js';

// ── Mock helpers ──────────────────────────────────────────────────────

/**
 * A configurable mock provider that tracks its own identity and config.
 * withThinking() and withGenerationKwargs() return new instances.
 */
class ConfigurableMockProvider implements ChatProvider {
  readonly name: string;
  readonly modelName: string;
  readonly thinkingEffort: ThinkingEffort | null;
  private readonly _responseText: string;
  private readonly _generationKwargs: Record<string, unknown>;

  constructor(opts: {
    name?: string;
    modelName?: string;
    thinkingEffort?: ThinkingEffort | null;
    responseText?: string;
    generationKwargs?: Record<string, unknown>;
  }) {
    this.name = opts.name ?? 'configurable';
    this.modelName = opts.modelName ?? 'configurable-model';
    this.thinkingEffort = opts.thinkingEffort ?? null;
    this._responseText = opts.responseText ?? 'default response';
    this._generationKwargs = opts.generationKwargs ?? {};
  }

  async generate(
    _systemPrompt: string,
    _tools: Tool[],
    _history: Message[],
  ): Promise<StreamedMessage> {
    const text = this._responseText;
    const effort = this.thinkingEffort;
    return {
      get id(): string | null {
        return 'msg-1';
      },
      get usage(): TokenUsage | null {
        return null;
      },
      async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
        if (effort !== null && effort !== 'off') {
          yield { type: 'think', think: `thinking at ${effort} effort` };
        }
        yield { type: 'text', text };
      },
    };
  }

  withThinking(effort: ThinkingEffort): ConfigurableMockProvider {
    return new ConfigurableMockProvider({
      name: this.name,
      modelName: this.modelName,
      thinkingEffort: effort,
      responseText: this._responseText,
      generationKwargs: { ...this._generationKwargs },
    });
  }

  getKwargs(): Record<string, unknown> {
    return { ...this._generationKwargs };
  }

  withGenerationKwargs(kwargs: Record<string, unknown>): ConfigurableMockProvider {
    return new ConfigurableMockProvider({
      name: this.name,
      modelName: this.modelName,
      thinkingEffort: this.thinkingEffort,
      responseText: this._responseText,
      generationKwargs: { ...this._generationKwargs, ...kwargs },
    });
  }
}

// ── Tests ─────────��──────────────────────────���────────────────────────

describe('e2e: provider switching', () => {
  describe('withThinking()', () => {
    it('creates a new provider with updated thinking effort', () => {
      const original = new ConfigurableMockProvider({ thinkingEffort: null });
      const withHigh = original.withThinking('high');

      expect(original.thinkingEffort).toBeNull();
      expect(withHigh.thinkingEffort).toBe('high');
    });

    it('original provider is not mutated by withThinking()', () => {
      const original = new ConfigurableMockProvider({ thinkingEffort: 'low' });
      const updated = original.withThinking('high');

      expect(original.thinkingEffort).toBe('low');
      expect(updated.thinkingEffort).toBe('high');

      // Chain another
      const updated2 = updated.withThinking('medium');
      expect(updated.thinkingEffort).toBe('high');
      expect(updated2.thinkingEffort).toBe('medium');
    });

    it('withThinking(off) disables thinking', async () => {
      const withThinking = new ConfigurableMockProvider({ thinkingEffort: 'high' });
      const noThinking = withThinking.withThinking('off');

      expect(noThinking.thinkingEffort).toBe('off');

      const result = await generate(noThinking, '', [], []);
      // 'off' should not produce think parts
      expect(result.message.content.every((p) => p.type !== 'think')).toBe(true);
    });

    it('generate() with thinking includes think parts', async () => {
      const provider = new ConfigurableMockProvider({
        thinkingEffort: 'high',
        responseText: 'answer',
      });

      const result = await generate(provider, '', [], []);

      expect(result.message.content).toHaveLength(2);
      expect(result.message.content[0]!.type).toBe('think');
      expect(result.message.content[1]!.type).toBe('text');
      expect(extractText(result.message)).toBe('answer');
    });
  });

  describe('withGenerationKwargs()', () => {
    it('creates a new provider with merged kwargs', () => {
      const original = new ConfigurableMockProvider({});
      const updated = original.withGenerationKwargs({ temperature: 0.5 });

      expect(original.getKwargs()).toEqual({});
      expect(updated.getKwargs()).toEqual({ temperature: 0.5 });
    });

    it('does not affect original provider', () => {
      const original = new ConfigurableMockProvider({
        generationKwargs: { maxTokens: 100 },
      });
      const updated = original.withGenerationKwargs({ temperature: 0.7 });

      expect(original.getKwargs()).toEqual({ maxTokens: 100 });
      expect(updated.getKwargs()).toEqual({ maxTokens: 100, temperature: 0.7 });
    });

    it('successive withGenerationKwargs calls stack correctly', () => {
      const p1 = new ConfigurableMockProvider({});
      const p2 = p1.withGenerationKwargs({ temperature: 0.5 });
      const p3 = p2.withGenerationKwargs({ maxTokens: 200 });
      const p4 = p3.withGenerationKwargs({ temperature: 0.9 }); // override

      expect(p1.getKwargs()).toEqual({});
      expect(p2.getKwargs()).toEqual({ temperature: 0.5 });
      expect(p3.getKwargs()).toEqual({ temperature: 0.5, maxTokens: 200 });
      expect(p4.getKwargs()).toEqual({ temperature: 0.9, maxTokens: 200 });
    });
  });

  describe('concurrent generate() calls on different providers', () => {
    it('two providers can generate() concurrently without interference', async () => {
      const providerA = new ConfigurableMockProvider({
        name: 'provider-a',
        responseText: 'response-A',
      });
      const providerB = new ConfigurableMockProvider({
        name: 'provider-b',
        responseText: 'response-B',
      });

      const [resultA, resultB] = await Promise.all([
        generate(providerA, '', [], []),
        generate(providerB, '', [], []),
      ]);

      expect(extractText(resultA.message)).toBe('response-A');
      expect(extractText(resultB.message)).toBe('response-B');
    });

    it('same provider can handle concurrent generate() calls', async () => {
      let callCount = 0;

      const provider: ChatProvider = {
        name: 'concurrent',
        modelName: 'concurrent-model',
        thinkingEffort: null,
        async generate(
          _systemPrompt: string,
          _tools: Tool[],
          _history: Message[],
        ): Promise<StreamedMessage> {
          const myCount = ++callCount;
          // Simulate slight delay
          await new Promise<void>((r) => setTimeout(r, 5));
          return {
            get id(): string | null {
              return `msg-${myCount}`;
            },
            get usage(): TokenUsage | null {
              return null;
            },
            async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
              yield { type: 'text', text: `response-${myCount}` };
            },
          };
        },
        withThinking(_effort: ThinkingEffort): ChatProvider {
          return this;
        },
      };

      const results = await Promise.all([
        generate(provider, '', [], []),
        generate(provider, '', [], []),
        generate(provider, '', [], []),
      ]);

      // Each should have a unique response
      const texts = results.map((r) => extractText(r.message));
      expect(texts).toHaveLength(3);
      const uniqueTexts = new Set(texts);
      expect(uniqueTexts.size).toBe(3);
    });

    it('original and withThinking() provider can generate() concurrently', async () => {
      const original = new ConfigurableMockProvider({
        thinkingEffort: null,
        responseText: 'no-think',
      });
      const thinking = original.withThinking('high');

      const [resultOrig, resultThink] = await Promise.all([
        generate(original, '', [], []),
        generate(thinking, '', [], []),
      ]);

      // Original: no think parts
      expect(resultOrig.message.content.every((p) => p.type !== 'think')).toBe(true);
      expect(extractText(resultOrig.message)).toBe('no-think');

      // Thinking: has think parts
      expect(resultThink.message.content.some((p) => p.type === 'think')).toBe(true);
      expect(extractText(resultThink.message)).toBe('no-think');
    });
  });

  describe('provider identity preservation', () => {
    it('withThinking preserves name and modelName', () => {
      const original = new ConfigurableMockProvider({
        name: 'my-provider',
        modelName: 'gpt-4o',
      });
      const updated = original.withThinking('medium');

      expect(updated.name).toBe('my-provider');
      expect(updated.modelName).toBe('gpt-4o');
    });

    it('withGenerationKwargs preserves name, modelName, and thinkingEffort', () => {
      const original = new ConfigurableMockProvider({
        name: 'my-provider',
        modelName: 'gpt-4o',
        thinkingEffort: 'high',
      });
      const updated = original.withGenerationKwargs({ temperature: 0.3 });

      expect(updated.name).toBe('my-provider');
      expect(updated.modelName).toBe('gpt-4o');
      expect(updated.thinkingEffort).toBe('high');
    });
  });

  describe('provider immutability', () => {
    it('withThinking does not modify the original provider', () => {
      const original = new ConfigurableMockProvider({
        thinkingEffort: 'low',
        responseText: 'original',
      });

      const originalEffort = original.thinkingEffort;
      const _updated = original.withThinking('high');

      // Original must be completely unchanged
      expect(original.thinkingEffort).toBe(originalEffort);
      expect(original.thinkingEffort).toBe('low');
    });

    it('chained withThinking calls do not mutate any intermediate provider', () => {
      const p1 = new ConfigurableMockProvider({ thinkingEffort: null });
      const p2 = p1.withThinking('low');
      const p3 = p2.withThinking('medium');
      const p4 = p3.withThinking('high');

      expect(p1.thinkingEffort).toBeNull();
      expect(p2.thinkingEffort).toBe('low');
      expect(p3.thinkingEffort).toBe('medium');
      expect(p4.thinkingEffort).toBe('high');
    });

    it('AbortSignal abort does not affect provider state for subsequent generate', async () => {
      const provider = new ConfigurableMockProvider({
        responseText: 'test',
        thinkingEffort: 'low',
      });

      // First generate with an abort signal that gets aborted mid-stream
      const controller = new AbortController();
      let partCount = 0;

      // Create a provider that yields slowly so we can abort mid-stream
      const slowProvider: ChatProvider = {
        name: 'slow',
        modelName: 'slow-model',
        thinkingEffort: provider.thinkingEffort,
        async generate(
          _systemPrompt: string,
          _tools: Tool[],
          _history: Message[],
          _options?: GenerateOptions,
        ): Promise<StreamedMessage> {
          return {
            get id(): string | null {
              return 'msg-slow';
            },
            get usage(): TokenUsage | null {
              return null;
            },
            async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
              yield { type: 'text', text: 'part1' };
              await new Promise<void>((r) => setTimeout(r, 5));
              yield { type: 'text', text: 'part2' };
              await new Promise<void>((r) => setTimeout(r, 5));
              yield { type: 'text', text: 'part3' };
            },
          };
        },
        withThinking(_effort: ThinkingEffort): ChatProvider {
          return this;
        },
      };

      const abortedPromise = generate(
        slowProvider,
        '',
        [],
        [],
        {
          onMessagePart(_part: StreamedMessagePart): void {
            partCount++;
            if (partCount >= 2) {
              controller.abort();
            }
          },
        },
        { signal: controller.signal },
      );

      await expect(abortedPromise).rejects.toThrow();

      // Now do a normal generate with the same base provider
      const result = await generate(provider, '', [], []);
      expect(extractText(result.message)).toBe('test');

      // Provider state should be unaffected
      expect(provider.thinkingEffort).toBe('low');
    });
  });
});
