/**
 * Runtime — the sole capability surface SoulPlus exposes to Soul (§5.0 rule
 * 6 / §5.1.5 / §5.8).
 *
 * Phase 2 (todo/phase-2-compaction-out-of-soul.md): Runtime collapsed to
 * a single field, `kosong`. The previous 4-field shape (kosong /
 * compactionProvider / lifecycle / journal) was Soul driving compaction
 * through three SoulPlus-owned capabilities — that violated 铁律 7.
 *
 * Compaction is now orchestrated by `TurnManager.executeCompaction`; Soul
 * only reports `TurnResult.stopReason='needs_compaction'` when the
 * threshold gate fires. The `CompactionProvider` / `LifecycleGate` /
 * `JournalCapability` interfaces below are retained as exported types so
 * `TurnManagerDeps` and tests can reference them, but they are no longer
 * members of `Runtime`.
 *
 * Adding any field beyond `kosong` is an explicit ADR-level decision — in
 * particular `tools`, `subagentHost`, `clock`, `logger`, `idGenerator` are
 * all intentionally absent and must be injected via `SoulConfig.tools` or
 * tool-constructor dependency injection.
 *
 * The Runtime is the only way Soul reaches the outside world; combined with
 * the import whitelist in §5.0 rule 3, it guarantees the Soul layer cannot
 * accidentally grow a reference to SoulPlus internals.
 */

import type { Message, ModelCapability } from '@moonshot-ai/kosong';

import type { AssistantMessage, StopReason, TokenUsage, ToolCall, ToolResult } from './types.js';

// ── LLM adapter ────────────────────────────────────────────────────────

/**
 * v2 §附录 D.6 — the tool shape submitted to the LLM. Provider-neutral;
 * `input_schema` is a JSON Schema object (or an equivalent plain shape)
 * produced from each tool's Zod input schema.
 */
export interface LLMToolDefinition {
  name: string;
  description: string;
  input_schema: unknown;
}

/**
 * Phase 17 §B.6 — structured onDelta payload for incremental
 * tool_use streaming. Providers that chunk tool arguments forward
 * each chunk through this shape; providers that deliver a complete
 * tool call in a single frame emit one consolidated event right
 * before the assistant message.
 */
export interface ToolCallPartDelta {
  readonly type: 'tool_call_part';
  readonly tool_call_id: string;
  readonly name?: string | undefined;
  readonly arguments_chunk?: string | undefined;
}

export interface ChatParams {
  messages: Message[];
  tools: LLMToolDefinition[];
  /**
   * Caller-requested model alias. Per Slice 2.1 coordinator Q1 decision B,
   * this field is retained on the wire for UI display / transcript-shaping
   * purposes but is **not** used by KosongAdapter to select a provider.
   * Per-call provider selection would require a provider factory, which is
   * out of scope for the current slice — adapters bind a single provider at
   * construction time and read the real model name back via
   * {@link ChatResponse.actualModel}.
   */
  model: string;
  systemPrompt: string;
  effort?: string | undefined;
  signal: AbortSignal;
  onDelta?: ((delta: string) => void) | undefined;
  onThinkDelta?: ((delta: string) => void) | undefined;
  /**
   * Phase 17 §B.6 — incremental tool_use streaming seam. KosongAdapter
   * fires one event per tool_call (fallback: a single consolidated
   * part per finished tool_call — providers that chunk forward each
   * chunk individually). Routed by run-turn.ts into SoulEvent
   * `tool_call_part` and onward through the wire event-bridge.
   */
  onToolCallPart?: ((part: ToolCallPartDelta) => void) | undefined;
  /**
   * Slice 5 / 决策 #97 — fired by streaming wrappers as each tool_use
   * block finishes streaming so the orchestrator can prefetch ahead of
   * the assistant message completing. Phase 5 callers do not set this.
   */
  onToolCallReady?: ((toolCall: ToolCall) => void) | undefined;
  /**
   * Slice 5 / 决策 #96 L3 — caller-known context window in tokens used
   * by `KosongAdapter.chat` to detect silent overflow (usage breaches
   * the window even though the provider returned successfully). Omitted
   * → silent-overflow detection is skipped.
   */
  contextWindow?: number | undefined;
}

