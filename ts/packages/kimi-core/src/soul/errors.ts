/**
 * Soul-internal error types (§5.1.7).
 *
 * Only errors Soul itself raises live here. Errors from downstream layers
 * (tool execution failure, LLM provider error, ContextState gated-write
 * rejection, etc.) surface as plain `Error` or as types owned by their
 * respective layer.
 */

export class MaxStepsExceededError extends Error {
  readonly code = 'soul.max_steps_exceeded' as const;
  readonly maxSteps: number;

  constructor(maxSteps: number, message?: string) {
    super(message ?? `Soul turn exceeded maxSteps=${maxSteps}`);
    this.name = 'MaxStepsExceededError';
    this.maxSteps = maxSteps;
  }
}
