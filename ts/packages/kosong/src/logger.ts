/**
 * Optional logging interface for kosong.
 *
 * By default kosong does not log anything. Library consumers can register
 * a logger via {@link setLogger} to receive trace/debug/info/warn/error
 * events from provider request handling, stream parsing, and tool dispatch.
 *
 * Each method accepts an optional context object so callers can attach
 * structured fields (e.g. `{ provider: 'kimi', tokens: 100 }`) without
 * prescribing a formatting convention.
 */
export interface Logger {
  trace(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

const noopLogger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
};

let currentLogger: Logger = noopLogger;

/**
 * Get the currently configured logger (defaults to a no-op implementation).
 */
export function getLogger(): Logger {
  return currentLogger;
}

/**
 * Set the global kosong logger. Pass `null` to reset to the no-op logger.
 */
export function setLogger(logger: Logger | null): void {
  currentLogger = logger ?? noopLogger;
}