export interface ChatResponse {
  message: AssistantMessage;
  toolCalls: ToolCall[];
  stopReason?: StopReason | undefined;
  usage: TokenUsage;
  /**
   * The real model name used by the provider for this call. KosongAdapter
   * populates this from `provider.modelName` so the transcript can record
   * what was actually invoked, not what was requested (Slice 2.1 Q3). May
   * be absent for test-only adapters that do not bind a concrete provider.
   */
  actualModel?: string | undefined;
  /**
   * Slice 5 / 决策 #97 — when the streaming orchestrator finishes a tool
   * call ahead of Soul reaching it, the result lands here keyed by
   * `ToolCall.id`. Soul checks this map before invoking `tool.execute`
   * and reuses the prefetched result on a hit. Phase 5 default adapters
   * never populate the map (Soul always falls through to execute).
   */
  _prefetchedToolResults?: ReadonlyMap<string, ToolResult> | undefined;
}

export interface KosongAdapter {
  chat(params: ChatParams): Promise<ChatResponse>;
  /**
   * Phase 19 Slice B — declared capabilities for `model` (defaults to the
   * adapter's bound provider). Returns `undefined` when the adapter does
   * not expose a capability matrix (e.g. legacy test mocks); callers
   * treat `undefined` as "no constraint" and skip the gate.
   */
  getCapability?(model?: string): ModelCapability | undefined;
}

// ── Compaction provider ────────────────────────────────────────────────

/**
 * v2 §附录 D.4 — the opaque summary carrier returned from compaction.
 * Slice 2 treats this as a data container; its final shape is reconciled
 * against Slice 1's `SummaryMessage` during Slice 6 (Compaction).
 */
export interface SummaryMessage {
  content: string;
  original_turn_count?: number | undefined;
  original_token_count?: number | undefined;
}

export interface CompactionOptions {
  targetTokens?: number | undefined;
  userInstructions?: string | undefined;
}

export interface CompactionProvider {
  /**
   * Run compaction on the given message history and return a single opaque
   * summary blob (SummaryMessage { content: string }).
   *
   * Contract (决策 #101): if the input `messages` array ends with an
   * **unpaired user message** (one without a following assistant response),
   * the implementation must preserve that user message verbatim in the
   * post-compaction conversation state, as a separate standalone message —
   * not folded / paraphrased / merely mentioned inside the summary text.
   *
   * Rationale: if a user types a short prompt at the tail of a
   * context-overflowing conversation and Soul triggers compaction on step 0,
   * the summary would absorb their prompt and the LLM would see no standalone
   * "pending user message" to respond to, causing the turn to end with no
   * response. TurnManager enforces this contract with a guard after calling
   * `run()` (see TurnManager.executeCompaction — tail user_message guard).
   */
  run(
    messages: Message[],
    signal: AbortSignal,
    options?: CompactionOptions,
  ): Promise<SummaryMessage>;
}

// ── Lifecycle gate (narrow Soul view of §5.8.2) ────────────────────────

/**
 * `transitionTo` exposes exactly three of the five internal lifecycle
 * states. `idle` / `destroying` are managed by SoulPlus and
 * intentionally invisible at this layer.
 *
 * Phase 2: no longer part of the Runtime aggregate — SoulPlus and
 * TurnManager use `SessionLifecycleStateMachine.transitionTo` directly.
 * This interface is retained as an exported type so existing test
 * fixtures and Phase 4 refactors can still reference it.
 */
export interface LifecycleGate {
  transitionTo(state: 'active' | 'compacting' | 'completing'): Promise<void>;
}

// ── Journal capability (physical file rotation for compaction) ─────────

/**
 * Slice 2 placeholder for the CompactionBoundaryRecord shape. The real
 * WireRecord union lives in `src/storage/wire-record.ts`; we re-declare a
 * tiny structural shape here so Soul does not import the wire-record
 * implementation module (import whitelist, §5.0 rule 3). Slice 6
 * Compaction may swap this for a precise structural alias.
 */
export interface CompactionBoundaryRecord {
  type: 'compaction_boundary';
  summary: SummaryMessage;
  parent_file: string;
}

export interface RotateResult {
  /** Basename of the archive file created by rotation (e.g. `wire.1.jsonl`). */
  archiveFile: string;
}

export interface JournalCapability {
  rotate(boundaryRecord: CompactionBoundaryRecord): Promise<RotateResult>;
}

// ── Runtime container ──────────────────────────────────────────────────

export interface Runtime {
  kosong: KosongAdapter;
}
