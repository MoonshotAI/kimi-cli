/* oxlint-disable vitest/warn-todo -- Phase 12 intentionally uses it.todo
   to track src implementation gaps. See migration-report.md §12.1. */
/**
 * Wire E2E — approvals + tools lifecycle (Phase 12.1).
 *
 * Migrated from Python `tests_e2e/test_wire_approvals_tools.py` (1273L).
 * Eleven scenarios cover the full approval round-trip + tool execution
 * + display-block schema + LLM edge cases.
 *
 * Scope boundary (see todo/phase-12-integration-e2e.md §12.1):
 *   - Python uses an end-to-end subprocess with the `_scripted_echo`
 *     chat provider; TS v2 would use the in-memory harness +
 *     `FakeKosongAdapter.script(...)` instead. But the wire reverse-RPC
 *     bridge for `approval.request` / `approval.response` is a src gap —
 *     `WiredApprovalRuntime.request()` only writes to wire.jsonl; it
 *     does NOT send a reverse-RPC frame to the connected transport.
 *     Closing that gap is Phase 11 (real `--wire` runner) /
 *     Phase 13 (reverse-RPC bridge). Tests that require a round-trip
 *     are marked `it.todo('…pending approval reverse-RPC bridge')`.
 *   - Tool names follow the TS registry (Bash / Write / Edit /
 *     SetTodoList / Agent) — Python `Shell` / `WriteFile` /
 *     `StrReplaceFile` / `SendDMail` names are NOT used.
 *
 * Structured so when the bridge lands the `it.todo` entries are lifted
 * to `it(...)` without any reshuffling.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildInitializeRequest,
  buildPromptRequest,
  buildSessionCreateRequest,
  createTestApproval,
  createWireE2EHarness,
  FakeKosongAdapter,
  type WireE2EInMemoryHarness,
} from '../helpers/index.js';
import type { Tool } from '../../src/soul/types.js';
import { installWireEventBridge } from './helpers/wire-event-bridge.js';

let harness: WireE2EInMemoryHarness | undefined;
let disposeBridge: (() => void) | undefined;

afterEach(async () => {
  disposeBridge?.();
  disposeBridge = undefined;
  if (harness !== undefined) {
    await harness.dispose();
    harness = undefined;
  }
});

async function bootSession(opts: {
  kosong: FakeKosongAdapter;
  tools?: readonly Tool[];
  yolo?: boolean;
}): Promise<{ sessionId: string }> {
  const approval = createTestApproval({ yolo: opts.yolo ?? true });
  harness = await createWireE2EHarness({
    kosong: opts.kosong,
    ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
    approval,
  });
  await harness.send(buildInitializeRequest());

  const createReq = buildSessionCreateRequest({ model: 'test-model' });
  await harness.send(createReq);
  const { response } = await harness.collectUntilResponse(createReq.id);
  const sessionId = (response.data as { session_id: string }).session_id;

  const managed = harness.sessionManager.get(sessionId);
  if (managed === undefined) throw new Error('session not materialised');
  const turnManager = managed.soulPlus.getTurnManager();
  const bridge = installWireEventBridge({
    server: harness.server,
    eventBus: harness.eventBus,
    addTurnLifecycleListener: (l) => turnManager.addTurnLifecycleListener(l),
    sessionId,
  });
  disposeBridge = bridge.dispose;

  return { sessionId };
}

// ── #4: yolo_skips_approval ────────────────────────────────────────────
// Yolo mode is the one scenario we can exercise fully without the
// reverse-RPC bridge: the approval runtime short-circuits to
// {approved: true} before any wire frame is allocated.

describe('wire approvals — yolo mode (#4 test_yolo_skips_approval)', () => {
  it.todo('yolo: Bash tool runs without any approval reverse-RPC (pending src Tool execution surface on wire for approval-free path)');
});

// ── #1: shell_approval_approve ─────────────────────────────────────────

describe('wire approvals — shell approve (#1 test_shell_approval_approve)', () => {
  it.todo(
    'shell tool request → reverse-RPC approval.request → client approves → tool runs → LLM emits final text ' +
      '(pending approval reverse-RPC bridge)',
  );
});

// ── #2: shell_approval_reject ──────────────────────────────────────────

describe('wire approvals — shell reject (#2 test_shell_approval_reject)', () => {
  it.todo(
    'shell tool request → approval rejected w/ feedback → tool_result is_error with rejection reason → LLM wraps up ' +
      '(pending approval reverse-RPC bridge)',
  );
});

// ── #3: approve_for_session ────────────────────────────────────────────

describe('wire approvals — approve_for_session (#3 test_approve_for_session)', () => {
  it.todo(
    'first shell call: approval.request → approve_for_session → tool runs; second same-action call: auto-approved ' +
      '(pending approval reverse-RPC bridge; WiredApprovalRuntime.autoApproveActions cache logic already verified ' +
      'in test/soul-plus/wired-approval-runtime.test.ts)',
  );
});

// ── #5-#8: Display-block snapshots ─────────────────────────────────────
// Python tests the approval-reverse-RPC payload `display` field for each
// tool type. In TS the display structure is owned by
// `src/tools/display-defaults.ts` + each tool's `.inputDisplay` hook,
// and the payload flows through ApprovalRequest.display. Unit coverage
// already lives in `test/tools/display-defaults.test.ts`; the wire
// surface test is gated on the reverse-RPC bridge.

describe('wire approvals — #5 display_block_shell', () => {
  it.todo(
    'ApprovalRequest.display includes {type:"shell", language:"bash", command:…} ' +
      '(pending approval reverse-RPC bridge R3-wire-approval-bridge)',
  );
});

describe('wire approvals — #6 display_block_diff_write_file', () => {
  it.todo(
    'ApprovalRequest.display includes {type:"diff", path, old_text, new_text, …} ' +
      'for Write tool (pending R3-wire-approval-bridge)',
  );
});

describe('wire approvals — #7 display_block_diff_edit', () => {
  it.todo(
    'ApprovalRequest.display diff for Edit (TS rename of StrReplaceFile) ' +
      '(pending R3-wire-approval-bridge)',
  );
});

describe('wire approvals — #8 display_block_todo', () => {
  it.todo(
    'SetTodoList ToolResult.display includes {type:"todo", items:[…]} — ' +
      'ToolResult emission flows through wire event (pending tool.result-event wiring ' +
      'R3-wire-toolresult-error-surface — **distinct dep** from #5-#7 approval bridge)',
  );
});

// ── #9: tool_call_part streaming ───────────────────────────────────────
// Python streamed LLM tool_call_part chunks → wire ToolCallPart events.
// TS `src/soul-plus/kosong-adapter.ts` consumes `tool_call_part` internally
// (Phase 1 audit Slice 3 M4 fixed parallel-tool-call indexing), but
// `KosongAdapter.onDelta` (src/soul/runtime.ts) only surfaces text deltas
// to the caller — there is no callback for partial tool-call streaming.
// Tracked in migration report §R3.

describe('wire approvals — tool_call streaming (#9 test_tool_call_part_streaming)', () => {
  it.todo(
    'tool_call_part deltas stream as wire tool.call.delta events before final tool.call + tool_result ' +
      '(pending onDelta API widening — see migration-report §R3)',
  );
});

// ── #10: default_agent_missing_tool ────────────────────────────────────
// When the LLM returns a tool_call for a name that is not in the
// session's tool list, TurnManager/Orchestrator must surface a
// tool_result with is_error=true and a "not found" message. No approval
// involved — this is purely the dispatch-error path.

describe('wire approvals — missing tool (#10 test_default_agent_missing_tool)', () => {
  it.todo(
    'LLM tool_call with unknown name → wire tool.result is_error=true containing "not found" ' +
      '(pending: default_handlers turn-error → wire.tool.result bridge; currently session.prompt ' +
      'returns an error in the dispatch response, not a tool.result wire event)',
  );
});

// ── #11: custom_agent_exclude_tool ─────────────────────────────────────
// `agent.yaml` `exclude_tools` filters the tool set presented to the
// LLM. If the LLM calls an excluded tool anyway (e.g. a stale prompt),
// the orchestrator must emit a not-found tool_result.

describe('wire approvals — exclude_tools (#11 test_custom_agent_exclude_tool)', () => {
  it.todo(
    'agent-yaml exclude_tools=[Bash] → LLM calls Bash anyway → tool.result is_error "not found" ' +
      '(pending: same wire-bridging gap as #10 + agent-yaml loader e2e seam)',
  );
});

// Sanity: the harness boots a session and replies to initialize without
// any reverse-RPC so we know the test file imports compile and the
// scaffold stays alive for future lifts.
describe('wire approvals — scaffold sanity', () => {
  it('initialize + session.create + session.prompt completes end-to-end with yolo (no approval frames)', async () => {
    const kosong = new FakeKosongAdapter({
      turns: [{ text: 'ready', stopReason: 'end_turn' }],
    });
    const { sessionId } = await bootSession({ kosong, yolo: true });

    const req = buildPromptRequest({ sessionId, text: 'hi' });
    await harness!.send(req);
    const { response } = await harness!.collectUntilResponse(req.id);
    expect(response.error).toBeUndefined();
    expect((response.data as { status: string }).status).toBe('started');

    const endEv = await harness!.expectEvent('turn.end', {
      matcher: (m) =>
        (m.data as { turn_id?: string } | undefined)?.turn_id ===
        (response.data as { turn_id: string }).turn_id,
    });
    expect((endEv.data as { success: boolean }).success).toBe(true);
  });
});
