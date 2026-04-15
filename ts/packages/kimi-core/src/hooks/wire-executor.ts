/**
 * WireHookExecutor — client-side wire callback hook (§9-C.2).
 *
 * Sends a hook request over the wire to the connected client, waits for
 * the client's response (with timeout), and converts it into a HookResult.
 *
 * Slice 4 uses a `WireHookSender` abstraction — real Wire protocol
 * integration happens in Slice 5. Tests inject a fake sender.
 *
 * Audit M3 hardening (ports Python `hooks/engine.py:325-357`):
 *   - `hook.timeoutMs` drives `Promise.race` with a timeout resolver that
 *     fail-opens instead of rejecting.
 *   - The ambient `signal` is honored: abort → immediate fail-open.
 *   - If the sender supports cancellation (`cancel(requestId)`), it is
 *     called when the race is lost so the client side can drop the
 *     pending waiter; otherwise the orphan response is ignored.
 */

import type {
  HookConfig,
  HookEventType,
  HookExecutor,
  HookInput,
  HookResult,
  WireHookConfig,
} from './types.js';

const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

const FAIL_OPEN: HookResult = { ok: true };

// ── Wire sender abstraction ────────────────────────────────────────────

export interface WireHookMessage {
  readonly requestId: string;
  readonly subscriptionId: string;
  readonly event: HookEventType;
  readonly input: HookInput;
}

export interface WireHookResponse {
  readonly requestId: string;
  readonly result: HookResult;
}

export interface WireHookSender {
  send(message: WireHookMessage): Promise<WireHookResponse>;
  /**
   * Optional cancellation: if the executor loses the race (timeout or
   * abort), it calls `cancel(requestId)` so the sender can drop the
   * pending waiter. Senders that don't care may omit this method.
   */
  cancel?(requestId: string): void;
}

// ── Executor ───────────────────────────────────────────────────────────

export class WireHookExecutor implements HookExecutor {
  readonly type = 'wire' as const;
  private requestCounter = 0;

  constructor(private readonly sender: WireHookSender) {}

  async execute(hook: HookConfig, input: HookInput, signal: AbortSignal): Promise<HookResult> {
    const wireHook = hook as WireHookConfig;
    const timeoutMs = hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;

    if (signal.aborted) return FAIL_OPEN;

    this.requestCounter += 1;
    const requestId = `hook_req_${String(this.requestCounter)}`;
    const message: WireHookMessage = {
      requestId,
      subscriptionId: wireHook.subscriptionId,
      event: input.event,
      input,
    };

    const race = new Promise<{ result: HookResult; raced: boolean }>((resolve) => {
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

      const resolveOnce = (value: { result: HookResult; raced: boolean }): void => {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        signal.removeEventListener('abort', onAbort);
        // Multiple callers may race here (abort / timeout / sender). The
        // outer Promise latches on first resolve, so later calls are no-ops.
        // oxlint-disable-next-line promise/no-multiple-resolved
        resolve(value);
      };

      const onAbort = (): void => {
        resolveOnce({ result: FAIL_OPEN, raced: true });
      };
      signal.addEventListener('abort', onAbort);

      timeoutHandle = setTimeout(() => {
        resolveOnce({ result: FAIL_OPEN, raced: true });
      }, timeoutMs);

      const senderPromise: Promise<{ result: HookResult; raced: boolean }> = this.sender
        .send(message)
        .then((response) => ({ result: response.result, raced: false }))
        .catch(() => ({ result: FAIL_OPEN, raced: false }));
      // Feed the sender outcome through the same resolver; if the race has
      // already been won by abort/timeout, `resolveOnce` is a no-op because
      // the outer Promise latches on first `resolve`.
      senderPromise.then(resolveOnce, resolveOnce);
    });

    const outcome = await race;
    if (outcome.raced) {
      this.sender.cancel?.(requestId);
    }
    return outcome.result;
  }
}
