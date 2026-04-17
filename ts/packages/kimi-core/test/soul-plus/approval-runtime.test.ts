/**
 * ApprovalRuntime interface + AlwaysAllowApprovalRuntime stub tests (§9-G).
 *
 * Tests verify that:
 *   - AlwaysAllowApprovalRuntime.request() immediately returns {approved: true}
 *   - AlwaysAllowApprovalRuntime.recoverPendingOnStartup() is a no-op
 *   - AlwaysAllowApprovalRuntime.resolve() is a no-op
 *   - AlwaysAllowApprovalRuntime.cancelBySource() is a no-op
 *   - ApprovalRuntime interface type contracts are satisfied
 */

import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  AlwaysAllowApprovalRuntime,
  NotImplementedError,
  type ApprovalRequest,
  type ApprovalResponseData,
  type ApprovalResult,
  type ApprovalRuntime,
} from '../../src/soul-plus/approval-runtime.js';
import type { ApprovalDisplay, ApprovalSource } from '../../src/storage/wire-record.js';

// ── Fixtures ──────────────────────────────────────────────────────────

function buildApprovalRequest(overrides?: Partial<ApprovalRequest>): ApprovalRequest {
  return {
    toolCallId: 'tc-1',
    toolName: 'Bash',
    action: 'execute command',
    display: { kind: 'command', command: 'echo ok' } satisfies ApprovalDisplay,
    source: { kind: 'soul', agent_id: 'agent_main' } satisfies ApprovalSource,
    ...overrides,
  };
}

// ── Type contract tests ───────────────────────────────────────────────

describe('ApprovalRuntime type contract', () => {
  it('AlwaysAllowApprovalRuntime implements ApprovalRuntime', () => {
    expectTypeOf<AlwaysAllowApprovalRuntime>().toMatchTypeOf<ApprovalRuntime>();
  });

  it('ApprovalRequest has required fields', () => {
    expectTypeOf<ApprovalRequest>().toHaveProperty('toolCallId');
    expectTypeOf<ApprovalRequest>().toHaveProperty('toolName');
    expectTypeOf<ApprovalRequest>().toHaveProperty('action');
    expectTypeOf<ApprovalRequest>().toHaveProperty('display');
    expectTypeOf<ApprovalRequest>().toHaveProperty('source');
  });

  it('ApprovalResult has required fields', () => {
    expectTypeOf<ApprovalResult>().toHaveProperty('approved');
  });

  it('ApprovalResponseData has required fields', () => {
    expectTypeOf<ApprovalResponseData>().toHaveProperty('response');
  });
});

// ── AlwaysAllowApprovalRuntime behavior tests ─────────────────────────

describe('AlwaysAllowApprovalRuntime', () => {
  it('request() immediately returns approved: true', async () => {
    const runtime = new AlwaysAllowApprovalRuntime();
    const result = await runtime.request(buildApprovalRequest());
    expect(result.approved).toBe(true);
    expect(result.feedback).toBeUndefined();
  });

  it('request() returns approved: true regardless of tool name', async () => {
    const runtime = new AlwaysAllowApprovalRuntime();
    const dangerous = buildApprovalRequest({
      toolName: 'Write',
      action: 'overwrite /etc/passwd',
      display: { kind: 'file_io', operation: 'write', path: '/etc/passwd' },
    });
    const result = await runtime.request(dangerous);
    expect(result.approved).toBe(true);
  });

  it('recoverPendingOnStartup() completes without error', async () => {
    const runtime = new AlwaysAllowApprovalRuntime();
    await expect(runtime.recoverPendingOnStartup()).resolves.toBeUndefined();
  });

  it('resolve() does not throw', () => {
    const runtime = new AlwaysAllowApprovalRuntime();
    const response: ApprovalResponseData = { response: 'approved' };
    expect(() => {
      runtime.resolve('req-1', response);
    }).not.toThrow();
  });

  it('cancelBySource() does not throw', () => {
    const runtime = new AlwaysAllowApprovalRuntime();
    const source: ApprovalSource = { kind: 'turn', turn_id: 't1' };
    expect(() => {
      runtime.cancelBySource(source);
    }).not.toThrow();
  });

  it('cancelBySource() handles all source kinds without error', () => {
    const runtime = new AlwaysAllowApprovalRuntime();
    const sources: ApprovalSource[] = [
      { kind: 'soul', agent_id: 'agent_main' },
      { kind: 'subagent', agent_id: 'agent_sub' },
      { kind: 'turn', turn_id: 't1' },
      { kind: 'session', session_id: 'ses_abc' },
    ];
    for (const source of sources) {
      expect(() => {
        runtime.cancelBySource(source);
      }).not.toThrow();
    }
  });

  // ── Slice 2.3 stubs for TeamDaemon hooks (§9-G.2) ───────────────────

  it('ingestRemoteRequest() throws NotImplementedError on the stub', async () => {
    const runtime = new AlwaysAllowApprovalRuntime();
    await expect(
      runtime.ingestRemoteRequest({
        request_id: 'x',
        tool_call_id: 'tc',
        tool_name: 'Bash',
        action: 'run command',
        display: { kind: 'command', command: 'ls' },
        source: { kind: 'soul', agent_id: 'agent_main' },
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });

  it('resolveRemote() throws NotImplementedError on the stub', () => {
    const runtime = new AlwaysAllowApprovalRuntime();
    expect(() => {
      runtime.resolveRemote({ request_id: 'x', response: 'approved' });
    }).toThrow(NotImplementedError);
  });
});
