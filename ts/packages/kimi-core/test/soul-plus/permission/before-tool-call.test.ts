/**
 * Covers: buildBeforeToolCall closure factory (v2 §9-E.7).
 *
 * Pins:
 *   - allow decision → closure returns undefined (Soul continues)
 *   - deny decision → closure returns {block:true, reason} with main-agent text
 *   - deny decision for subagent → closure returns subagent-specific text
 *     (i.e. "try a different approach — don't retry / don't bypass")
 *   - ask decision + approvalRuntime.request → approved → undefined
 *   - ask decision + approvalRuntime rejects → {block:true, reason}
 *   - ask decision + approvalRuntime hangs → timeout kicks in (Q4 P0 safeguard)
 *   - closure snapshots the rule array at construction time
 *   - subagent approvalSource routes through subagent rejection text
 */

import { describe, expect, it } from 'vitest';

import type {
  ApprovalRequest,
  ApprovalResult,
  ApprovalRuntime,
  ApprovalResponseData,
} from '../../../src/soul-plus/approval-runtime.js';
import {
  buildBeforeToolCall,
  DEFAULT_APPROVAL_TIMEOUT_MS,
} from '../../../src/soul-plus/permission/before-tool-call.js';
import type { PermissionRule } from '../../../src/soul-plus/permission/types.js';
import type { AssistantMessage, BeforeToolCallContext, ToolCall } from '../../../src/soul/index.js';
import type { SoulContextState } from '../../../src/storage/context-state.js';
import type { ApprovalSource } from '../../../src/storage/wire-record.js';

// ── Test doubles ──────────────────────────────────────────────────────

class RecordingApprovalRuntime implements ApprovalRuntime {
  public readonly calls: ApprovalRequest[] = [];
  constructor(private readonly response: ApprovalResult) {}
  async request(req: ApprovalRequest): Promise<ApprovalResult> {
    this.calls.push(req);
    return this.response;
  }
  async recoverPendingOnStartup(): Promise<void> {}
  resolve(_requestId: string, _response: ApprovalResponseData): void {}
  cancelBySource(_source: ApprovalSource): void {}
  async ingestRemoteRequest(): Promise<void> {
    throw new Error('not used in this test');
  }
  resolveRemote(): void {
    throw new Error('not used in this test');
  }
}

class HangingApprovalRuntime implements ApprovalRuntime {
  public requested = 0;
  async request(_req: ApprovalRequest): Promise<ApprovalResult> {
    this.requested += 1;
    return new Promise(() => {}); // never resolves
  }
  async recoverPendingOnStartup(): Promise<void> {}
  resolve(_requestId: string, _response: ApprovalResponseData): void {}
  cancelBySource(_source: ApprovalSource): void {}
  async ingestRemoteRequest(): Promise<void> {
    throw new Error('not used in this test');
  }
  resolveRemote(): void {
    throw new Error('not used in this test');
  }
}

function makeContext(toolCall: ToolCall, args: unknown): BeforeToolCallContext {
  return {
    toolCall,
    args,
    assistantMessage: {} as unknown as AssistantMessage,
    context: {} as unknown as SoulContextState,
  };
}

function call(name: string, args: unknown): ToolCall {
  return { id: `tc_${name}`, name, args };
}

const SOUL: ApprovalSource = { kind: 'soul', agent_id: 'agent_main' };
const SUB: ApprovalSource = { kind: 'subagent', agent_id: 'agent_sub_1' };

// ── Tests ─────────────────────────────────────────────────────────────

