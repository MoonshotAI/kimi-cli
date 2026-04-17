/**
 * Fluent script builders for FakeKosongAdapter — Phase 9 §1.
 */

import type { StopReason, TokenUsage } from '../../../src/soul/types.js';
import type { ToolCallPartDelta } from '../../../src/soul/runtime.js';

// Phase 17 §B.6 — re-export from fake-kosong-adapter so tests can
// import from either path.
export { createScriptedKosong } from './fake-kosong-adapter.js';

export interface ScriptedToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

export type ScriptedStreaming =
  | 'whole'
  | 'chunked'
  | { readonly chunks: readonly string[] };

export interface ScriptedTurn {
  /** Optional assistant text. Omitted → empty-content assistant message. */
  readonly text?: string | undefined;
  /** Optional thinking stream. */
  readonly think?: string | undefined;
  /** Tool calls to return with this response. */
  readonly toolCalls?: readonly ScriptedToolCall[] | undefined;
  /** Stop reason returned on the `ChatResponse`. Defaults to `end_turn`. */
  readonly stopReason?: StopReason | undefined;
  /** Usage to return on the `ChatResponse`. Defaults to a small placeholder. */
  readonly usage?: TokenUsage | undefined;
  /** Optional `actualModel` echoed on the `ChatResponse`. */
  readonly actualModel?: string | undefined;
  /**
   * How to emit the text via `onDelta` before the response resolves.
   *   - `'whole'` (default): emit the full text in one call
   *   - `'chunked'`: split into ~8-char chunks and emit sequentially
   *   - `{chunks: [...]}`: emit the given sequence verbatim
   */
  readonly streaming?: ScriptedStreaming | undefined;
  /**
   * Phase 17 §B.6 — incremental tool_use chunks emitted via
   * `onDelta` BEFORE the final assistant message. Each entry becomes
   * one `ToolCallPartDelta` onDelta call. The `type` discriminator
   * is auto-injected by the fake so fixtures can stay terse (just
   * `{tool_call_id, name?, arguments_chunk?}`).
   */
  readonly toolCallParts?: ReadonlyArray<Omit<ToolCallPartDelta, 'type'>> | undefined;
}

export interface KosongErrorInjection {
  /** Zero-indexed turn (call count) at which to throw. */
  readonly atTurn: number;
  /** Error to reject with. Any value is accepted to mirror network errors. */
  readonly error: unknown;
  /** Optional partial delta emitted via `onDelta` before rejecting. */
  readonly partialDelta?: string | undefined;
}

export interface AbortOnTurn {
  readonly turn: number;
  readonly controller: AbortController;
}

export interface FakeKosongAdapterOptions {
  readonly turns?: readonly ScriptedTurn[];
  readonly errors?: readonly KosongErrorInjection[];
  readonly defaultDelayMs?: number;
  readonly abortOnTurn?: AbortOnTurn;
}

/**
 * Build the delta chunk list a `ScriptedTurn` should emit. Splits whole
 * text into ~8-char chunks for `'chunked'` mode; honours an explicit
 * `chunks` array verbatim otherwise.
 */
export function resolveDeltaChunks(turn: ScriptedTurn): readonly string[] {
  const text = turn.text ?? '';
  const streaming = turn.streaming ?? 'whole';
  if (text === '') return [];
  if (streaming === 'whole') return [text];
  if (streaming === 'chunked') {
    const size = 8;
    const out: string[] = [];
    for (let i = 0; i < text.length; i += size) {
      out.push(text.slice(i, i + size));
    }
    return out;
  }
  return streaming.chunks;
}
