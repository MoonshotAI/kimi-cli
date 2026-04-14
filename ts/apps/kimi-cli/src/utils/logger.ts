/**
 * Application logger backed by pino.
 *
 * Writes structured JSON logs to `<dataDir>/logs/kimi.log`.
 *
 * The log file is created lazily on the first write so that importing this
 * module in tests does not produce side-effects when the data directory does
 * not exist.
 */

import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { WriteStream } from 'node:fs';

import pino from 'pino';

import { getLogDir } from '../config/paths.js';

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let _logger: pino.Logger | undefined;
let _logStream: WriteStream | undefined;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the singleton pino logger.
 *
 * On first call the log directory is created (if missing) and a file stream
 * is opened to `<logDir>/kimi.log`.
 */
export function getLogger(): pino.Logger {
  if (_logger) {
    return _logger;
  }

  const logDir = getLogDir();
  mkdirSync(logDir, { recursive: true });

  const logPath = join(logDir, 'kimi.log');
  _logStream = createWriteStream(logPath, { flags: 'a' });

  _logger = pino(
    {
      level: 'debug',
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    _logStream,
  );

  return _logger;
}

/**
 * Create a logger instance that writes to a custom destination.
 *
 * Useful for tests or specialised use-cases where the default file-based
 * logger is not appropriate.
 */
export function createLogger(
  dest: pino.DestinationStream,
  level: pino.Level = 'debug',
): pino.Logger {
  return pino({ level, timestamp: pino.stdTimeFunctions.isoTime }, dest);
}

/**
 * Flush and close the logger stream.  Calling `getLogger()` after this will
 * re-initialise a fresh instance.
 */
export function closeLogger(): void {
  if (_logStream) {
    _logStream.end();
    _logStream = undefined;
  }
  _logger = undefined;
}
