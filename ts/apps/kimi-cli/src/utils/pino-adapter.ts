/**
 * Pino → kimi-core `Logger` adapter (Phase 20 §C.3 / R-5).
 *
 * kimi-core ships a transport-agnostic `Logger` contract; the app side
 * owns the real pino instance and wires it into every kimi-core caller
 * that accepts a `logger?: Logger`. This thin adapter converts pino's
 * `(meta, msg)` calling convention to the kimi-core `(msg, meta)` one.
 *
 * Each call translates as follows:
 *   Logger.warn('boom', { server_name: 'files' })
 *     → pino.warn({ server_name: 'files' }, 'boom')
 */

import type pino from 'pino';

import type { Logger } from '@moonshot-ai/core';

export function pinoToLogger(p: pino.Logger): Logger {
  return {
    debug: (msg, meta) => {
      p.debug(meta ?? {}, msg);
    },
    info: (msg, meta) => {
      p.info(meta ?? {}, msg);
    },
    warn: (msg, meta) => {
      p.warn(meta ?? {}, msg);
    },
    error: (msg, meta) => {
      p.error(meta ?? {}, msg);
    },
    child: (bindings) => pinoToLogger(p.child(bindings)),
  };
}
