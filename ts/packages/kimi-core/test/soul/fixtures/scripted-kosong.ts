/**
 * Test helper — a scripted KosongAdapter that plays back a fixed list of
 * `ChatResponse` objects, one per Soul step. Each call consumes the next
 * scripted response; if the script is exhausted the adapter throws, which
 * surfaces "Soul called the LLM more than the test expected" as a loud
 * test failure instead of a hang.
 *
 * Supports two extras useful for abort / error tests:
 *   - `abortDuringCall`: if provided, the adapter aborts the given signal
 *     mid-await before returning
 *   - `throwOnIndex`: if set, the adapter rejects with the provided error
 *     on the Nth call instead of returning a response
 */

import type { ChatParams, ChatResponse, KosongAdapter } from '../../../src/soul/index.js';

export interface ScriptedKosongOptions {
  readonly responses: ReadonlyArray<ChatResponse>;
  readonly throwOnIndex?: { index: number; error: unknown } | undefined;
  readonly abortOnIndex?: { index: number; controller: AbortController } | undefined;
  readonly delayMs?: number | undefined;
}

export class ScriptedKosongAdapter implements KosongAdapter {
  readonly calls: ChatParams[] = [];
  private index = 0;
  private readonly responses: ReadonlyArray<ChatResponse>;
  private readonly throwOnIndex: ScriptedKosongOptions['throwOnIndex'];
  private readonly abortOnIndex: ScriptedKosongOptions['abortOnIndex'];
  private readonly delayMs: number;

  constructor(opts: ScriptedKosongOptions) {
    this.responses = opts.responses;
    this.throwOnIndex = opts.throwOnIndex;
    this.abortOnIndex = opts.abortOnIndex;
    this.delayMs = opts.delayMs ?? 0;
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    this.calls.push(params);
    const current = this.index;
    this.index += 1;

    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }

    if (this.abortOnIndex !== undefined && this.abortOnIndex.index === current) {
      this.abortOnIndex.controller.abort();
    }

    if (params.signal.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }

    if (this.throwOnIndex !== undefined && this.throwOnIndex.index === current) {
      throw this.throwOnIndex.error;
    }

    if (current >= this.responses.length) {
      throw new Error(`ScriptedKosongAdapter ran out of responses at call ${current + 1}`);
    }

    const response = this.responses[current];
    if (response === undefined) {
      throw new Error(`ScriptedKosongAdapter: missing response at index ${current}`);
    }
    return response;
  }

  get callCount(): number {
    return this.calls.length;
  }
}
