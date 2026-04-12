import { describe, expect, it } from 'vitest';

import { EchoChatProvider, ScriptedEchoChatProvider } from '../../src/echo-provider.js';
import { generate } from '../../src/generate.js';
import type { Message, StreamedMessagePart, TextPart } from '../../src/message.js';
import { createUserMessage, extractText } from '../../src/message.js';
import { MockChatProvider } from '../../src/mock-provider.js';
import type { ChatProvider, ThinkingEffort } from '../../src/provider.js';

// ── E2E: cross-provider consistency ───────────────────────────────────
//
// These tests verify that the three "test-only" provider implementations
// available in `@moonshot-ai/kosong` (MockChatProvider, EchoChatProvider,
// ScriptedEchoChatProvider) all conform to the same ChatProvider contract
// under identical inputs:
//
//   1. They can be assigned to a `ChatProvider` variable interchangeably.
//   2. `withThinking(...)` always returns a NEW instance (no mutation of
//      the original) and never returns `this`.
//   3. Every provider's `generate()` honors `AbortSignal` via `options`.
//   4. `generate()` consumes the streamed output identically across
//      providers — same final message shape, same text content.

// ── Helpers ───────────────────────────────────────────────────────────

/** Build a one-text-part mock provider that emits "hello world". */
function buildMockProvider(text: string = 'hello world'): MockChatProvider {
  const parts: StreamedMessagePart[] = [{ type: 'text', text } satisfies TextPart];
  return new MockChatProvider(parts);
}

function buildEchoProvider(): EchoChatProvider {
  return new EchoChatProvider();
}

function buildScriptedEchoProvider(scripts: string[]): ScriptedEchoChatProvider {
  return new ScriptedEchoChatProvider(scripts);
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('e2e: cross-provider consistency', () => {
  describe('interface compatibility', () => {
    it('all test providers are assignable to ChatProvider', () => {
      const mock: ChatProvider = buildMockProvider();
      const echo: ChatProvider = buildEchoProvider();
      const scripted: ChatProvider = buildScriptedEchoProvider(['text: hi']);

      // Sanity: identity fields exist on all of them.
      for (const p of [mock, echo, scripted]) {
        expect(typeof p.name).toBe('string');
        expect(typeof p.modelName).toBe('string');
        expect(p.thinkingEffort === null || typeof p.thinkingEffort === 'string').toBe(true);
      }
    });

    it('all test providers expose the same ChatProvider method shape', () => {
      const providers: ChatProvider[] = [
        buildMockProvider(),
        buildEchoProvider(),
        buildScriptedEchoProvider(['text: hi']),
      ];

      for (const p of providers) {
        expect(typeof p.generate).toBe('function');
        expect(typeof p.withThinking).toBe('function');
      }
    });
  });

  describe('withThinking returns a new, independent instance', () => {
    const efforts: ThinkingEffort[] = ['off', 'low', 'medium', 'high'];

    it('MockChatProvider.withThinking returns a distinct instance', () => {
      const base = buildMockProvider();
      for (const effort of efforts) {
        const clone = base.withThinking(effort);
        expect(clone).not.toBe(base);
        // Base must not mutate — its thinkingEffort stays null.
        expect(base.thinkingEffort).toBeNull();
      }
    });

    it('EchoChatProvider.withThinking returns a distinct instance', () => {
      const base = buildEchoProvider();
      for (const effort of efforts) {
        const clone = base.withThinking(effort);
        expect(clone).not.toBe(base);
        expect(base.thinkingEffort).toBeNull();
      }
    });

    it('ScriptedEchoChatProvider.withThinking returns a distinct instance', () => {
      const base = buildScriptedEchoProvider(['text: a', 'text: b', 'text: c']);
      const clone = base.withThinking('high');
      expect(clone).not.toBe(base);
      expect(base.thinkingEffort).toBeNull();
    });

    it('withThinking does not touch the original provider across multiple effort values', () => {
      const base = buildMockProvider();
      const clones = efforts.map((e) => base.withThinking(e));
      // All clones are distinct from each other and from base.
      const allInstances = [base, ...clones];
      const unique = new Set(allInstances);
      expect(unique.size).toBe(allInstances.length);
    });
  });

  describe('generate() consumes all test providers identically', () => {
    it('MockChatProvider + EchoChatProvider + ScriptedEchoChatProvider produce the same text via generate', async () => {
      const text = 'consistent hello world';

      // Mock
      const mock = new MockChatProvider([{ type: 'text', text } satisfies TextPart]);
      const mockResult = await generate(mock, '', [], [createUserMessage('noop')]);

      // Echo: text lives in the last user message
      const echo = buildEchoProvider();
      const echoHistory: Message[] = [createUserMessage(`text: ${text}`)];
      const echoResult = await generate(echo, '', [], echoHistory);

      // Scripted echo: provider ignores history, consumes its queue
      const scripted = buildScriptedEchoProvider([`text: ${text}`]);
      const scriptedResult = await generate(scripted, '', [], [createUserMessage('go')]);

      for (const r of [mockResult, echoResult, scriptedResult]) {
        expect(r.message.role).toBe('assistant');
        expect(extractText(r.message)).toBe(text);
        expect(r.message.toolCalls).toEqual([]);
      }
    });
  });

  describe('all test providers honor AbortSignal before the provider call', () => {
    it('pre-aborted signal rejects through generate() for every test provider', async () => {
      const providers: { name: string; provider: ChatProvider; history: Message[] }[] = [
        {
          name: 'mock',
          provider: new MockChatProvider([
            { type: 'text', text: 'should not emit' } satisfies TextPart,
          ]),
          history: [createUserMessage('noop')],
        },
        {
          name: 'echo',
          provider: buildEchoProvider(),
          history: [createUserMessage('text: should not emit')],
        },
        {
          name: 'scripted',
          provider: buildScriptedEchoProvider(['text: should not emit']),
          history: [createUserMessage('go')],
        },
      ];

      for (const { provider, history } of providers) {
        const controller = new AbortController();
        controller.abort();
        await expect(
          generate(provider, '', [], history, undefined, { signal: controller.signal }),
        ).rejects.toThrow();
      }
    });
  });

  describe('ScriptedEchoChatProvider respects withThinking queue semantics', () => {
    it('withThinking returns a new instance sharing the remaining script queue', async () => {
      const base = buildScriptedEchoProvider(['text: first', 'text: second', 'text: third']);

      // Advance the base cursor by one call.
      const first = await generate(base, '', [], [createUserMessage('go')]);
      expect(extractText(first.message)).toBe('first');

      const clone = base.withThinking('low');
      expect(clone).not.toBe(base);

      // Clone should see the REMAINING scripts (second, third).
      const c1 = await generate(clone, '', [], [createUserMessage('go')]);
      expect(extractText(c1.message)).toBe('second');
      const c2 = await generate(clone, '', [], [createUserMessage('go')]);
      expect(extractText(c2.message)).toBe('third');

      // The base queue advances independently of the clone.
      const second = await generate(base, '', [], [createUserMessage('go')]);
      expect(extractText(second.message)).toBe('second');
    });
  });
});
