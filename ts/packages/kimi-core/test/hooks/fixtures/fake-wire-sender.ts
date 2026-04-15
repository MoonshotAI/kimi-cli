/**
 * Fake WireHookSender — scripted responses for WireHookExecutor tests.
 */

import type { HookResult } from '../../../src/hooks/types.js';
import type {
  WireHookMessage,
  WireHookResponse,
  WireHookSender,
} from '../../../src/hooks/wire-executor.js';

export class FakeWireHookSender implements WireHookSender {
  readonly sentMessages: WireHookMessage[] = [];
  private response: HookResult;

  constructor(response?: HookResult) {
    this.response = response ?? { ok: true };
  }

  setResponse(response: HookResult): void {
    this.response = response;
  }

  async send(message: WireHookMessage): Promise<WireHookResponse> {
    this.sentMessages.push(message);
    return {
      requestId: message.requestId,
      result: this.response,
    };
  }
}
