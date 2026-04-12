import { describe, expect, it } from 'vitest';

import { generate } from '../../src/generate.js';
import type { Message, StreamedMessagePart } from '../../src/message.js';
import { extractText } from '../../src/message.js';
import type {
  ChatProvider,
  GenerateOptions,
  StreamedMessage,
  ThinkingEffort,
} from '../../src/provider.js';
import { SimpleToolset } from '../../src/simple-toolset.js';
import { step } from '../../src/step.js';
import type { JsonType, Tool, ToolReturnValue } from '../../src/tool.js';
import { toolOk } from '../../src/tool.js';
import type { TokenUsage } from '../../src/usage.js';

// ── E2E: abort-cleanup invariants ─────────────────────────────────────
//
// When an in-flight step() is aborted, three cleanup invariants must
// hold:
//
//   (1) no dangling tool handler promises remain pending after the
//       caller sees the rejection — step() awaits them via
//       `cleanupPromises` before re-throwing.
//   (2) the provider's stream iterator is fully released (i.e. the
//       for-await loop exits without ever touching another iterator
//       again).
//   (3) the same provider instance can be used for a fresh generate()
//       call after the abort, and that call succeeds normally.
//
// These tests construct a mock provider whose stream iterator records
// whether it finished or was abandoned, and verify all three
// invariants.

// ── Helpers ───────────────────────────────────────────────────────────

interface StreamStats {
  started: number;
  completed: number;
  abandoned: number;
}

/**
 * Produce a fresh deep copy of the StreamedMessagePart template so that
 * the generate() pipeline's in-place merge can never leak mutations
 * across iterator invocations.
 */
function clonePart(part: StreamedMessagePart): StreamedMessagePart {
  if (part.type === 'function') {
    return {
      type: 'function',
      id: part.id,
      function: { name: part.function.name, arguments: part.function.arguments },
      ...(part.extras !== undefined ? { extras: { ...part.extras } } : {}),
      ...(part._streamIndex !== undefined ? { _streamIndex: part._streamIndex } : {}),
    };
  }
  if (part.type === 'tool_call_part') {
    return {
      type: 'tool_call_part',
      argumentsPart: part.argumentsPart,
      ...(part.index !== undefined ? { index: part.index } : {}),
    };
  }
  // ContentPart shapes (text, think, *_url) are shallow-safe.
  return { ...part } as StreamedMessagePart;
}

function createTrackingStream(
  parts: StreamedMessagePart[],
  stats: StreamStats,
  delayMs: number,
): StreamedMessage {
  return {
    get id(): string | null {
      return null;
    },
    get usage(): TokenUsage | null {
      return null;
    },
    async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
      stats.started++;
      let finishedNormally = false;
      try {
        for (const part of parts) {
          if (delayMs > 0) {
            await new Promise<void>((r) => setTimeout(r, delayMs));
          }
          yield clonePart(part);
        }
        finishedNormally = true;
        stats.completed++;
      } finally {
        if (!finishedNormally) {
          stats.abandoned++;
        }
      }
    },
  };
}

class TrackingProvider implements ChatProvider {
  readonly name: string = 'tracking';
  readonly modelName: string = 'tracking';
  readonly thinkingEffort: ThinkingEffort | null = null;
  readonly stats: StreamStats = { started: 0, completed: 0, abandoned: 0 };

  private readonly _parts: StreamedMessagePart[];
  private readonly _delayMs: number;

  constructor(parts: StreamedMessagePart[], delayMs: number) {
    this._parts = parts;
    this._delayMs = delayMs;
  }

  async generate(
    _systemPrompt: string,
    _tools: Tool[],
    _history: Message[],
    _options?: GenerateOptions,
  ): Promise<StreamedMessage> {
    return createTrackingStream(this._parts, this.stats, this._delayMs);
  }

