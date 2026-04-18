/**
 * Structured logger contract for kimi-core (Phase 20 §C.3 / R-5).
 *
 * kimi-core stays transport-agnostic — callers inject a `Logger` impl and
 * kimi-core forwards structured records to it. Two defaults ship in-box:
 *
 *   - `noopLogger`   — default for every `logger?: Logger` dep; silent
 *                      so bare-metal tests don't need to wire anything
 *                      and production never falls back to `console.*`.
 *   - `consoleLogger`— dev-loop convenience; forwards to `console.*` and
 *                      merges `child(bindings)` into the per-call meta.
 *
 * Apps/kimi-cli wraps pino into this contract (see
 * `apps/kimi-cli/src/utils/pino-adapter.ts`); no pino import enters
 * kimi-core.
 *
 * Contract (mirrors pino for drop-in substitution):
 *   - four level methods: `debug` / `info` / `warn` / `error`
 *   - `child(bindings)` returns a Logger whose subsequent calls merge
 *     `bindings` under the per-call `meta` (most-specific-wins).
 */

/* eslint-disable no-console -- consoleLogger is the single authorised
   forwarder; all other core modules route through an injected Logger. */

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

class ConsoleLogger implements Logger {
  constructor(private readonly bindings: Record<string, unknown> = {}) {}

  private emit(
    fn: (msg?: unknown, ...args: unknown[]) => void,
    msg: string,
    meta?: Record<string, unknown>,
  ): void {
    const boundKeys = Object.keys(this.bindings);
    if (meta === undefined && boundKeys.length === 0) {
      fn(msg);
      return;
    }
    fn(msg, { ...this.bindings, ...meta });
  }

  debug(msg: string, meta?: Record<string, unknown>): void {
    this.emit(console.debug, msg, meta);
  }
  info(msg: string, meta?: Record<string, unknown>): void {
    this.emit(console.info, msg, meta);
  }
  warn(msg: string, meta?: Record<string, unknown>): void {
    this.emit(console.warn, msg, meta);
  }
  error(msg: string, meta?: Record<string, unknown>): void {
    this.emit(console.error, msg, meta);
  }
  child(bindings: Record<string, unknown>): Logger {
    return new ConsoleLogger({ ...this.bindings, ...bindings });
  }
}

export const consoleLogger: Logger = new ConsoleLogger();
