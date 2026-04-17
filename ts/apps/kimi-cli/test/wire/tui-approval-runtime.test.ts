/**
 * TUIApprovalRuntime unit tests — verify the Slice 4.2 bridge behaviour
 * without spinning up a real kimi-core session. Covers:
 *
 *   - `request()` emits a wire `approval.request` envelope with the
 *     allocated request id and then blocks on a Deferred
 *   - `resolveFromClient` unblocks the request with the approve/reject
 *     decision surfaced to the tool orchestrator
 *   - `cancelBySource` settles pending requests with a feedback blob
 *   - abort signal cancels the pending request with a synthetic response
 */

import type { ApprovalRequest, ApprovalSource } from '@moonshot-ai/core';
import { describe, it, expect } from 'vitest';

import { TUIApprovalRuntime } from '../../src/wire/tui-approval-runtime.js';
import type { ApprovalRequestData } from '../../src/wire/index.js';
import type { WireMessage } from '../../src/wire/wire-message.js';

function makeRequest(overrides?: Partial<ApprovalRequest>): ApprovalRequest {
  const source: ApprovalSource = { kind: 'soul', agent_id: 'agent_main' };
  return {
    toolCallId: 'tc_1',
    toolName: 'Bash',
    action: 'run command',
    display: { kind: 'generic', summary: 'Approve Bash', detail: 'echo hi' },
    source,
    turnId: 'turn_1',
    step: 1,
    ...overrides,
  };
}

describe('TUIApprovalRuntime', () => {
  it('emits approval.request and resolves via resolveFromClient', async () => {
    const emitted: WireMessage[] = [];
    let nextId = 0;
    const runtime = new TUIApprovalRuntime({
      sessionId: 'ses_1',
      emit: (msg) => emitted.push(msg),
      currentTurnId: () => 'turn_1',
      allocateRequestId: () => {
        nextId += 1;
        return `appr_${String(nextId)}`;
      },
    });

    const pending = runtime.request(makeRequest());

    expect(emitted).toHaveLength(1);
    const env = emitted[0]!;
    expect(env.type).toBe('request');
    expect(env.method).toBe('approval.request');
    expect(env.id).toBe('appr_1');
    expect(env.session_id).toBe('ses_1');
    expect(env.turn_id).toBe('turn_1');
    const data = env.data as ApprovalRequestData;
    expect(data.description).toBe('echo hi');
    expect(data.display).toEqual([]);

    // Route the TUI response back.
    runtime.resolveFromClient('appr_1', { response: 'approved' });
    await expect(pending).resolves.toEqual({ approved: true });
    expect(runtime.pendingCount).toBe(0);
  });

  it('rejects the caller when the user says no', async () => {
    const runtime = new TUIApprovalRuntime({
      sessionId: 'ses_1',
      emit: () => {
        // discard
      },
      allocateRequestId: () => 'appr_reject',
    });

    const pending = runtime.request(makeRequest());
    runtime.resolveFromClient('appr_reject', { response: 'rejected', feedback: 'no way' });
    await expect(pending).resolves.toEqual({ approved: false, feedback: 'no way' });
  });

  it('cancelBySource settles matching requests with feedback', async () => {
    const runtime = new TUIApprovalRuntime({
      sessionId: 'ses_1',
      emit: () => {
        // discard
      },
      allocateRequestId: (() => {
        let n = 0;
        return () => {
          n += 1;
          return `appr_${String(n)}`;
        };
      })(),
    });

    const first = runtime.request(makeRequest({ source: { kind: 'turn', turn_id: 'turn_1' } }));
    const second = runtime.request(makeRequest({ source: { kind: 'turn', turn_id: 'turn_2' } }));

    runtime.cancelBySource({ kind: 'turn', turn_id: 'turn_1' });

    await expect(first).resolves.toEqual({
      approved: false,
      feedback: 'cancelled by source',
    });
    // The non-matching pending is still outstanding.
    expect(runtime.pendingCount).toBe(1);
    runtime.resolveFromClient('appr_2', { response: 'approved' });
    await expect(second).resolves.toEqual({ approved: true });
  });

  it('abort signal cancels the pending request', async () => {
    const runtime = new TUIApprovalRuntime({
      sessionId: 'ses_1',
      emit: () => {
        // discard
      },
      allocateRequestId: () => 'appr_abort',
    });

    const controller = new AbortController();
    const pending = runtime.request(makeRequest(), controller.signal);
    controller.abort();
    await expect(pending).resolves.toEqual({
      approved: false,
      feedback: 'cancelled by signal',
    });
  });

  it('ignores a bogus response payload instead of crashing', async () => {
    const runtime = new TUIApprovalRuntime({
      sessionId: 'ses_1',
      emit: () => {
        // discard
      },
      allocateRequestId: () => 'appr_bad',
    });

    let settled = false;
    const pending = runtime.request(makeRequest()).then(() => {
      settled = true;
    });
    runtime.resolveFromClient('appr_bad', { not: 'a real response' });
    // Give the promise microtask a chance to settle (it should NOT).
    await Promise.resolve();
    expect(settled).toBe(false);
    // Clean up via cancel so the promise can settle before the test exits.
    runtime.cancelBySource({ kind: 'soul', agent_id: 'agent_main' });
    await pending;
  });
});
