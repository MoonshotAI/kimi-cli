/**
 * Runtime — the sole capability surface SoulPlus exposes to Soul (§5.0 rule
 * 6 / §5.1.5 / §5.8).
 *
 * Four fields, no more: `kosong` / `compactionProvider` / `lifecycle` /
 * `journal`. Adding a fifth field is an explicit ADR-level decision — in
 * particular `tools`, `subagentHost`, `clock`, `logger`, `idGenerator` are
 * all intentionally absent and must be injected via `SoulConfig.tools` or
 * tool-constructor dependency injection.
 *
 * The Runtime is the only way Soul reaches the outside world; combined with
 * the import whitelist in §5.0 rule 3, it guarantees the Soul layer cannot
 * accidentally grow a reference to SoulPlus internals.
 */

import type { Message } from '@moonshot-ai/kosong';

import type { AssistantMessage, StopReason, TokenUsage, ToolCall } from './types.js';

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
}

export interface KosongAdapter {
  chat(params: ChatParams): Promise<ChatResponse>;
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
  run(
    messages: Message[],
    signal: AbortSignal,
    options?: CompactionOptions,
  ): Promise<SummaryMessage>;
}

// ── Lifecycle gate (narrow Soul view of §5.8.2) ────────────────────────

/**
 * `transitionTo` exposes exactly three of the five internal lifecycle
 * states to Soul. `idle` / `destroying` are managed by SoulPlus and
 * intentionally invisible at this layer.
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

export interface JournalCapability {
  rotate(boundaryRecord: CompactionBoundaryRecord): Promise<void>;
}

// ── Runtime container ──────────────────────────────────────────────────

export interface Runtime {
  kosong: KosongAdapter;
  compactionProvider: CompactionProvider;
  lifecycle: LifecycleGate;
  journal: JournalCapability;
}
