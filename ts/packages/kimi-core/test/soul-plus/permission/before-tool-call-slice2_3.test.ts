/**
 * Slice 2.3 regression tests for `buildBeforeToolCall`:
 *   - deny path surfaces `rule.reason` in the block message (N2)
 *   - ask path derives an action label via `describeApprovalAction`
 *   - ask path propagates the turnId into ApprovalRequest
 *   - ask path hands the signal through to `approvalRuntime.request`
 */

import { describe, expect, it } from 'vitest';

import type {
  ApprovalRequest,
  ApprovalResponseData,
  ApprovalResult,
  ApprovalRuntime,
} from '../../../src/soul-plus/approval-runtime.js';
import { buildBeforeToolCall } from '../../../src/soul-plus/permission/before-tool-call.js';
import type { PermissionRule } from '../../../src/soul-plus/permission/types.js';
import type { AssistantMessage, BeforeToolCallContext, ToolCall } from '../../../src/soul/index.js';
import type { SoulContextState } from '../../../src/storage/context-state.js';
import type { ApprovalSource } from '../../../src/storage/wire-record.js';

class RecordingApprovalRuntime implements ApprovalRuntime {
  public calls: Array<{ req: ApprovalRequest; signal: AbortSignal | undefined }> = [];
  constructor(private readonly response: ApprovalResult) {}
  async request(req: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalResult> {
    this.calls.push({ req, signal });
    return this.response;
  }
  async recoverPendingOnStartup(): Promise<void> {}
  resolve(_requestId: string, _response: ApprovalResponseData): void {}
  cancelBySource(_source: ApprovalSource): void {}
  async ingestRemoteRequest(): Promise<void> {
    throw new Error('unused');
  }
  resolveRemote(): void {
    throw new Error('unused');
  }
}

function makeCtx(name: string, args: unknown): BeforeToolCallContext {
  return {
    toolCall: { id: `tc_${name}`, name, args } as ToolCall,
    args,
    assistantMessage: {} as unknown as AssistantMessage,
    context: {} as unknown as SoulContextState,
  };
}

const SOUL: ApprovalSource = { kind: 'soul', agent_id: 'agent_main' };

describe('buildBeforeToolCall — Slice 2.3', () => {
  it('deny path threads rule.reason into the block message', async () => {
    const rule: PermissionRule = {
      decision: 'deny',
      scope: 'project',
      pattern: 'Write',
      reason: 'production filesystem is read-only',
    };
    const hook = buildBeforeToolCall({
      rules: [rule],
      mode: 'default',
      approvalRuntime: new RecordingApprovalRuntime({ approved: true }),
      approvalSource: SOUL,
    });
    const result = await hook(makeCtx('Write', { path: '/etc/x' }), new AbortController().signal);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('production filesystem is read-only');
  });

  it('ask path derives action label from the display kind', async () => {
    const runtime = new RecordingApprovalRuntime({ approved: true });
    const hook = buildBeforeToolCall({
      rules: [],
      mode: 'default',
      approvalRuntime: runtime,
      approvalSource: SOUL,
      turnId: 'turn_42',
    });
    await hook(makeCtx('Bash', { command: 'ls' }), new AbortController().signal);
    expect(runtime.calls).toHaveLength(1);
    // ask triggers a generic display (closure builds one), so we land in
    // the tool-name fallback which maps Bash → "run command".
    expect(runtime.calls[0]!.req.action).toBe('run command');
    expect(runtime.calls[0]!.req.turnId).toBe('turn_42');
  });

  it('passes the AbortSignal through to approvalRuntime.request', async () => {
    const runtime = new RecordingApprovalRuntime({ approved: true });
    const hook = buildBeforeToolCall({
      rules: [],
      mode: 'default',
      approvalRuntime: runtime,
      approvalSource: SOUL,
    });
    const controller = new AbortController();
    await hook(makeCtx('Read', { path: '/tmp/x' }), controller.signal);
    expect(runtime.calls[0]!.signal).toBe(controller.signal);
  });

  it('explicit actionLabelOverride wins over derivation', async () => {
    const runtime = new RecordingApprovalRuntime({ approved: true });
    const hook = buildBeforeToolCall({
      rules: [],
      mode: 'default',
      approvalRuntime: runtime,
      approvalSource: SOUL,
      actionLabelOverride: () => 'enterprise approval',
    });
    await hook(makeCtx('Bash', { command: 'ls' }), new AbortController().signal);
    expect(runtime.calls[0]!.req.action).toBe('enterprise approval');
  });
});
