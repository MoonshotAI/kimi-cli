/**
 * Crash Recovery — passive journal repair (§8).
 *
 * Repairs dangling records after a crash so that wire.jsonl is self-consistent
 * and replayable. Does NOT replay, re-execute, or resume any turn.
 *
 * Recovery principle (§8.1):
 *   - On restart, lifecycle is always set to `idle`
 *   - Only durable record gaps are repaired (synthetic records appended)
 *   - No synthetic user_message, no re-running tools, no recovery turn
 *   - Recovery notification goes through UI out-of-band, NOT transcript
 *
 * Record ownership (§8.3):
 *   - dangling approval_request → ApprovalRuntime.recoverPendingOnStartup()
 *   - dangling tool_call (assistant_message with tool_calls, no tool_result) → ContextState
 *   - dangling turn_begin (no turn_end) → SessionJournal
 *
 * Slice 8 scope: types + stub function signatures. Implementer fills the body.
 */

import type { FullContextState } from './context-state.js';
import type { SessionHealth } from './replay.js';
import type { SessionJournal } from './session-journal.js';
import type { WireRecord } from './wire-record.js';

// ── Dangling record descriptors ────────────────────────────────────────

/** A tool_call present in an assistant_message but lacking a tool_result. */
export interface DanglingToolCall {
  readonly turnId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  /**
   * Phase 25 — present when the dangling tool_call came from the atomic
   * `tool_call` record path (legacy assistant_message source → undefined).
   * `repairJournal` uses this to stamp `parent_uuid` on the synthetic
   * tool_result so atomic and legacy syntheses don't collide downstream.
   */
  readonly toolCallUuid?: string | undefined;
}

/** Phase 25 — a step_begin record without a matching step_end. */
export interface DanglingStep {
  readonly stepUuid: string;
  readonly turnId: string;
  readonly step: number;
}

/** Phase 25 — a subagent_spawned record without a matching _completed/_failed. */
export interface DanglingSubagent {
  readonly agentId: string;
  /** Matches `SubagentSpawnedRecord.data.parent_tool_call_id` (required on wire). */
  readonly parentToolCallId: string;
  readonly parentToolCallUuid?: string | undefined;
  readonly spawnedSeq: number;
}

/** A turn_begin present without a matching turn_end. */
export interface DanglingTurn {
  readonly turnId: string;
  readonly agentType: 'main' | 'sub' | 'independent';
}

/** An approval_request present without a matching approval_response. */
export interface DanglingApproval {
  readonly requestId: string;
  readonly turnId: string;
  readonly step: number;
}

// ── Repair result ──────────────────────────────────────────────────────

export interface RepairResult {
  /** Post-repair health. */
  readonly health: SessionHealth;
  /** Number of synthetic records appended during repair. */
  readonly syntheticCount: number;
  /** Human-readable warnings (e.g., tail truncation). */
  readonly warnings: readonly string[];
}

// ── Repair options ─────────────────────────────────────────────────────

export interface RepairOptions {
  readonly records: readonly WireRecord[];
  readonly contextState: FullContextState;
  readonly sessionJournal: SessionJournal;
  /** Current turn ID supplier (used when appending synthetic records). */
  readonly currentTurnId: () => string;
}

// ── Detection helpers (pure, no side effects) ──────────────────────────

/**
 * Scan records for tool_calls that lack matching tool_result records.
 * Covers both the legacy aggregated path (assistant_message.tool_calls,
 * resolved by tool_result.tool_call_id) AND the Phase 25 atomic path
 * (standalone `tool_call` rows, resolved only by
 * tool_result.parent_uuid).
 *
 * Decisions (Coordinator C.6 / C.7 / C.8):
 *   - An atomic `tool_call` is only resolved by a tool_result that
 *     carries `parent_uuid` matching the tool_call uuid. A tool_result
 *     with just `tool_call_id` routes to the legacy matcher.
 *   - When the same `tool_call_id` appears on both sides, the atomic
 *     entry is authoritative and the legacy entry is deduplicated so
 *     the pair is reported once, with `toolCallUuid` populated.
 */
