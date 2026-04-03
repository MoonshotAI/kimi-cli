/**
 * Logging module — corresponds to Python utils/logging.py
 * Simple structured logger using console with level filtering.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

class Logger {
  private level: LogLevel = "info";

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.level];
  }

  debug(message: string, ...args: unknown[]): void {
    if (this.shouldLog("debug")) process.stderr.write(`[DEBUG] ${message}${args.length ? " " + args.map(String).join(" ") : ""}\n`);
  }

  info(message: string, ...args: unknown[]): void {
    if (this.shouldLog("info")) process.stderr.write(`[INFO] ${message}${args.length ? " " + args.map(String).join(" ") : ""}\n`);
  }

  warn(message: string, ...args: unknown[]): void {
    if (this.shouldLog("warn")) process.stderr.write(`[WARN] ${message}${args.length ? " " + args.map(String).join(" ") : ""}\n`);
  }

  error(message: string, ...args: unknown[]): void {
    if (this.shouldLog("error")) process.stderr.write(`[ERROR] ${message}${args.length ? " " + args.map(String).join(" ") : ""}\n`);
  }
}

export const logger = new Logger();

// Set default level from environment
if (process.env.KIMI_LOG_LEVEL) {
  const envLevel = process.env.KIMI_LOG_LEVEL.toLowerCase() as LogLevel;
  if (envLevel in LOG_LEVELS) {
    logger.setLevel(envLevel);
  }
}
