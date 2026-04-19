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
 * Scan records for assistant_messages whose tool_calls lack matching
 * tool_result records. Returns one entry per dangling tool_call.
 *
 * Phase 25 Stage C — slice 25c-2 transitional scope: recovery only
 * inspects the legacy `assistant_message.tool_calls` path. Atomic
 * `tool_call` records (standalone rows) + `tool_result.parent_uuid`
 * anchoring will be covered by slices 25c-4/5 once the orchestrator
 * emits them; until then, slice 25c-2 keeps Soul's fallback
 * `appendToolCall` row in place but recovery scans the aggregated
 * path only to avoid double-counting during the transition.
 */
export function findDanglingToolCalls(records: readonly WireRecord[]): DanglingToolCall[] {
  const dispatched = new Map<string, { turnId: string; toolName: string }>();
  const resolved = new Set<string>();

  for (const r of records) {
    if (r.type === 'assistant_message') {
      for (const tc of r.tool_calls) {
        dispatched.set(tc.id, { turnId: r.turn_id, toolName: tc.name });
      }
    } else if (r.type === 'tool_result') {
      resolved.add(r.tool_call_id);
    }
  }

  const dangling: DanglingToolCall[] = [];
  for (const [id, info] of dispatched) {
    if (!resolved.has(id)) {
      dangling.push({ turnId: info.turnId, toolCallId: id, toolName: info.toolName });
    }
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
  // Phase 25 Stage C — slice 25c-2: `appendToolResult` gained a leading
  // `parentUuid: string | undefined` argument. Legacy dangling tool_calls
  // come from aggregated `assistant_message.tool_calls` rows that predate
  // the atomic `tool_call` row (25b), so no parent uuid exists — pass
  // `undefined` so the synthetic tool_result row omits `parent_uuid`
  // entirely rather than stamping a bogus value.
  const danglingToolCalls = findDanglingToolCalls(records);
  for (const dtc of danglingToolCalls) {
    await contextState.appendToolResult(
      undefined,
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

  if (danglingApprovals.length > 0) {
    warnings.push(`repaired ${String(danglingApprovals.length)} dangling approval(s)`);
  }
  if (danglingToolCalls.length > 0) {
    warnings.push(`repaired ${String(danglingToolCalls.length)} dangling tool call(s)`);
  }
  if (danglingTurns.length > 0) {
    warnings.push(`repaired ${String(danglingTurns.length)} dangling turn(s)`);
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
