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
 * threshold gate fires.
 *
 * Phase 20 §C.1 (R-3): `CompactionProvider` / `LifecycleGate` /
 * `JournalCapability` — and their supporting types — **no longer live
 * in this file**. They now reside with their SoulPlus owners
 * (`soul-plus/compaction-provider.ts` / `soul-plus/soul-lifecycle-gate.ts`
 * / `soul-plus/journal-capability.ts`). We re-export them below as
 * type-only aliases so the ~59 existing `from '../soul/runtime.js'`
 * imports keep resolving without a repo-wide rename. Re-exports are
 * type-only — TypeScript erases them at emit, so Soul code still
 * cannot reach SoulPlus at runtime (铁律 3 holds).
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

import type {
  Message,
  ModelCapability,
  TextPart as KosongTextPart,
  ThinkPart as KosongThinkPart,
  ToolCall as KosongToolCall,
} from '@moonshot-ai/kosong';

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

/**
 * Phase 25 Stage C — atomic streaming part routed to SoulPlus-layer
 * ContextState writers. `content` covers a completed TextPart / ThinkPart
 * (image / audio / video ContentParts are input-only and never emitted by
 * kosong's output stream, so the union is narrowed to the two output
 * variants). `tool_call` covers a completed ToolCall (args already
 * finalised). Incremental tool_call fragments (ToolCallPart) still flow
 * via `onToolCallPart`; they do NOT trigger `onAtomicPart`.
 *
 * If a future provider ever streams image / audio / video as assistant
 * output, extend this union AND the routing filter in
 * `kosong-adapter.ts` (`runOnce`'s `onMessagePart` handler) so new parts
 * are not silently dropped.
 */
export type AtomicPart =
  | { kind: 'content'; part: KosongTextPart | KosongThinkPart }
  | { kind: 'tool_call'; toolCall: KosongToolCall };

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
   * Phase 25 Stage C — fires on every completed streaming part (finished
   * text / think / tool_call). Additive relative to `onDelta` /
   * `onThinkDelta` / `onToolCallPart`: those still fire as before. Awaited
   * by the adapter so downstream WAL writers can rely on sequential
   * ordering of appends (matches kosong's `await callbacks.onMessagePart(...)`
   * contract).
   */
  onAtomicPart?: ((part: AtomicPart) => Promise<void> | void) | undefined;
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

// ── SoulPlus-owned capabilities — re-exported for backward compat ──────

// Phase 20 §C.1 (R-3) — these types describe SoulPlus-owned capabilities
// (compaction / lifecycle / journal). Their declarations live in the
// soul-plus modules that implement them. We re-export here as type-only
// so the legacy `from '../soul/runtime.js'` imports continue to resolve;
// TypeScript erases the re-export, so Soul's runtime module graph still
// contains no path to SoulPlus (铁律 3 preserved).

export type {
  CompactionOptions,
  CompactionProvider,
  SummaryMessage,
} from '../soul-plus/compaction-provider.js';
export type { LifecycleGate } from '../soul-plus/soul-lifecycle-gate.js';
export type {
  CompactionBoundaryRecord,
  JournalCapability,
  RotateResult,
} from '../soul-plus/journal-capability.js';

// ── Runtime container ──────────────────────────────────────────────────

export interface Runtime {
  kosong: KosongAdapter;
}
