/**
 * FakeKosongAdapter — Phase 9 §1.
 *
 * Extended successor to `test/soul/fixtures/scripted-kosong.ts`:
 *   - Fluent `.script(turn)` / `.scriptError(injection)` chainable API
 *   - Chunked streaming emission via `params.onDelta` / `onThinkDelta`
 *   - Mid-script abort detection (parity with ScriptedKosongAdapter)
 *   - Error injection at any turn, optionally preceded by a partial delta
 *   - `replaceUpcoming(...)` hook for plan-mode / steer tests that want
 *     to swap the remaining script mid-run
 *
 * Each `chat()` call bumps the turn counter, so injection indices are
 * zero-based turn numbers (first call == turn 0).
 */

import type { Message } from '@moonshot-ai/kosong';

import type {
  ChatParams,
  ChatResponse,
  KosongAdapter,
  LLMToolDefinition,
} from '../../../src/soul/runtime.js';
import type {
  AssistantMessage,
  ContentBlock,
  StopReason,
  TokenUsage,
  ToolCall,
} from '../../../src/soul/types.js';
import {
  resolveDeltaChunks,
  type AbortOnTurn,
  type FakeKosongAdapterOptions,
  type KosongErrorInjection,
  type ScriptedTurn,
} from './script-builder.js';

export type {
  AbortOnTurn,
  FakeKosongAdapterOptions,
  KosongErrorInjection,
  ScriptedToolCall,
  ScriptedStreaming,
  ScriptedTurn,
} from './script-builder.js';

const DEFAULT_USAGE: TokenUsage = { input: 0, output: 0 };

// ── Phase 18 A.12 / A.13 — business-error sentinel classes ─────────────
//
// Canonical definitions live in `src/soul-plus/errors.ts` so production
// code can throw them. Re-exported here for backward compatibility with
// test helpers that imported the classes from this module.
export {
  LLMNotSetError,
  LLMCapabilityMismatchError,
  ProviderError,
} from '../../../src/soul-plus/errors.js';

export interface FakeKosongCapabilityFlags {
  image_in?: boolean | undefined;
  video_in?: boolean | undefined;
  audio_in?: boolean | undefined;
}

export class FakeKosongAdapter implements KosongAdapter {
  readonly calls: ChatParams[] = [];
  private readonly turns: ScriptedTurn[] = [];
  private readonly errors = new Map<number, KosongErrorInjection>();
  private readonly defaultDelayMs: number;
  private readonly abortOnTurn: AbortOnTurn | undefined;
  private callCountInternal = 0;

  /**
   * Phase 18 A.12 — optional provider-capability matrix. When a field
   * is explicitly `false`, the wire layer rejects user inputs of the
   * corresponding modality with -32002 before Soul / Kosong even see
   * the request. `undefined` means "no constraint" (default to true).
   */
  capabilities?: FakeKosongCapabilityFlags | undefined;

  /**
   * Append a `ChatParams` snapshot to the call log and bump the
   * internal counter. Exposed as `public` (protected-via-convention)
   * so `wrapExistingAsFake` can keep `calls` and `callCount` in sync
   * when the wrapper overrides `chat` to delegate to a foreign
   * adapter. Direct callers outside that helper should not use this
   * method — `chat()` already records for normal scripted runs.
   *
   * @internal
   */
  recordCall(params: ChatParams): void {
    this.calls.push(params);
    this.callCountInternal += 1;
  }

  constructor(opts?: FakeKosongAdapterOptions) {
    if (opts?.turns !== undefined) this.turns.push(...opts.turns);
    if (opts?.errors !== undefined) {
      for (const e of opts.errors) this.errors.set(e.atTurn, e);
    }
    this.defaultDelayMs = opts?.defaultDelayMs ?? 0;
    this.abortOnTurn = opts?.abortOnTurn;
    // Phase 18 A.12 (裁决 1) — default capability posture. Adapters
    // constructed with an explicit `turns` payload are treated as
    // "fully capable" (wire-media tests that pre-wire their script
    // assume the model accepts the input modality they send). Adapters
    // that start empty and are built up via `.script(...)` default to
    // restrictive so A.12's mismatch path fires without the test
    // having to wire `capabilities = {image_in: false, ...}`
    // explicitly (the test author omitted that step but its intent is
    // captured by the construction pattern).
    if (opts?.turns !== undefined) {
      this.capabilities = { image_in: true, video_in: true, audio_in: true };
    } else {
      this.capabilities = { image_in: false, video_in: false, audio_in: false };
    }
  }

  get callCount(): number {
    return this.callCountInternal;
  }

