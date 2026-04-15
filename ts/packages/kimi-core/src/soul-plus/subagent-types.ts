/**
 * Subagent type definitions (Slice 7 scope, v2 §5.2.3 / §7.2).
 *
 * These types define the host-side subagent lifecycle. They live in
 * `src/soul-plus/` because subagent orchestration is a SoulPlus concern —
 * Soul (the pure function) never sees these types (铁律 3).
 *
 * Key design constraint (CLAUDE.md §7 / v2 §7.2):
 *   `SubagentHost` is NOT part of Runtime. It is injected into `AgentTool`
 *   via constructor injection. `SoulRegistry` is the canonical implementation.
 */

import type { TokenUsage } from '../soul/types.js';
import type { FullContextState } from '../storage/context-state.js';

// ── Subagent 7-state status machine (v2 §7.2 L3031-3048) ─────────────

/**
 * created → running → completed | failed | killed
 *                ↕
 *          awaiting_approval
 *
 * `lost` is set during resume when a previously-running subagent's
 * process is no longer alive.
 */
export type SubagentStatus =
  | 'created'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'killed'
  | 'lost';

// ── SpawnRequest (v2 §5.2.3 L2258-2266) ──────────────────────────────

export interface SpawnRequest {
  parentAgentId: string;
  agentName: string;
  prompt: string;
  contextState?: FullContextState | undefined;
  runInBackground?: boolean | undefined;
  description?: string | undefined;
  model?: string | undefined;
}

// ── AgentResult (v2 附录 E / §7.2) ───────────────────────────────────

/**
 * The result returned when a subagent completes. Foreground callers
 * `await handle.completion` to get this; background callers receive
 * it via a notification event.
 */
export interface AgentResult {
  result: string;
  usage: TokenUsage;
}

// ── SubagentHandle (v2 §5.2.3 L2268-2271) ────────────────────────────

/**
 * Lightweight handle returned by `SubagentHost.spawn()`. The caller
 * can await `completion` (foreground) or detach and let the notification
 * system deliver the result (background).
 */
export interface SubagentHandle {
  readonly agentId: string;
  readonly completion: Promise<AgentResult>;
}

// ── SubagentHost (v2 §7.2 L2973-2975) ────────────────────────────────

/**
 * Host-side interface for spawning subagents. `SoulRegistry` is the
 * canonical implementation (v2 §5.2.3 / §7.2).
 *
 * NOT part of Runtime (CLAUDE.md §7). Injected into `AgentTool` via
 * constructor.
 */
export interface SubagentHost {
  spawn(request: SpawnRequest): Promise<SubagentHandle>;
}

// ── SubagentStateJson (v2 §7.2 L3017-3029) ───────────────────────────

/**
 * Persisted state for each subagent, stored at
 * `sessions/<main>/subagents/<sub_id>/state.json`.
 *
 * `parent_session_id` and `pid` are only in state.json (not in the
 * in-memory SoulRegistry entry) — same-process subagents don't need
 * pid tracking, but the schema must be complete for resume.
 */
export interface SubagentStateJson {
  agent_id: string;
  parent_session_id: string;
  parent_tool_call_id: string;
  status: SubagentStatus;
  description?: string | undefined;
  created_at: number;
  pid?: number | undefined;
}
