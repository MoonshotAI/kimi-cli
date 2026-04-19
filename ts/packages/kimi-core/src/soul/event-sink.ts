/**
 * Soul EventSink — fire-and-forget UI / telemetry channel (§4.6 / §5.0 rule 4).
 *
 * `emit` returns `void`, not `Promise<void>`. This is a type-level rule
 * (§4.6.2): any future change must pass an ADR, otherwise a stray `await`
 * on a listener will silently degrade streaming to a synchronous bottleneck.
 *
 * Listeners must not persist events to wire.jsonl (§5.0 rule 5). Listener
 * errors are caught internally and never propagate back to Soul — a bad
 * listener must not be able to crash the agent loop.
 */

import type { ToolUpdate } from './types.js';

export type SoulEvent =
  | { type: 'step.begin'; step: number }
  | { type: 'step.end'; step: number }
  | { type: 'step.interrupted'; step: number; reason: string }
  | { type: 'content.delta'; delta: string }
  | { type: 'thinking.delta'; delta: string }
  /**
   * Phase 17 §B.6 — incremental tool_use streaming. KosongAdapter
   * emits one variant per fully-assembled tool_call (fallback path
   * when the provider doesn't chunk) or one per chunk when it does.
   * The wire event-bridge translates this into a `content.delta`
   * frame with `type: 'tool_call_part'` on the `ContentDeltaEventData`
   * union.
   */
  | {
      type: 'tool_call_part';
      tool_call_id: string;
      name?: string | undefined;
      arguments_chunk?: string | undefined;
    }
  | {
      type: 'tool.call';
      toolCallId: string;
      name: string;
      args: Record<string, unknown>;
    }
  | { type: 'tool.progress'; toolCallId: string; update: ToolUpdate }
  /**
   * Slice 4.2 — emitted by `runSoulTurn` immediately before every
   * `context.appendToolResult` call, regardless of whether the result
   * comes from a normal `tool.execute` return, a synthetic "tool not
   * found" / "schema parse error" / "beforeToolCall block" branch, or
   * an execute throw. Downstream consumers (TUI bridge) rely on this
   * event to close the `tool.call` → `tool.result` pair without having
   * to wrap each tool's execute.
   */
  | {
      type: 'tool.result';
      toolCallId: string;
      output: string;
      isError?: boolean | undefined;
    }
  | { type: 'compaction.begin' }
  | {
      type: 'compaction.end';
      tokensBefore?: number | undefined;
      tokensAfter?: number | undefined;
    }
  /**
   * Phase 16 / 决策 #113 — SessionMetaService fans out a patch event after
   * each wire-truth write (title / tags / …). Derived-field mutations
   * (turn_count / last_model) MUST NOT emit this event — see §6.13.7 D6.
   */
  | {
      type: 'session_meta.changed';
      data: {
        patch: {
          title?: string | undefined;
          tags?: string[] | undefined;
          description?: string | undefined;
          archived?: boolean | undefined;
          color?: string | undefined;
        };
        source: 'user' | 'auto' | 'system';
      };
    }
  /**
   * Phase 16 — turn lifecycle tick consumed by SessionMetaService to
   * increment the derived `turn_count`. Carried through the EventBus so
   * SessionMetaService can subscribe without a back-channel (铁律 6 —
   * Soul does not learn about sessionMeta).
   */
  | { type: 'turn.end' }
  /**
   * Phase 16 — model change notification consumed by SessionMetaService
   * to derive `last_model`. Emitted alongside the existing
   * `model_changed` wire record.
   */
  | { type: 'model.changed'; data: { new_model: string } }
  /**
   * Phase 17 §A.6 — SoulEvent parity for the `session.error` wire event.
   * Previously TurnManager bypassed the union via `as never`; the cast is
   * gone now that the variant exists explicitly. Emitted by orchestration
   * layers (TurnManager / SoulPlus facades) when a recoverable or terminal
   * error needs to reach the UI/transport as a typed frame. Soul layer
   * itself does not emit this (L7: no cross-component orchestration).
   */
  | {
      type: 'session.error';
      error: string;
      error_type?:
        | 'rate_limit'
        | 'context_overflow'
        | 'api_error'
        | 'auth_error'
        | 'tool_error'
        | 'internal'
        | undefined;
      retry_after_ms?: number | undefined;
      details?: unknown;
    }
  /**
   * Phase 17 §B.7 — HookEngine lifecycle observability. Emitted when a
   * hook matcher fires (triggered) and once each matching hook settles
   * (resolved). Lets the wire event-bridge forward hook runs to clients.
   */
  | {
      type: 'hook.triggered';
      event: string;
      matchers: readonly string[];
      matched_count: number;
    }
  | {
      type: 'hook.resolved';
      hook_id: string;
      outcome: 'ok' | 'error' | 'blocked';
    }
  /**
   * Phase 17 §A.2 / Phase 18 A.14 — transient status snapshot emitted at
   * turn boundaries and on explicit config setters (model / plan_mode /
   * thinking / yolo). Per v2 §3.7 this event is NEVER persisted to
   * wire.jsonl (铁律 W4). The wire bridge forwards it as a `status.update`
   * wire event verbatim. Payload is kept permissive (`unknown` for
   * context/token usage, optional top-level fields) so setter-triggered
   * partial updates (just `plan_mode` / just `model`) and full-snapshot
   * updates (turn-end with context_usage + token_usage) share one union
   * variant.
   */
  | {
      type: 'status.update';
      data: {
        context_usage?: unknown;
        token_usage?: unknown;
        plan_mode?: boolean | undefined;
        model?: string | undefined;
        yolo?: boolean | undefined;
        thinking?: string | undefined;
      };
    }
  /**
   * Phase 21 §A — distinct thinking-level change notification. Emitted
   * by `session.setThinking` after the WAL `thinking_changed` record
   * settles. The wire bridge forwards it as a `thinking.changed` wire
   * event with the bridge's per-session `seq` counter, preventing
   * multiple transient changes from colliding on `seq: 0`.
   */
  | { type: 'thinking.changed'; level: string }
  /**
   * Phase 24 Step 3 — skill lifecycle events. Emitted by SkillInlineWriter
   * (and SkillManager fork path) after the WAL appendSkill* record settles.
   * Fire-and-forget via EventBus; never persisted to wire.jsonl (铁律 L2.1).
   */
  | {
      type: 'skill.invoked';
      data: {
        skill_name: string;
        execution_mode: 'inline' | 'fork';
        original_input: string;
        sub_agent_id?: string | undefined;
        invocation_trigger?: 'user-slash' | 'claude-proactive' | 'nested-skill' | undefined;
        query_depth?: number | undefined;
      };
    }
  | {
      type: 'skill.completed';
      // Inline mode has no explicit completion signal; this variant is reserved
      // for the fork execution path (deferred to a later phase).
      data: {
        skill_name: string;
        execution_mode: 'inline' | 'fork';
        success: boolean;
        error?: string | undefined;
        sub_agent_id?: string | undefined;
        invocation_trigger?: 'user-slash' | 'claude-proactive' | 'nested-skill' | undefined;
        query_depth?: number | undefined;
      };
    }
  /**
   * Phase 24 Step 4 — MCP lifecycle events. Emitted by MCPManager when
   * servers transition through lifecycle states. Never persisted (L2.1).
   */
  | { type: 'mcp.loading'; data: { status: 'loading' | 'loaded' | 'error'; server_name: string; error?: string | undefined } }
  | { type: 'mcp.connected'; data: { server_id: string; capabilities?: unknown; tool_count: number } }
  | { type: 'mcp.disconnected'; data: { server_id: string; reason: string } }
  | { type: 'mcp.error'; data: { server_id: string; error: string; retry_in_ms?: number | undefined } }
  | { type: 'mcp.tools_changed'; data: { server_id: string; added: string[]; removed: string[] } }
  | { type: 'mcp.resources_changed'; data: { server_id: string } }
  | { type: 'mcp.auth_required'; data: { server_id: string; auth_url: string } }
  | { type: 'status.update.mcp_status'; data: { loading: boolean; total: number; connected: number; toolCount: number; servers: ReadonlyArray<{ name: string; status: string; toolCount: number; error?: string | undefined }> } };

export interface EventSink {
  emit(event: SoulEvent): void;
}