export function findDanglingToolCalls(records: readonly WireRecord[]): DanglingToolCall[] {
  // Legacy path: assistant_message.tool_calls dispatched by toolCallId,
  // resolved by tool_result.tool_call_id.
  const legacyDispatched = new Map<string, { turnId: string; toolName: string }>();
  // Atomic path: tool_call records keyed by wire uuid, resolved by
  // tool_result.parent_uuid matching the wire uuid.
  const atomicDispatched = new Map<
    string,
    { turnId: string; toolName: string; toolCallId: string }
  >();

  const legacyResolved = new Set<string>(); // keyed by tool_call_id
  const atomicResolved = new Set<string>(); // keyed by parent_uuid

  for (const r of records) {
    if (r.type === 'assistant_message') {
      for (const tc of r.tool_calls) {
        legacyDispatched.set(tc.id, { turnId: r.turn_id, toolName: tc.name });
      }
    } else if (r.type === 'tool_call') {
      atomicDispatched.set(r.uuid, {
        turnId: r.turn_id,
        toolName: r.data.tool_name,
        toolCallId: r.data.tool_call_id,
      });
    } else if (r.type === 'tool_result') {
      legacyResolved.add(r.tool_call_id);
      if (r.parent_uuid !== undefined) {
        atomicResolved.add(r.parent_uuid);
      }
    }
  }

  const dangling: DanglingToolCall[] = [];
  const reportedLegacyIds = new Set<string>();

  // Atomic path first (decision C.7: atomic takes priority on dupe id).
  for (const [uuid, info] of atomicDispatched) {
    if (!atomicResolved.has(uuid)) {
      dangling.push({
        turnId: info.turnId,
        toolCallId: info.toolCallId,
        toolName: info.toolName,
        toolCallUuid: uuid,
      });
      reportedLegacyIds.add(info.toolCallId);
    }
  }

  for (const [toolCallId, info] of legacyDispatched) {
    if (reportedLegacyIds.has(toolCallId)) continue;
    if (!legacyResolved.has(toolCallId)) {
      dangling.push({ turnId: info.turnId, toolCallId, toolName: info.toolName });
    }
  }
  return dangling;
}

/**
 * Scan records for `step_begin` rows that lack a matching `step_end`
 * (matched by `uuid`). Detection is set-subtraction so an out-of-order
 * stream (step_end seen before step_begin) still resolves correctly.
 */
export function findDanglingSteps(records: readonly WireRecord[]): DanglingStep[] {
  const begun = new Map<string, { turnId: string; step: number }>();
  const ended = new Set<string>();
  for (const r of records) {
    if (r.type === 'step_begin') {
      begun.set(r.uuid, { turnId: r.turn_id, step: r.step });
    } else if (r.type === 'step_end') {
      ended.add(r.uuid);
    }
  }
  const dangling: DanglingStep[] = [];
  for (const [stepUuid, info] of begun) {
    if (!ended.has(stepUuid)) {
      dangling.push({ stepUuid, turnId: info.turnId, step: info.step });
    }
  }
  return dangling;
}

/**
 * Scan records for `subagent_spawned` rows that lack a matching
 * `subagent_completed` or `subagent_failed` (matched by `agent_id`).
 * A completed/failed row without a matching spawn is ignored — there is
 * no open outcome to close.
 */
export function findDanglingSubagents(records: readonly WireRecord[]): DanglingSubagent[] {
  const spawned = new Map<string, DanglingSubagent>();
  const settled = new Set<string>();
  for (const r of records) {
    if (r.type === 'subagent_spawned') {
      spawned.set(r.data.agent_id, {
        agentId: r.data.agent_id,
        parentToolCallId: r.data.parent_tool_call_id,
        parentToolCallUuid: r.data.parent_tool_call_uuid,
        spawnedSeq: r.seq,
      });
    } else if (r.type === 'subagent_completed' || r.type === 'subagent_failed') {
      settled.add(r.data.agent_id);
    }
  }
  const dangling: DanglingSubagent[] = [];
  for (const [, info] of spawned) {
    if (!settled.has(info.agentId)) dangling.push(info);
  }
  return dangling;
}

/**
 * Scan records for turn_begin records that lack a matching turn_end.
 */
export function findDanglingTurns(records: readonly WireRecord[]): DanglingTurn[] {
  const begun = new Map<string, { agentType: 'main' | 'sub' | 'independent' }>();
  const ended = new Set<string>();

  for (const r of records) {
    if (r.type === 'turn_begin') {
      begun.set(r.turn_id, { agentType: r.agent_type });
    } else if (r.type === 'turn_end') {
      ended.add(r.turn_id);
    }
  }

  const dangling: DanglingTurn[] = [];
  for (const [turnId, info] of begun) {
    if (!ended.has(turnId)) {
      dangling.push({ turnId, agentType: info.agentType });
    }
  }
  return dangling;
}

/**
 * Scan records for approval_request records that lack a matching
 * approval_response.
 */
