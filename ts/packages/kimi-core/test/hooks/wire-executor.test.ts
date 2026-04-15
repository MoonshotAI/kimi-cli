/**
 * Covers: WireHookExecutor (v2 §9-C.2 wire channel).
 *
 * Pins:
 *   - Sends hook request via WireHookSender
 *   - Returns result from wire response
 *   - Generates unique requestId per invocation
 *   - Handles sender timeout gracefully
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WireHookConfig, PostToolUseInput } from '../../src/hooks/types.js';
import { WireHookExecutor } from '../../src/hooks/wire-executor.js';
import type {
  WireHookMessage,
  WireHookResponse,
  WireHookSender,
} from '../../src/hooks/wire-executor.js';
import { FakeWireHookSender } from './fixtures/fake-wire-sender.js';

function makeInput(): PostToolUseInput {
  return {
    event: 'PostToolUse',
    sessionId: 'sess_1',
    turnId: 'turn_1',
    agentId: 'agent_main',
    toolCall: { id: 'tc_1', name: 'Read', args: { path: '/tmp/x' } },
    args: { path: '/tmp/x' },
    result: { content: 'file content here' },
  };
}

function makeWireHook(overrides?: Partial<WireHookConfig>): WireHookConfig {
  return {
    type: 'wire',
    event: 'PostToolUse',
    subscriptionId: 'sub_1',
    ...overrides,
  };
}

/** Sender whose `send()` never resolves until we explicitly signal it. */
class PendingWireSender implements WireHookSender {
  readonly sentMessages: WireHookMessage[] = [];
  readonly cancelled: string[] = [];
  private resolvers = new Map<string, (response: WireHookResponse) => void>();

  async send(message: WireHookMessage): Promise<WireHookResponse> {
    this.sentMessages.push(message);
    return new Promise<WireHookResponse>((resolve) => {
      this.resolvers.set(message.requestId, resolve);
    });
  }

  cancel(requestId: string): void {
    this.cancelled.push(requestId);
  }

  resolve(requestId: string, response: WireHookResponse): void {
    const r = this.resolvers.get(requestId);
    if (r !== undefined) {
      r(response);
      this.resolvers.delete(requestId);
    }
  }
}

describe('WireHookExecutor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends a hook request via the wire sender', async () => {
    const sender = new FakeWireHookSender({ ok: true });
    const executor = new WireHookExecutor(sender);
    await executor.execute(makeWireHook(), makeInput(), new AbortController().signal);
    expect(sender.sentMessages).toHaveLength(1);
    expect(sender.sentMessages[0]?.subscriptionId).toBe('sub_1');
    expect(sender.sentMessages[0]?.event).toBe('PostToolUse');
  });

  it('returns the result from wire response', async () => {
    const sender = new FakeWireHookSender({
      ok: true,
      additionalContext: 'wire context',
    });
    const executor = new WireHookExecutor(sender);
    const result = await executor.execute(
      makeWireHook(),
      makeInput(),
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    expect(result.additionalContext).toBe('wire context');
  });

  it('generates unique requestId per invocation', async () => {
    const sender = new FakeWireHookSender({ ok: true });
    const executor = new WireHookExecutor(sender);
    await executor.execute(makeWireHook(), makeInput(), new AbortController().signal);
    await executor.execute(makeWireHook(), makeInput(), new AbortController().signal);
    expect(sender.sentMessages).toHaveLength(2);
    expect(sender.sentMessages[0]?.requestId).not.toBe(sender.sentMessages[1]?.requestId);
  });

  it('returns blockAction from wire response', async () => {
    const sender = new FakeWireHookSender({
      ok: true,
      blockAction: true,
      reason: 'client denied',
    });
    const executor = new WireHookExecutor(sender);
    const result = await executor.execute(
      makeWireHook(),
      makeInput(),
      new AbortController().signal,
    );
    expect(result.blockAction).toBe(true);
    expect(result.reason).toBe('client denied');
  });

  it('handles sender timeout gracefully (fail-open)', async () => {
    const sender: FakeWireHookSender = {
      sentMessages: [],
      setResponse: vi.fn(),
      async send() {
        throw new Error('wire timeout');
      },
    } as unknown as FakeWireHookSender;
    const executor = new WireHookExecutor(sender);
    const result = await executor.execute(
      makeWireHook({ timeoutMs: 10 }),
      makeInput(),
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    expect(result.blockAction).toBeFalsy();
  });

  // ── M3 regression: timeout / abort / fail-open / cancel ────────────

  it('fail-opens when sender never responds and timeoutMs elapses', async () => {
    vi.useFakeTimers();
    const sender = new PendingWireSender();
    const executor = new WireHookExecutor(sender);
    const pending = executor.execute(
      makeWireHook({ timeoutMs: 50 }),
      makeInput(),
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.blockAction).toBeFalsy();
    expect(sender.cancelled.length).toBe(1);
    expect(sender.cancelled[0]).toMatch(/^hook_req_/);
  });

  it('fail-opens when the ambient signal aborts before response arrives', async () => {
    const sender = new PendingWireSender();
    const executor = new WireHookExecutor(sender);
    const controller = new AbortController();
    const pending = executor.execute(makeWireHook(), makeInput(), controller.signal);
    queueMicrotask(() => {
      controller.abort();
    });
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.blockAction).toBeFalsy();
    expect(sender.cancelled.length).toBe(1);
  });

  it('returns immediately (fail-open) when signal is already aborted at entry', async () => {
    const sender = new PendingWireSender();
    const executor = new WireHookExecutor(sender);
    const controller = new AbortController();
    controller.abort();
    const result = await executor.execute(makeWireHook(), makeInput(), controller.signal);
    expect(result.ok).toBe(true);
    expect(sender.sentMessages.length).toBe(0);
  });
});
