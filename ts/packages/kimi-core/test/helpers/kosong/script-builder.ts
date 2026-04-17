/**
 * Fluent script builders for FakeKosongAdapter — Phase 9 §1.
 */

import type { StopReason, TokenUsage } from '../../../src/soul/types.js';

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