describe('buildBeforeToolCall', () => {
  const signal = new AbortController().signal;

  it('allow decision → returns undefined (Soul continues)', async () => {
    const rules: PermissionRule[] = [
      { decision: 'allow', scope: 'turn-override', pattern: 'Write' },
    ];
    const hook = buildBeforeToolCall({
      rules,
      mode: 'default',
      approvalRuntime: new RecordingApprovalRuntime({ approved: true }),
      approvalSource: SOUL,
    });
    const result = await hook(
      makeContext(call('Write', { path: '/tmp/x' }), { path: '/tmp/x' }),
      signal,
    );
    expect(result).toBeUndefined();
  });

  it('deny decision → returns block with main-agent rejection text', async () => {
    const rules: PermissionRule[] = [
      { decision: 'deny', scope: 'turn-override', pattern: 'Write' },
    ];
    const hook = buildBeforeToolCall({
      rules,
      mode: 'default',
      approvalRuntime: new RecordingApprovalRuntime({ approved: true }),
      approvalSource: SOUL,
    });
    const result = await hook(makeContext(call('Write', {}), {}), signal);
    expect(result?.block).toBe(true);
    expect(result?.reason).toMatch(/denied by permission rule/);
    expect(result?.reason).not.toMatch(/different approach/);
  });

  it('subagent deny decision → returns block with subagent-specific text', async () => {
    const rules: PermissionRule[] = [
      { decision: 'deny', scope: 'turn-override', pattern: 'Write' },
    ];
    const hook = buildBeforeToolCall({
      rules,
      mode: 'default',
      approvalRuntime: new RecordingApprovalRuntime({ approved: true }),
      approvalSource: SUB,
    });
    const result = await hook(makeContext(call('Write', {}), {}), signal);
    expect(result?.block).toBe(true);
    expect(result?.reason).toMatch(/different approach/);
    expect(result?.reason).toMatch(/don't retry/);
  });

  it('ask decision + approval approved → returns undefined', async () => {
    const runtime = new RecordingApprovalRuntime({ approved: true });
    const hook = buildBeforeToolCall({
      rules: [],
      mode: 'default',
      approvalRuntime: runtime,
      approvalSource: SOUL,
    });
    const result = await hook(makeContext(call('Write', {}), {}), signal);
    expect(result).toBeUndefined();
    expect(runtime.calls).toHaveLength(1);
    expect(runtime.calls[0]?.source).toEqual(SOUL);
  });

  it('ask decision + approval rejected → returns block with feedback', async () => {
    const runtime = new RecordingApprovalRuntime({
      approved: false,
      feedback: 'user said no',
    });
    const hook = buildBeforeToolCall({
      rules: [],
      mode: 'default',
      approvalRuntime: runtime,
      approvalSource: SOUL,
    });
    const result = await hook(makeContext(call('Write', {}), {}), signal);
    expect(result?.block).toBe(true);
    expect(result?.reason).toBe('user said no');
  });

  it('ask decision + approval hangs → timeout kicks in', async () => {
    const runtime = new HangingApprovalRuntime();
    const hook = buildBeforeToolCall({
      rules: [],
      mode: 'default',
      approvalRuntime: runtime,
      approvalSource: SOUL,
      approvalTimeoutMs: 30,
    });
    const result = await hook(makeContext(call('Write', {}), {}), signal);
    expect(runtime.requested).toBe(1);
    expect(result?.block).toBe(true);
    expect(result?.reason).toMatch(/approval timed out/);
  });

  it('rule snapshot is stable — post-construction mutation is ignored', async () => {
    const rules: PermissionRule[] = [
      { decision: 'allow', scope: 'turn-override', pattern: 'Write' },
    ];
    const hook = buildBeforeToolCall({
      rules,
      mode: 'default',
      approvalRuntime: new RecordingApprovalRuntime({ approved: true }),
      approvalSource: SOUL,
    });
    // Caller mutates the array after construction — closure should not see it
    rules.push({ decision: 'deny', scope: 'turn-override', pattern: 'Write' });
    const result = await hook(makeContext(call('Write', {}), {}), signal);
    expect(result).toBeUndefined();
  });

  it('default timeout constant is 300_000 ms (Python #1724 parity)', () => {
    expect(DEFAULT_APPROVAL_TIMEOUT_MS).toBe(300_000);
  });
});
