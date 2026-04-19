/**
 * Phase 25 Stage C — Slice 25c-3 behavioural coverage.
 *
 * Pins the contract ToolCallOrchestrator.buildBeforeToolCall gains when
 * it switches from "Soul owns all tool_call WAL writes" (25c-2) to
 * "orchestrator owns the happy-path tool_call WAL write; Soul reads the
 * generated wireUuid via a shared Map and stamps it onto
 * appendToolResult as parent_uuid" (25c-3).
 *
 * Behavioural matrix (brief §必测行为 A.1-A.10, A.7 dropped):
 *
 *   A.1  Happy path — orchestrator writes appendToolCall when permission
 *        passes and step context is present on btcCtx.
 *   A.2  stepUuid / turnId / stepNumber flow verbatim from btcCtx onto
 *        the appendToolCall record.
 *   A.3  wireUuid is registered into the shared Map under toolCall.id so
 *        Soul can read it back to stamp `parent_uuid` on tool_result.
 *   A.4  Display hooks (getActivityDescription / getUserFacingName /
 *        getInputDisplay) populate the three optional `data.*` fields
 *        when the wrapped tool declares them.
 *   A.5  Display hooks absent → the three optional fields remain unset
 *        on the appendToolCall record (no stamped `undefined`).
 *   A.6  Permission deny (PreToolUse or the permission closure) → NO
 *        appendToolCall is written; the Map stays untouched.
 *   A.7  DROPPED — slice 25c-3 takes contextState off `Deps` and reads
 *        it from `btcCtx.context` (always present by `runSoulTurn`
 *        construction), so the "no contextState" negative case is no
 *        longer reachable. A.8 below already covers the
 *        no-dynamic-context fallback.
 *   A.8  `btcCtx.stepUuid` / `turnId` / `stepNumber` omitted → NO
 *        appendToolCall is written (orchestrator needs dynamic per-step
 *        context; fallback keeps the hook transparent).
 *   A.9  `btcCtx.toolCallByProviderId` omitted → appendToolCall still
 *        fires (WAL row must land) but the orchestrator does NOT throw;
 *        Soul simply won't see a wireUuid for that toolCall.id.
 *   A.10 appendToolCall throw → the Map is not mutated (WAL-then-memory
 *        invariant: in-memory wireUuid registration only after durable
 *        write succeeds).
 *
 * Tests are written pre-implementation — they go red when the
 * orchestrator still assumes 25c-2 "Soul owns tool_call" and turn green
 * once the orchestrator starts writing `appendToolCall` + threading
 * wireUuid through the shared Map.
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { HookEngine } from '../../src/hooks/engine.js';
import type { HookExecutor } from '../../src/hooks/types.js';
import {
  AlwaysAllowApprovalRuntime,
  type ApprovalRuntime,
} from '../../src/soul-plus/approval-runtime.js';
import { ToolCallOrchestrator } from '../../src/soul-plus/orchestrator.js';
import type { PermissionRule } from '../../src/soul-plus/permission/index.js';
import type {
  AssistantMessage,
  BeforeToolCallContext,
  Tool,
  ToolCall,
  ToolDisplayHooks,
} from '../../src/soul/types.js';
import type { SoulContextState } from '../../src/storage/context-state.js';
import type { ApprovalSource } from '../../src/storage/wire-record.js';
import { FakeContextState } from '../soul/fixtures/fake-context-state.js';

// ── Local helpers ────────────────────────────────────────────────────

function makeHookEngine(): HookEngine {
  // No hook executors registered → PreToolUse returns
  // `{blockAction: false, additionalContext: []}` for every call, so the
  // hook pipeline is a pass-through and we isolate permission + 25c-3
  // behaviour.
  const executor: HookExecutor = {
    type: 'command',
    execute: vi.fn(),
  };
  return new HookEngine({
    executors: new Map([['command', executor]]),
  });
}

interface MakeOrchestratorOverrides {
  hookEngine?: HookEngine;
  sessionId?: string | (() => string);
  agentId?: string;
  approvalRuntime?: ApprovalRuntime;
}

function makeOrchestrator(overrides: MakeOrchestratorOverrides = {}): ToolCallOrchestrator {
  return new ToolCallOrchestrator({
    hookEngine: overrides.hookEngine ?? makeHookEngine(),
    sessionId: overrides.sessionId ?? 'sess_25c3',
    agentId: overrides.agentId ?? 'agent_main',
    approvalRuntime: overrides.approvalRuntime ?? new AlwaysAllowApprovalRuntime(),
  });
}

function makeEchoTool(display?: ToolDisplayHooks): Tool {
  const inner: Tool = {
    name: 'echo',
    description: 'test echo',
    inputSchema: z.object({ text: z.string() }),
    execute: vi.fn().mockResolvedValue({ content: 'ok' }),
    ...(display !== undefined ? { display } : {}),
  };
  return inner;
}

function makeToolCall(name = 'echo', args: unknown = { text: 'hi' }): ToolCall {
  return { id: `tc_${name}`, name, args };
}

interface BtcCtxOverrides {
  toolCall?: ToolCall;
  args?: unknown;
  turnId?: string;
  stepNumber?: number;
  stepUuid?: string;
  toolCallByProviderId?: Map<string, string>;
  // Allow tests to omit any of the dynamic fields outright (for A.8 / A.9).
  include?: {
    turnId?: boolean;
    stepNumber?: boolean;
    stepUuid?: boolean;
    toolCallByProviderId?: boolean;
  };
}

function makeBtcCtx(
  contextState: SoulContextState,
  overrides: BtcCtxOverrides = {},
): BeforeToolCallContext {
  const toolCall = overrides.toolCall ?? makeToolCall();
  const args = overrides.args ?? toolCall.args;
  const include = overrides.include ?? {
    turnId: true,
    stepNumber: true,
    stepUuid: true,
    toolCallByProviderId: true,
  };
  const ctx: Partial<BeforeToolCallContext> = {
    toolCall,
    args,
    assistantMessage: {} as AssistantMessage,
    context: contextState,
  };
  if (include.turnId !== false) {
    (ctx as { turnId?: string }).turnId = overrides.turnId ?? 'turn_1';
  }
  if (include.stepNumber !== false) {
    (ctx as { stepNumber?: number }).stepNumber = overrides.stepNumber ?? 1;
  }
  if (include.stepUuid !== false) {
    (ctx as { stepUuid?: string }).stepUuid = overrides.stepUuid ?? 'step-uuid-1';
  }
  if (include.toolCallByProviderId !== false) {
    (ctx as { toolCallByProviderId?: Map<string, string> }).toolCallByProviderId =
      overrides.toolCallByProviderId ?? new Map<string, string>();
  }
  return ctx as BeforeToolCallContext;
}

const BASE_CTX = {
  turnId: 'turn_1',
  permissionRules: [] as readonly PermissionRule[],
  permissionMode: 'default' as const,
  approvalSource: { kind: 'soul', agent_id: 'agent_main' } as ApprovalSource,
};

// ── A.1 Happy path ───────────────────────────────────────────────────

describe('ToolCallOrchestrator.buildBeforeToolCall — 25c-3 appendToolCall write', () => {
  it('A.1 writes appendToolCall when contextState + step context + permission allow all align', async () => {
    const contextState = new FakeContextState();
    const orch = makeOrchestrator();
    orch.wrapTools([makeEchoTool()]);

    const hook = orch.buildBeforeToolCall(BASE_CTX);
    const toolCall = makeToolCall('echo', { text: 'hi' });
    const btcCtx = makeBtcCtx(contextState, { toolCall, args: { text: 'hi' } });

    await hook(btcCtx, new AbortController().signal);

    const rows = contextState.toolCallCalls();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.input.uuid).toBeTruthy();
    expect(typeof row.input.uuid).toBe('string');
    expect(row.input.data.tool_call_id).toBe(toolCall.id);
    expect(row.input.data.tool_name).toBe(toolCall.name);
    expect(row.input.data.args).toEqual({ text: 'hi' });
  });

  it('A.2 forwards stepUuid / turnId / stepNumber from btcCtx onto the tool_call record', async () => {
    const contextState = new FakeContextState();
    const orch = makeOrchestrator();
    orch.wrapTools([makeEchoTool()]);

    const hook = orch.buildBeforeToolCall(BASE_CTX);
    const btcCtx = makeBtcCtx(contextState, {
      turnId: 'turn_xyz',
      stepNumber: 4,
      stepUuid: 'step-abc',
    });

    await hook(btcCtx, new AbortController().signal);

    const row = contextState.toolCallCalls()[0]!;
    expect(row.input.stepUuid).toBe('step-abc');
    expect(row.input.turnId).toBe('turn_xyz');
    expect(row.input.step).toBe(4);
  });

  it('A.3 registers the freshly minted wireUuid into the shared Map under toolCall.id', async () => {
    const contextState = new FakeContextState();
    const orch = makeOrchestrator();
    orch.wrapTools([makeEchoTool()]);

    const hook = orch.buildBeforeToolCall(BASE_CTX);
    const toolCall = makeToolCall('echo', { text: 'hi' });
    const sharedMap = new Map<string, string>();
    const btcCtx = makeBtcCtx(contextState, { toolCall, toolCallByProviderId: sharedMap });

    await hook(btcCtx, new AbortController().signal);

    const row = contextState.toolCallCalls()[0]!;
    expect(sharedMap.size).toBe(1);
    expect(sharedMap.get(toolCall.id)).toBe(row.input.uuid);
  });

  it('A.4 stamps display hint fields when the wrapped tool declares getActivityDescription / getUserFacingName / getInputDisplay', async () => {
    const contextState = new FakeContextState();
    const display: ToolDisplayHooks = {
      getActivityDescription: () => 'echoing',
      getUserFacingName: () => 'Echo',
      getInputDisplay: () => ({ kind: 'generic', summary: 'echo-summary' }),
    };
    const orch = makeOrchestrator();
    orch.wrapTools([makeEchoTool(display)]);

    const hook = orch.buildBeforeToolCall(BASE_CTX);
    const btcCtx = makeBtcCtx(contextState, {
      toolCall: makeToolCall('echo', { text: 'hi' }),
      args: { text: 'hi' },
    });

    await hook(btcCtx, new AbortController().signal);

    const row = contextState.toolCallCalls()[0]!;
    expect(row.input.data.activity_description).toBe('echoing');
    expect(row.input.data.user_facing_name).toBe('Echo');
    expect(row.input.data.input_display).toEqual({ kind: 'generic', summary: 'echo-summary' });
  });

  it('A.5 leaves the three display hint fields unset when the tool has no display hooks', async () => {
    const contextState = new FakeContextState();
    const orch = makeOrchestrator();
    orch.wrapTools([makeEchoTool()]); // no display

    const hook = orch.buildBeforeToolCall(BASE_CTX);
    const btcCtx = makeBtcCtx(contextState);

    await hook(btcCtx, new AbortController().signal);

    const row = contextState.toolCallCalls()[0]!;
    // exactOptionalPropertyTypes contract: missing field, NOT `undefined`
    // value. This pins the same invariant Slice 5 pinned for
    // `wrapSingle` field-forwarding (Blocker 1).
    expect('activity_description' in row.input.data).toBe(false);
    expect('user_facing_name' in row.input.data).toBe(false);
    expect('input_display' in row.input.data).toBe(false);
  });

  it('A.6 does NOT write appendToolCall when the permission closure blocks the call', async () => {
    const contextState = new FakeContextState();
    const denyRules: PermissionRule[] = [
      { decision: 'deny', scope: 'turn-override', pattern: 'echo' },
    ];
    const orch = makeOrchestrator();
    orch.wrapTools([makeEchoTool()]);

    const hook = orch.buildBeforeToolCall({
      ...BASE_CTX,
      permissionRules: denyRules,
    });
    const sharedMap = new Map<string, string>();
    const btcCtx = makeBtcCtx(contextState, { toolCallByProviderId: sharedMap });

    const result = await hook(btcCtx, new AbortController().signal);

    expect(result?.block).toBe(true);
    expect(contextState.toolCallCalls()).toHaveLength(0);
    expect(sharedMap.size).toBe(0);
  });

  it('A.6b does NOT write appendToolCall when a PreToolUse hook blocks the call', async () => {
    // Build a HookEngine whose `command` executor returns {blockAction:true}
    // and register a PreToolUse hook that matches every tool (empty matcher).
    const blockingExecutor: HookExecutor = {
      type: 'command',
      execute: vi.fn().mockResolvedValue({ ok: true, blockAction: true, reason: 'no echoes' }),
    };
    const hookEngine = new HookEngine({
      executors: new Map([['command', blockingExecutor]]),
    });
    hookEngine.register({ event: 'PreToolUse', type: 'command', command: 'block' });

    const contextState = new FakeContextState();
    const orch = makeOrchestrator({ hookEngine });
    orch.wrapTools([makeEchoTool()]);

    const hook = orch.buildBeforeToolCall(BASE_CTX);
    const sharedMap = new Map<string, string>();
    const btcCtx = makeBtcCtx(contextState, { toolCallByProviderId: sharedMap });

    const result = await hook(btcCtx, new AbortController().signal);

    expect(result?.block).toBe(true);
    expect(contextState.toolCallCalls()).toHaveLength(0);
    expect(sharedMap.size).toBe(0);
  });

  it('A.8 does NOT write appendToolCall when btcCtx lacks stepUuid / turnId / stepNumber', async () => {
    const contextState = new FakeContextState();
    const orch = makeOrchestrator();
    orch.wrapTools([makeEchoTool()]);

    const hook = orch.buildBeforeToolCall(BASE_CTX);
    const sharedMap = new Map<string, string>();
    const btcCtx = makeBtcCtx(contextState, {
      toolCallByProviderId: sharedMap,
      include: {
        turnId: false,
        stepNumber: false,
        stepUuid: false,
        toolCallByProviderId: true,
      },
    });

    const result = await hook(btcCtx, new AbortController().signal);

    expect(result).toBeUndefined();
    expect(contextState.toolCallCalls()).toHaveLength(0);
    expect(sharedMap.size).toBe(0);
  });

  it('A.9 still writes appendToolCall when btcCtx.toolCallByProviderId is omitted; the hook does not throw', async () => {
    const contextState = new FakeContextState();
    const orch = makeOrchestrator();
    orch.wrapTools([makeEchoTool()]);

    const hook = orch.buildBeforeToolCall(BASE_CTX);
    const btcCtx = makeBtcCtx(contextState, {
      include: {
        turnId: true,
        stepNumber: true,
        stepUuid: true,
        toolCallByProviderId: false,
      },
    });

    // Must not throw — missing Map is a legal call site (e.g. a caller
    // that chooses not to thread parent uuid back to Soul).
    await expect(hook(btcCtx, new AbortController().signal)).resolves.toBeUndefined();
    expect(contextState.toolCallCalls()).toHaveLength(1);
  });

  it('A.10 does NOT update the Map when appendToolCall throws (WAL-then-memory)', async () => {
    const contextState = new FakeContextState();
    // Patch the recording stub so appendToolCall throws BEFORE the Map
    // set would happen. WAL-then-memory means the in-memory
    // wireUuid registration must not survive a failed durable write.
    contextState.appendToolCall = async (): Promise<void> => {
      throw new Error('WAL down');
    };

    const orch = makeOrchestrator();
    orch.wrapTools([makeEchoTool()]);

    const hook = orch.buildBeforeToolCall(BASE_CTX);
    const sharedMap = new Map<string, string>();
    const btcCtx = makeBtcCtx(contextState, { toolCallByProviderId: sharedMap });

    // The hook surface bubbles the throw — Soul's existing fallback-path
    // catch converts it into the `beforeToolCall hook threw` fallback
    // branch (B.3 of 25c-2).
    await expect(hook(btcCtx, new AbortController().signal)).rejects.toThrow(/WAL down/);
    expect(sharedMap.size).toBe(0);
  });
});

