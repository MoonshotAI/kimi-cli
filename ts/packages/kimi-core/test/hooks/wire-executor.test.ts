/**
 * Covers: WireHookExecutor (v2 §9-C.2 wire channel).
 *
 * Pins:
 *   - Sends hook request via WireHookSender
 *   - Returns result from wire response
 *   - Generates unique requestId per invocation
 *   - Handles sender timeout gracefully
 */

import { describe, expect, it, vi } from 'vitest';

import type { WireHookConfig, PostToolUseInput } from '../../src/hooks/types.js';
import { WireHookExecutor } from '../../src/hooks/wire-executor.js';
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

describe('WireHookExecutor', () => {
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
});
