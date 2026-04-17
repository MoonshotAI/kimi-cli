/**
 * Soul-internal error types (§5.1.7).
 *
 * Only errors Soul itself raises live here. Errors from downstream layers
 * (tool execution failure, LLM provider error, ContextState gated-write
 * rejection, etc.) surface as plain `Error` or as types owned by their
 * respective layer.
 */

import type { TokenUsage } from './types.js';

export class MaxStepsExceededError extends Error {
  readonly code = 'soul.max_steps_exceeded' as const;
  readonly maxSteps: number;

  constructor(maxSteps: number, message?: string) {
    super(message ?? `Soul turn exceeded maxSteps=${maxSteps}`);
    this.name = 'MaxStepsExceededError';
    this.maxSteps = maxSteps;
  }
}

/**
 * Slice 5 / 决策 #96 L3 — reactive context-overflow signal.
 *
 * Raised by `KosongAdapter.chat` whenever a provider returns either an
 * explicit PTL/413 error (17+ provider patterns are normalised here into
 * one identity) or a usage snapshot whose total input exceeds
 * `ChatParams.contextWindow` (silent overflow).
 *
 * Caught by `TurnManager.runTurn` which then triggers
 * `executeCompaction` and re-enters Soul on the same turn id, sharing the
 * `MAX_COMPACTIONS_PER_TURN` budget with the `needs_compaction` branch.
 */
export class ContextOverflowError extends Error {
  readonly code = 'context_overflow' as const;
  readonly usage: TokenUsage | undefined;

  constructor(message: string, usage?: TokenUsage) {
    super(message);
    this.name = 'ContextOverflowError';
    this.usage = usage;
  }
}