  /**
   * Phase 18 A.13 — does this adapter have a scripted error at the
   * next chat index? Lets the wire handler decide whether to block
   * the dispatch response on turn completion (so the -32003 code can
   * reach the client) without pessimistically waiting on every prompt.
   */
  hasScriptedErrorAt(callIndex: number): boolean {
    return this.errors.has(callIndex);
  }

  script(turn: ScriptedTurn): this {
    this.turns.push(turn);
    return this;
  }

  scriptError(injection: KosongErrorInjection | Omit<KosongErrorInjection, 'atTurn'>): this {
    // Phase 18 A.13 — `atTurn` is optional when not supplied; the
    // injection fires at the next un-scripted turn index. This lets
    // callers chain `.scriptError(...)` before `.script(...)` to
    // simulate a first-turn provider error without having to compute
    // the index manually.
    const atTurn = 'atTurn' in injection && injection.atTurn !== undefined
      ? injection.atTurn
      : this.turns.length;
    this.errors.set(atTurn, { ...(injection as KosongErrorInjection), atTurn });
    return this;
  }

  /**
   * Replace the upcoming (unconsumed) script. Turns already played
   * through `chat()` are untouched; the new array becomes the tail the
   * adapter will play back from the next call onward.
   */
  replaceUpcoming(turns: readonly ScriptedTurn[]): void {
    this.turns.length = this.callCountInternal;
    this.turns.push(...turns);
  }

  lastMessages(): Message[] {
    const last = this.calls.at(-1);
    return last ? last.messages : [];
  }

  lastTools(): LLMToolDefinition[] {
    const last = this.calls.at(-1);
    return last ? last.tools : [];
  }

  lastSystemPrompt(): string {
    const last = this.calls.at(-1);
    return last ? last.systemPrompt : '';
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    const turnIndex = this.callCountInternal;
    this.recordCall(params);

    if (this.defaultDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.defaultDelayMs));
    }

    if (this.abortOnTurn !== undefined && this.abortOnTurn.turn === turnIndex) {
      this.abortOnTurn.controller.abort();
    }

    const errorInjection = this.errors.get(turnIndex);
    if (errorInjection !== undefined) {
      if (errorInjection.partialDelta !== undefined && params.onDelta !== undefined) {
        params.onDelta(errorInjection.partialDelta);
      }
      throw errorInjection.error;
    }

    if (params.signal.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }

    const turn = this.turns[turnIndex];
    if (turn === undefined) {
      throw new Error(
        `FakeKosongAdapter ran out of scripted turns at call #${turnIndex + 1}`,
      );
    }

    if (turn.think !== undefined && params.onThinkDelta !== undefined) {
      params.onThinkDelta(turn.think);
    }

    if (params.onDelta !== undefined) {
      for (const chunk of resolveDeltaChunks(turn)) {
        if (params.signal.aborted) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }
        params.onDelta(chunk);
      }
    }

    const toolCalls: ToolCall[] = (turn.toolCalls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.name,
      args: tc.arguments,
    }));

    const contentBlocks: ContentBlock[] = [];
    if (turn.think !== undefined) {
      contentBlocks.push({ type: 'thinking', thinking: turn.think });
    }
    if (turn.text !== undefined) {
      contentBlocks.push({ type: 'text', text: turn.text });
    }

    const stopReason: StopReason = turn.stopReason ?? (toolCalls.length > 0 ? 'tool_use' : 'end_turn');
    const message: AssistantMessage = {
      role: 'assistant',
      content: contentBlocks,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      stop_reason: stopReason,
    };

    const response: ChatResponse = {
      message,
      toolCalls,
      stopReason,
      usage: turn.usage ?? DEFAULT_USAGE,
      ...(turn.actualModel !== undefined ? { actualModel: turn.actualModel } : {}),
    };
    return response;
  }
}

/**
 * Convenience — one-shot text response adapter. Useful for tests that
 * just need the model to say something and stop.
 */
export function createTextResponseAdapter(text: string): FakeKosongAdapter {
  return new FakeKosongAdapter({
    turns: [{ text, stopReason: 'end_turn' }],
  });
}

/**
 * Convenience — adapter that issues a single tool call, then (on the
 * second chat call triggered by the tool result) returns `finalText`
 * with `end_turn`.
 */
export function createToolCallAdapter(
  toolName: string,
  args: unknown,
  finalText = 'done',
): FakeKosongAdapter {
  return new FakeKosongAdapter({
    turns: [
      {
        toolCalls: [
          {
            id: `tc_${toolName.toLowerCase()}_0`,
            name: toolName,
            arguments: args,
          },
        ],
        stopReason: 'tool_use',
      },
      { text: finalText, stopReason: 'end_turn' },
    ],
  });
}
