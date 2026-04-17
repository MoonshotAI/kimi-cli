/**
 * Wire error-mapping table (Phase 17 §A.4).
 *
 * Central JSON-RPC-style error-code mapping shared by the production
 * `apps/kimi-cli --wire` frame loop and the in-memory harness. Maps four
 * error shapes to codes:
 *   -32700  Parse error      — codec decode failure (unparseable frame)
 *   -32600  Invalid request  — envelope schema rejection
 *   -32602  Invalid params   — zod-validated method params failure
 *   -32603  Internal error   — fallback
 *
 * Callers deliver the mapped error via `createWireResponse({error})` when
 * a `request_id` is addressable; when a codec failure prevented parsing
 * the envelope the mapping surfaces `request_id: null` so the transport
 * layer knows to synthesise a headerless error response.
 */

import { ZodError } from 'zod';

import type { WireError } from './types.js';
import { InvalidWireEnvelopeError, MalformedWireFrameError } from './errors.js';

export interface WireErrorMapping {
  readonly error: WireError;
  /**
   * `null` when the causing error happened before a request_id could be
   * recovered (codec or envelope-schema failures). Callers may override
   * with the real id when they know it.
   */
  readonly request_id: string | null;
}

export function mapToWireError(err: unknown): WireErrorMapping {
  if (err instanceof MalformedWireFrameError) {
    return {
      request_id: null,
      error: {
        code: -32700,
        message: 'Parse error: malformed wire frame',
        details: { cause: err.message },
      },
    };
  }

  if (err instanceof InvalidWireEnvelopeError) {
    return {
      request_id: null,
      error: {
        code: -32600,
        message: 'Invalid request envelope',
        details: { cause: err.message },
      },
    };
  }

  if (err instanceof ZodError) {
    return {
      request_id: null,
      error: {
        code: -32602,
        message: 'Invalid params',
        details: { issues: err.issues },
      },
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  return {
    request_id: null,
    error: {
      code: -32603,
      message: `Internal error: ${message}`,
    },
  };
}
