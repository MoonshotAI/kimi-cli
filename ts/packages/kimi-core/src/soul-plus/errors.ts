/**
 * Business-error sentinel classes — Phase 18 A.11 / A.12 / A.13
 * (v2 §3.1 wire error code table).
 *
 * Lives in `src/` rather than the test harness so production paths
 * (KosongAdapter implementations, wire server) can throw these
 * directly; the wire layer maps them onto the canonical JSON-RPC
 * style error codes:
 *
 *   -32001  LLM not configured (missing `default_model`)
 *   -32002  LLM capability mismatch (image_in / video_in / audio_in
 *           rejected by the selected model)
 *   -32003  Provider-level failure (network, rate-limit, 5xx, etc.)
 *
 * These classes extend `Error` so `instanceof` works across module
 * boundaries; the wire mapper in `classifyBusinessError` drops back
 * to a `/provider|backend|upstream/i` string heuristic when callers
 * throw vanilla `Error`s (e.g. fixture adapters that haven't been
 * migrated to `ProviderError`).
 */

/**
 * Phase 18 A.11 — no default LLM configured. Surfaced when a
 * session is created without a `model` AND config has no
 * `default_model` fallback. Host code can throw this at any point
 * the missing-model is observed; the wire layer maps it to code
 * -32001.
 */
export class LLMNotSetError extends Error {
  constructor(message = 'No LLM configured') {
    super(message);
    this.name = 'LLMNotSetError';
  }
}

/**
 * Phase 18 A.12 — the selected LLM does not accept the input
 * modality the client supplied (image / video / audio). Thrown by
 * the wire prompt handler before the turn is armed so the client
 * learns immediately via -32002.
 */
export class LLMCapabilityMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LLMCapabilityMismatchError';
  }
}

/**
 * Phase 18 A.13 — the provider surfaced a non-recoverable failure
 * (network, rate-limit, 5xx, upstream timeout). Wrap provider-
 * specific errors in this class so the wire layer can translate
 * them into -32003 without string sniffing.
 *
 * When a `cause` Error is supplied, structural fields commonly set
 * on Node's `NodeJS.ErrnoException` family (`code`, `status`,
 * `statusCode`) are mirrored onto the wrapper so callers that
 * `rejects.toMatchObject({ code: 'ECONNRESET' })` keep working
 * after the wrap. The wrapped original is still reachable via
 * `error.cause` for deep diagnostics.
 */
export class ProviderError extends Error {
  /** Optional provider-specific cause for diagnostics. */
  override readonly cause?: unknown;
  /** Mirrored from `cause.code` when present (network / HTTP libs). */
  readonly code?: string | number;
  readonly status?: number;
  readonly statusCode?: number;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ProviderError';
    if (cause !== undefined) {
      this.cause = cause;
      const causeObj = cause as {
        code?: string | number;
        status?: number;
        statusCode?: number;
      };
      if (causeObj.code !== undefined) this.code = causeObj.code;
      if (causeObj.status !== undefined) this.status = causeObj.status;
      if (causeObj.statusCode !== undefined) this.statusCode = causeObj.statusCode;
    }
  }
}

/**
 * Map a thrown error onto its canonical wire business-error code.
 * Returns `null` (not `undefined` — explicit "no mapping") when the
 * error is not one of the recognised business errors.
 *
 * Preference order:
 *   1. `instanceof LLMNotSetError`          → -32001
 *   2. `instanceof LLMCapabilityMismatchError` → -32002
 *   3. `instanceof ProviderError`           → -32003
 *   4. Heuristic fallback — any `Error` whose message matches
 *      `/provider|backend|upstream/i` is treated as a provider
 *      failure so fixture adapters that haven't been migrated to
 *      `ProviderError` still route correctly.
 */
export interface BusinessErrorMapping {
  readonly code: -32001 | -32002 | -32003;
  readonly message: string;
}

export function classifyBusinessError(error: unknown): BusinessErrorMapping | null {
  if (error instanceof LLMNotSetError) {
    return { code: -32001, message: error.message };
  }
  if (error instanceof LLMCapabilityMismatchError) {
    return { code: -32002, message: error.message };
  }
  if (error instanceof ProviderError) {
    return { code: -32003, message: error.message };
  }
  if (error instanceof Error && /provider|backend|upstream/i.test(error.message)) {
    return { code: -32003, message: error.message };
  }
  return null;
}