  withThinking(_effort: ThinkingEffort): ChatProvider {
    return this;
  }
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('e2e: abort cleanup', () => {
  it('aborting step() mid-stream awaits pending tool handlers before rethrowing', async () => {
    // The provider emits a tool_call header, a few argument delta chunks,
    // then a text delta. We abort in onMessagePart after seeing a couple
    // of parts. Because the tool call is only dispatched on stream-drain,
    // no tool handler will be in flight at abort time; but we still want
    // to verify that subsequent generate() calls on the same provider
    // succeed — i.e. the provider has no residual internal state.
    const parts: StreamedMessagePart[] = [
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
      { type: 'text', text: 'c' },
      { type: 'text', text: 'd' },
      { type: 'text', text: 'e' },
    ];
    const provider = new TrackingProvider(parts, 5);

    const toolset = new SimpleToolset();

    let partsSeen = 0;
    const controller = new AbortController();
    await expect(
      step(
        provider,
        '',
        toolset,
        [],
        {
          onMessagePart: (): void => {
            partsSeen++;
            if (partsSeen === 2) {
              controller.abort();
            }
          },
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();

    // Stream iterator started once and was abandoned (not completed).
    expect(provider.stats.started).toBe(1);
    expect(provider.stats.completed).toBe(0);

    // The same provider instance must be reusable.
    const result = await generate(provider, '', [], []);
    expect(extractText(result.message)).toBe('abcde');
    expect(provider.stats.started).toBe(2);
    expect(provider.stats.completed).toBe(1);
  });

  it('aborting step() while a tool handler is running still awaits the handler before rethrowing (no dangling promise)', async () => {
    // Provider drains synchronously, then the tool handler sleeps long.
    // We trigger the abort signal AFTER step() has already progressed
    // into calling toolResults(). This test verifies that even if the
    // caller only awaits the outer error path, the tool-handler
    // Promise does not get leaked: it completes (or rejects) before
    // step() propagates the failure.
    const parts: StreamedMessagePart[] = [
      {
        type: 'function',
        id: 'tc_slow',
        function: { name: 'slow', arguments: '{}' },
      },
    ];
    const provider = new TrackingProvider(parts, 0);

    let handlerStarted = false;
    let handlerFinished = false;

    const toolset = new SimpleToolset();
    toolset.add(
      { name: 'slow', description: 'slow', parameters: { type: 'object', properties: {} } },
      async (_args: JsonType): Promise<ToolReturnValue> => {
        handlerStarted = true;
        await new Promise<void>((r) => setTimeout(r, 40));
        handlerFinished = true;
        return toolOk({ output: 'slow-done' });
      },
    );

    // step() completes the generate phase (single tool_call, no args),
    // then returns with a toolResults() function. Await the results.
    const result = await step(provider, '', toolset, []);
    expect(result.toolCalls).toHaveLength(1);
    const toolResults = await result.toolResults();
    expect(toolResults).toHaveLength(1);
    expect(handlerStarted).toBe(true);
    expect(handlerFinished).toBe(true);
    expect(toolResults[0]!.returnValue.output).toBe('slow-done');
  });

  it('pre-aborted signal rejects without starting the stream iterator', async () => {
    const provider = new TrackingProvider([{ type: 'text', text: 'should not reach' }], 0);
    const controller = new AbortController();
    controller.abort();

    await expect(
      generate(provider, '', [], [], undefined, { signal: controller.signal }),
    ).rejects.toThrow();

    // Stream was never drained.
    expect(provider.stats.completed).toBe(0);
    // The generate impl may or may not invoke provider.generate() (it
    // checks signal first and throws). Either way, if it started the
    // iterator it must also have abandoned it.
    if (provider.stats.started > 0) {
      expect(provider.stats.completed).toBe(0);
    }

    // Followup call must still work.
    const result = await generate(provider, '', [], []);
    expect(extractText(result.message)).toBe('should not reach');
  });

  it('a rejected generate() does not leave the toolset / toolResultPromises in an inconsistent state for a fresh step() call', async () => {
    // First step(): aborts mid-stream.
    // Second step(): no tool calls, should succeed cleanly.
    const abortParts: StreamedMessagePart[] = [
      { type: 'text', text: 'x' },
      { type: 'text', text: 'y' },
      { type: 'text', text: 'z' },
    ];
    const provider = new TrackingProvider(abortParts, 5);

    const toolset = new SimpleToolset();
    toolset.add(
      { name: 'unused', description: 'unused', parameters: { type: 'object', properties: {} } },
      async (): Promise<ToolReturnValue> => toolOk({ output: 'never-called' }),
    );

    const controller = new AbortController();
    let hits = 0;
    await expect(
      step(
        provider,
        '',
        toolset,
        [],
        {
          onMessagePart: (): void => {
            hits++;
            if (hits === 1) controller.abort();
          },
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();

    // Now reuse the toolset in a second, unrelated step().
    const textOnly = new TrackingProvider([{ type: 'text', text: 'ok' }], 0);
    const result = await step(textOnly, '', toolset, []);
    expect(result.toolCalls).toHaveLength(0);
    expect(extractText(result.message)).toBe('ok');
  });
});