export function findDanglingApprovals(records: readonly WireRecord[]): DanglingApproval[] {
  const requested = new Map<string, { turnId: string; step: number }>();
  const responded = new Set<string>();

  for (const r of records) {
    if (r.type === 'approval_request') {
      requested.set(r.data.request_id, { turnId: r.turn_id, step: r.step });
    } else if (r.type === 'approval_response') {
      responded.add(r.data.request_id);
    }
  }

  const dangling: DanglingApproval[] = [];
  for (const [requestId, info] of requested) {
    if (!responded.has(requestId)) {
      dangling.push({ requestId, turnId: info.turnId, step: info.step });
    }
  }
  return dangling;
}

// ── Main repair orchestrator ───────────────────────────────────────────

/**
 * Passive journal repair (§8.1 startup sequence step 3).
 *
 * Runs all three repair phases in the correct owner order:
 *   1. ApprovalRuntime: synthetic cancelled approval_response
 *   2. ContextState: synthetic error tool_result
 *   3. SessionJournal: synthetic interrupted turn_end
 *
 * Returns the aggregate repair result. Does NOT modify lifecycle state
 * (caller sets lifecycle to `idle` before calling this).
 */
export async function repairJournal(options: RepairOptions): Promise<RepairResult> {
  const { records, contextState, sessionJournal, currentTurnId } = options;
  let syntheticCount = 0;
  const warnings: string[] = [];

  // Phase 1: repair dangling approvals → synthetic cancelled approval_response
  const danglingApprovals = findDanglingApprovals(records);
  for (const da of danglingApprovals) {
    await sessionJournal.appendApprovalResponse({
      type: 'approval_response',
      turn_id: da.turnId,
      step: da.step,
      data: {
        request_id: da.requestId,
        response: 'cancelled',
        synthetic: true,
      },
    });
    syntheticCount += 1;
  }

  // Phase 2: repair dangling tool_calls → synthetic error tool_result.
  // Phase 25 Stage G — slice 25c-4b: scan covers BOTH legacy aggregated
  // rows and atomic `tool_call` rows. For atomic entries we carry the
  // wire uuid through as `parentUuid` so the synthetic tool_result stamps
  // `parent_uuid` and links the pair in the wire; legacy entries pass
  // `undefined` (the field is omitted entirely).
  const danglingToolCalls = findDanglingToolCalls(records);
  for (const dtc of danglingToolCalls) {
    await contextState.appendToolResult(
      dtc.toolCallUuid,
      dtc.toolCallId,
      {
        output: 'crashed_before_execution',
        isError: true,
        synthetic: true,
      },
      dtc.turnId,
    );
    syntheticCount += 1;
  }

  // Phase 3: repair dangling turns → synthetic interrupted turn_end
  const danglingTurns = findDanglingTurns(records);
  for (const dt of danglingTurns) {
    await sessionJournal.appendTurnEnd({
      type: 'turn_end',
      turn_id: dt.turnId,
      agent_type: dt.agentType,
      success: false,
      reason: 'interrupted',
      synthetic: true,
    });
    syntheticCount += 1;
  }

  // Phase 4: repair dangling steps → synthetic step_end. No usage is
  // attached — the step crashed before the LLM reported token counts.
  const danglingSteps = findDanglingSteps(records);
  for (const ds of danglingSteps) {
    await contextState.appendStepEnd({
      uuid: ds.stepUuid,
      turnId: ds.turnId,
      step: ds.step,
    });
    syntheticCount += 1;
  }

  // Phase 5: repair dangling subagents → synthetic subagent_failed with
  // reason "crashed_before_outcome".
  const danglingSubagents = findDanglingSubagents(records);
  for (const dsa of danglingSubagents) {
    await sessionJournal.appendSubagentFailed({
      type: 'subagent_failed',
      data: {
        agent_id: dsa.agentId,
        parent_tool_call_id: dsa.parentToolCallId,
        error: 'crashed_before_outcome',
      },
    });
    syntheticCount += 1;
  }

  if (danglingApprovals.length > 0) {
    warnings.push(`repaired ${String(danglingApprovals.length)} dangling approval(s)`);
  }
  if (danglingToolCalls.length > 0) {
    warnings.push(`repaired ${String(danglingToolCalls.length)} dangling tool call(s)`);
  }
  if (danglingTurns.length > 0) {
    warnings.push(`repaired ${String(danglingTurns.length)} dangling turn(s)`);
  }
  if (danglingSteps.length > 0) {
    warnings.push(`repaired ${String(danglingSteps.length)} dangling step(s)`);
  }
  if (danglingSubagents.length > 0) {
    warnings.push(`repaired ${String(danglingSubagents.length)} dangling subagent(s)`);
  }

  // Suppress unused-variable lint for currentTurnId — it's available for
  // callers that need it but the current repair phases derive turn_id from
  // the dangling record itself.
  void currentTurnId;

  return {
    health: syntheticCount === 0 ? 'ok' : 'broken',
    syntheticCount,
    warnings,
  };
}
