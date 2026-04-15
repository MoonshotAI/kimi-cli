/**
 * WireHookExecutor — client-side wire callback hook (§9-C.2).
 *
 * Sends a hook request over the wire to the connected client, waits for
 * the client's response (with timeout), and converts it into a HookResult.
 *
 * Slice 4 uses a `WireHookSender` abstraction — real Wire protocol
 * integration happens in Slice 5. Tests inject a fake sender.
 */

import type {
  HookConfig,
  HookEventType,
  HookExecutor,
  HookInput,
  HookResult,
  WireHookConfig,
} from './types.js';

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
}

// ── Executor ───────────────────────────────────────────────────────────

export class WireHookExecutor implements HookExecutor {
  readonly type = 'wire' as const;
  private requestCounter = 0;

  constructor(private readonly sender: WireHookSender) {}

  async execute(hook: HookConfig, input: HookInput, _signal: AbortSignal): Promise<HookResult> {
    const wireHook = hook as WireHookConfig;
    this.requestCounter += 1;
    const requestId = `hook_req_${String(this.requestCounter)}`;

    try {
      const response = await this.sender.send({
        requestId,
        subscriptionId: wireHook.subscriptionId,
        event: input.event,
        input,
      });
      return response.result;
    } catch {
      // Fail-open: wire timeout or error → allow
      return { ok: true };
    }
  }
}
