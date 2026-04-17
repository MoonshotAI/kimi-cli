/**
 * Phase 17 A.3 — approval reverse-RPC unit surface.
 *
 * `WiredApprovalRuntime.request()` must:
 *   1. Write `approval_request` to wire.jsonl (already done).
 *   2. Simultaneously dispatch a reverse-RPC `approval.request` frame
 *      through an injected transport/sender hook.
 *   3. Await a client `approval.response` reverse-RPC frame, routed
 *      back into `resolveRemote` (no longer `NotImplementedError`).
 *
 * These tests pin the new sender seam at the unit level — they do not
 * boot the full wire harness. The harness-level round-trip sits in
 * `test/e2e/wire-approvals-tools.test.ts` (lifted from `it.todo`).
 */

import { describe, expect, it, vi } from 'vitest';

import {
  WiredApprovalRuntime,
  type WiredApprovalRuntimeDeps,
} from '../../src/soul-plus/wired-approval-runtime.js';
import type { ApprovalRequest } from '../../src/soul-plus/approval-runtime.js';
import { InMemoryApprovalStateStore } from '../../src/soul-plus/approval-state-store.js';

// Minimal in-memory SessionJournal double — appends are collected so
// tests can inspect order w/r/t reverse-RPC sends.
interface FakeJournal {
  readonly records: unknown[];
  appendApprovalRequest: (r: unknown) => Promise<void>;
  appendApprovalResponse: (r: unknown) => Promise<void>;
  appendUserMessage: (r: unknown) => Promise<void>;
}
function makeJournal(): FakeJournal {
  const records: unknown[] = [];
  return {
    records,
    async appendApprovalRequest(r) {
      records.push(r);
    },
    async appendApprovalResponse(r) {
      records.push(r);
    },
    async appendUserMessage(r) {
      records.push(r);
    },
  };
}

function makeRequest(): ApprovalRequest {
  return {
    toolCallId: 'tc_1',
    toolName: 'Bash',
    action: 'run "ls"',
    display: { kind: 'command', command: 'ls' },
    source: { kind: 'soul', agent_id: 'agent_main' },
    turnId: 'turn_1',
    step: 1,
  };
}

function makeRuntime(opts: { sender: (req: unknown) => void }): WiredApprovalRuntime {
  const journal = makeJournal();
  const stateStore = new InMemoryApprovalStateStore();
  const deps: WiredApprovalRuntimeDeps = {
    sessionJournal: journal as unknown as WiredApprovalRuntimeDeps['sessionJournal'],
    stateStore,
    loadJournalRecords: async () => [],
    // Phase 17 A.3 — new dep. Implementer picks the final name; this
    // test uses `reverseRpcSender` but the migration report explicitly
    // flags the seam for renaming if needed.
    reverseRpcSender: opts.sender,
  } as unknown as WiredApprovalRuntimeDeps;
  return new WiredApprovalRuntime(deps);
}

describe('Phase 17 A.3 — approval reverse-RPC request/response round-trip', () => {
  it('request() dispatches approval.request frame via reverseRpcSender', async () => {
    const sender = vi.fn<(req: unknown) => void>();
    const runtime = makeRuntime({ sender });

    const promise = runtime.request(makeRequest());
    // Give queueMicrotask a turn so the sender fires.
    await Promise.resolve();
    await Promise.resolve();

    expect(sender).toHaveBeenCalledTimes(1);
    const payload = sender.mock.calls[0]![0] as {
      method?: string;
      data?: { request_id: string; tool_name: string; action: string };
    };
    expect(payload.method).toBe('approval.request');
    expect(payload.data?.tool_name).toBe('Bash');
    expect(payload.data?.action).toBe('run "ls"');

    // Resolve via the new resolveRemote path — matches client reply.
    runtime.resolveRemote({
      request_id: payload.data!.request_id,
      response: 'approved',
    });
    const result = await promise;
    expect(result.approved).toBe(true);
  });

  it('reject response: feedback propagates through to ApprovalResult', async () => {
    const sender = vi.fn<(req: unknown) => void>();
    const runtime = makeRuntime({ sender });
    const promise = runtime.request(makeRequest());
    await Promise.resolve();
    const payload = sender.mock.calls[0]![0] as { data: { request_id: string } };
    runtime.resolveRemote({
      request_id: payload.data.request_id,
      response: 'rejected',
      feedback: 'not allowed in this workspace',
    });
    const result = await promise;
    expect(result.approved).toBe(false);
    expect(result.feedback).toBe('not allowed in this workspace');
  });

  it('multiple concurrent approval requests: each resolves independently by request_id', async () => {
    const sender = vi.fn<(req: unknown) => void>();
    const runtime = makeRuntime({ sender });
    const req1 = runtime.request({ ...makeRequest(), toolCallId: 'tc_1' });
    const req2 = runtime.request({
      ...makeRequest(),
      toolCallId: 'tc_2',
      action: 'run "pwd"',
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(sender).toHaveBeenCalledTimes(2);
    const id1 = (sender.mock.calls[0]![0] as { data: { request_id: string } }).data.request_id;
    const id2 = (sender.mock.calls[1]![0] as { data: { request_id: string } }).data.request_id;
    expect(id1).not.toBe(id2);

    // Resolve in reverse order.
    runtime.resolveRemote({ request_id: id2, response: 'rejected' });
    runtime.resolveRemote({ request_id: id1, response: 'approved' });
    const [r1, r2] = await Promise.all([req1, req2]);
    expect(r1.approved).toBe(true);
    expect(r2.approved).toBe(false);
  });
});
