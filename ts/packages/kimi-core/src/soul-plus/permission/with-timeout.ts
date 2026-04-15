/**
 * withTimeout — Promise + AbortSignal race helper (Q4 P0 safeguard).
 *
 * The permission closure calls `approvalRuntime.request()` to get user
 * confirmation. A hung ApprovalRuntime (e.g. UI is offline, client
 * process died, or a parallel subagent approval queue is stuck —
 * Python bug #1724) must never freeze the orchestrator. We wrap every
 * approval request in a hard timeout + cancellation race so the turn
 * can make forward progress.
 *
 * Semantics:
 *   - Resolves with the inner promise's value when it settles first.
 *   - Rejects with `TimeoutError` when `timeoutMs` elapses first.
 *   - Rejects with the signal's abort reason when `signal` fires first.
 *   - Clears the timer in all cases (success, timeout, abort) so no
 *     dangling setTimeout handles leak between turns.
 */

export class ApprovalTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Approval request timed out after ${timeoutMs}ms`);
    this.name = 'ApprovalTimeoutError';
  }
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;

  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new ApprovalTimeoutError(timeoutMs));
      }, timeoutMs);

      if (signal !== undefined) {
        abortListener = () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        };
        signal.addEventListener('abort', abortListener, { once: true });
      }

      promise.then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (signal !== undefined && abortListener !== undefined) {
      signal.removeEventListener('abort', abortListener);
    }
  }
}
