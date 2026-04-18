/**
 * v2 SoulPlus layer — shared type definitions (Slice 3 scope).
 *
 * The SoulPlus layer is the "session facade" that assembles the Storage
 * foundation (Slice 1) and the Soul pure function (Slice 2) into a working
 * conversation loop. This file centralises the pure data types that flow
 * across the SoulPlus internal DAG — lifecycle, Soul registry keys, turn
 * triggers, and the minimal dispatch envelope.
 *
 * Slice 3 scope note: full wire protocol envelopes / 5-channel routing live
 * in Slice 5. Slice 3 exposes a minimal `DispatchRequest` / `DispatchResponse`
 * discriminated union covering only the three conversation-channel methods
 * (`session.prompt` / `session.cancel` / `session.steer`).
 */

import type { UserInput } from '../soul/index.js';

// ── Lifecycle state machine (§5.8.2 / appendix D.7) ────────────────────

/**
 * Canonical 5-state lifecycle owned by `SessionLifecycleStateMachine`. Only
 * three of these states are exposed to Soul via `Runtime.lifecycle`
 * (`active` / `compacting` / `completing`). `idle` and `destroying` are
 * SoulPlus-internal concerns that Soul has no reason to observe.
 */
export type SessionLifecycleState = 'idle' | 'active' | 'completing' | 'compacting' | 'destroying';

// ── Soul identity (§5.2.3) ─────────────────────────────────────────────

/**
 * `main` is the session's primary Soul. `sub:*` are subagents spawned via
 * AgentTool (Slice 7). `independent:*` are agent-team members (reserved).
 *
 * Slice 3 only creates and manipulates `main`; the `sub:*` / `independent:*`
 * shapes are declared here so Slice 7 can extend the registry without
 * widening a closed union.
 */
export type SoulKey = 'main' | `sub:${string}` | `independent:${string}`;

/**
 * SoulHandle is a lightweight tracker for a running or idle Soul — Soul
 * itself is still a pure function `runSoulTurn`. The handle exists so
 * TurnManager / AgentTool / destroy paths can index into per-Soul state
 * (the AbortController in particular).
 */
export interface SoulHandle {
  readonly key: SoulKey;
  readonly agentId: string;
  readonly abortController: AbortController;
  /**
   * Phase 18 §E.2 — recursion-depth tag used by `SoulRegistry.spawn()`
   * to enforce `MAX_SUBAGENT_DEPTH`. `main` is depth 0; each child
   * subagent is created with `parentDepth + 1` (plumbed through
   * `SoulRegistryDeps.createHandle`'s second argument at construction
   * time — never mutated after the handle is stored).
   */
  readonly agentDepth: number;
}

// ── Turn trigger (§5.2.2) ──────────────────────────────────────────────

/**
 * What kicks off a new Soul turn. `user_prompt` is the Slice 3 happy path;
 * `system_trigger` is reserved for auto-wake scenarios (Slice 7+). Slice 3
 * tests may construct `system_trigger` triggers to cover edge cases but do
 * not exercise the teammate / notification wake paths.
 */
export type TurnTrigger =
  | { kind: 'user_prompt'; input: UserInput }
  | {
      kind: 'system_trigger';
      input: UserInput;
      reason?: string | undefined;
      source?: string | undefined;
    };

// ── Dispatch envelope (Slice 3 minimal) ────────────────────────────────

/**
 * Slice 3 dispatch envelope — covers only the conversation channel
 * (`session.prompt` / `session.cancel` / `session.steer`). Slice 5 will
 * replace this with the full wire protocol `WireMessage` envelope (5
 * channels, ownership, transactional routing, etc.).
 */
export type DispatchRequest =
  | { method: 'session.prompt'; data: { input: UserInput } }
  | { method: 'session.cancel'; data: { turn_id?: string | undefined } }
  | { method: 'session.steer'; data: { input: UserInput } };

/**
 * Slice 3 dispatch response — mirrors the v2 §5.2.2 shape. `started` is the
 * non-blocking confirmation returned immediately by `handlePrompt`; `ok` is
 * the synchronous ack for `cancel` / `steer`; `error` covers unroutable /
 * busy cases.
 */
export type DispatchResponse =
  | { turn_id: string; status: 'started' }
  | { ok: true }
  | { error: string };

// ── SoulPlus configuration (Slice 3 minimal) ───────────────────────────

/**
 * Minimal session-level config passed into the SoulPlus constructor.
 * Slice 3 only carries the bits that are actually needed to assemble the
 * Storage foundation (Slice 1) + the Soul Runtime (Slice 2). Skill
 * detection, permission rules, hook definitions, approval runtime, and
 * team daemon are all intentionally absent.
 */
export interface SoulPlusConfig {
  readonly sessionId: string;
  readonly agentType?: 'main' | 'sub' | 'independent' | undefined;
}
