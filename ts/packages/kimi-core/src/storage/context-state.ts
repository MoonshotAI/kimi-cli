import type { ContentPart, Message, ToolCall } from '@moonshot-ai/kosong';

import { NoopJournalWriter, type JournalWriter } from './journal-writer.js';
import { DefaultConversationProjector, type ConversationProjector } from './projector.js';

// ── Payload types for ContextState write methods ───────────────────────

export interface UserInput {
  text: string;
}

export interface AssistantMessagePayload {
  text: string | null;
  think: string | null;
  toolCalls: Array<{ id: string; name: string; args: unknown }>;
  model: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens?: number;
  };
}

export interface ToolResultPayload {
  /**
   * The tool's JSON-serialisable output. `unknown` on purpose — tools may
   * return any JSON value (string / number / object / array / null).
   *
   * NOTE: `undefined` is accepted at the type level for ergonomics (some
   * tools legitimately return `void`), but `appendToolResult()` normalises
   * `undefined` to `null` before persisting. This is load-bearing: without
   * the normalisation, `JSON.stringify({output: undefined})` silently drops
   * the key, so the resulting `tool_result` record is missing the `output`
   * field and the in-memory mirror sees `text: undefined`, both of which
   * corrupt the session on replay.
   */
  output: unknown;
  isError?: boolean | undefined;
  synthetic?: boolean | undefined;
}

/**
 * Discriminated union of all config_change events that flow through
 * `applyConfigChange`. Mirrors the config-class records in §4.3 /
 * appendix B / appendix D.5 — field naming is locked snake_case so that
 * applyConfigChange can project an event directly into a wire record
 * without a casing translation layer.
 */
export type ConfigChangeEvent =
  | { type: 'model_changed'; old_model: string; new_model: string }
  | { type: 'system_prompt_changed'; new_prompt: string }
  | {
      type: 'tools_changed';
      operation: 'register' | 'remove' | 'set_active';
      tools: string[];
    }
  | { type: 'thinking_changed'; level: string }
  | { type: 'plan_mode_changed'; enabled: boolean };

export interface SummaryMessage {
  summary: string;
  compactedRange: {
    fromTurn: number;
    toTurn: number;
    messageCount: number;
  };
  preCompactTokens: number;
  postCompactTokens: number;
  trigger: 'auto' | 'manual';
}

// ── Narrow (Soul) interface ────────────────────────────────────────────

export interface SoulContextState {
  readonly model: string;
  readonly systemPrompt: string;
  readonly activeTools: ReadonlySet<string>;
  readonly tokenCountWithPending: number;

  buildMessages(): Message[];

  /** Drain the steer buffer. Side-effect: empties the buffer. */
  drainSteerMessages(): UserInput[];

  appendAssistantMessage(msg: AssistantMessagePayload): Promise<void>;
  appendToolResult(toolCallId: string, result: ToolResultPayload): Promise<void>;
  addUserMessages(steers: UserInput[]): Promise<void>;
  applyConfigChange(event: ConfigChangeEvent): Promise<void>;
  resetToSummary(summary: SummaryMessage): Promise<void>;
}

// ── Wide (SoulPlus) interface ──────────────────────────────────────────

export interface FullContextState extends SoulContextState {
  /**
   * Append a user message. `turnIdOverride` lets TurnManager explicitly
   * bind the first user_message of a brand-new turn to the freshly
   * allocated `turn_id`, instead of relying on the `currentTurnId()`
   * callback (which is set asynchronously and races the WAL write).
   * Slice 3 audit C1.
   */
  appendUserMessage(input: UserInput, turnIdOverride?: string): Promise<void>;
  appendToolResult(
    toolCallId: string,
    result: ToolResultPayload,
    turnIdOverride?: string,
  ): Promise<void>;

  /** Push a steer into the buffer for the next `drainSteerMessages()` call. */
  pushSteer(input: UserInput): void;
}

// ── Shared implementation ─────────────────────────────────────────────

interface BaseContextStateOptions {
  readonly journalWriter: JournalWriter;
  readonly initialModel: string;
  readonly initialSystemPrompt?: string;
  readonly initialActiveTools?: ReadonlySet<string>;
  readonly currentTurnId: () => string;
  readonly projector?: ConversationProjector;
}

/**
 * Core ContextState logic. Both `WiredContextState` and
 * `InMemoryContextState` are thin wrappers that differ only in the journal
 * writer they supply and the constructor shape they expose.
 *
 * §4.5.3 "WAL-then-mirror" atomicity:
 *   1. build the WireRecord
 *   2. await journalWriter.append(...)
 *   3. on success only, update the in-memory projection
 *
 * If step 2 throws, the in-memory state is unchanged.
 */
class BaseContextState implements FullContextState {
  private readonly journalWriter: JournalWriter;
  private readonly projector: ConversationProjector;
  private readonly currentTurnId: () => string;

  private history: Message[] = [];
  private _systemPrompt: string;
  private _model: string;
  private _activeTools: Set<string>;
  private _tokenCountWithPending = 0;
  private steerBuffer: UserInput[] = [];

  constructor(opts: BaseContextStateOptions) {
    this.journalWriter = opts.journalWriter;
    this.projector = opts.projector ?? new DefaultConversationProjector();
    this.currentTurnId = opts.currentTurnId;
    this._model = opts.initialModel;
    this._systemPrompt = opts.initialSystemPrompt ?? '';
    this._activeTools = new Set(opts.initialActiveTools ?? []);
  }

  // ── Synchronous reads ────────────────────────────────────────────────

  get model(): string {
    return this._model;
  }

  get systemPrompt(): string {
    return this._systemPrompt;
  }

  get activeTools(): ReadonlySet<string> {
    return this._activeTools;
  }

  get tokenCountWithPending(): number {
    return this._tokenCountWithPending;
  }

  buildMessages(): Message[] {
    return this.projector.project(
      {
        history: this.history,
        systemPrompt: this._systemPrompt,
        model: this._model,
        activeTools: this._activeTools,
      },
      [],
      {},
    );
  }

  drainSteerMessages(): UserInput[] {
    const drained = this.steerBuffer;
    this.steerBuffer = [];
    return drained;
  }

  pushSteer(input: UserInput): void {
    this.steerBuffer.push({ ...input });
  }

  // ── Async writes (WAL-then-mirror) ──────────────────────────────────

  async appendUserMessage(input: UserInput, turnIdOverride?: string): Promise<void> {
    // Slice 3 audit C1: the first `user_message` of a brand-new turn must
    // be durable-bound to the turn_id that TurnManager just allocated. The
    // `currentTurnId()` callback is set asynchronously in TurnManager and
    // would otherwise return the previous turn's id (or a placeholder) at
    // the moment this append runs. `turnIdOverride`, when provided, takes
    // precedence; callers inside Soul (steer drain via `addUserMessages`)
    // still fall back to `currentTurnId()` because they run mid-turn.
    const turnId = turnIdOverride ?? this.currentTurnId();
    await this.journalWriter.append({
      type: 'user_message',
      turn_id: turnId,
      content: input.text,
    });
    this.history.push({
      role: 'user',
      content: [{ type: 'text', text: input.text }],
      toolCalls: [],
    });
  }

  async appendAssistantMessage(msg: AssistantMessagePayload): Promise<void> {
    const append: Parameters<JournalWriter['append']>[0] = {
      type: 'assistant_message',
      turn_id: this.currentTurnId(),
      text: msg.text,
      think: msg.think,
      tool_calls: msg.toolCalls,
      model: msg.model,
      ...(msg.usage !== undefined ? { usage: msg.usage } : {}),
    };
    await this.journalWriter.append(append);

    const content: ContentPart[] = [];
    if (msg.think !== null && msg.think.length > 0) {
      content.push({ type: 'think', think: msg.think });
    }
    if (msg.text !== null && msg.text.length > 0) {
      content.push({ type: 'text', text: msg.text });
    }
    const toolCalls: ToolCall[] = msg.toolCalls.map((tc) => ({
      type: 'function',
      id: tc.id,
      function: {
        name: tc.name,
        arguments: tc.args === undefined ? null : JSON.stringify(tc.args),
      },
    }));
    this.history.push({
      role: 'assistant',
      content,
      toolCalls,
    });

    if (msg.usage !== undefined) {
      this._tokenCountWithPending += msg.usage.input_tokens + msg.usage.output_tokens;
    }
  }

  async appendToolResult(
    toolCallId: string,
    result: ToolResultPayload,
    turnIdOverride?: string,
  ): Promise<void> {
    // Normalise `undefined` to `null` BEFORE the record is built. Without
    // this, `JSON.stringify({..., output: undefined})` silently drops the
    // `output` key, producing a `tool_result` row that is missing a
    // contract-required field, and the in-memory mirror below would push
    // `text: undefined` into the history, corrupting any future projection.
    // (Slice 1 audit M3.)
    const normalisedOutput: unknown = result.output === undefined ? null : result.output;

    const turnId = turnIdOverride ?? this.currentTurnId();
    const append: Parameters<JournalWriter['append']>[0] = {
      type: 'tool_result',
      turn_id: turnId,
      tool_call_id: toolCallId,
      output: normalisedOutput,
      ...(result.isError !== undefined ? { is_error: result.isError } : {}),
      ...(result.synthetic !== undefined ? { synthetic: result.synthetic } : {}),
    };
    await this.journalWriter.append(append);

    const text =
      typeof normalisedOutput === 'string' ? normalisedOutput : JSON.stringify(normalisedOutput);
    this.history.push({
      role: 'tool',
      content: [{ type: 'text', text }],
      toolCalls: [],
      toolCallId,
    });
  }

  async addUserMessages(steers: UserInput[]): Promise<void> {
    for (const steer of steers) {
      await this.appendUserMessage(steer);
    }
  }

  async applyConfigChange(event: ConfigChangeEvent): Promise<void> {
    switch (event.type) {
      case 'system_prompt_changed': {
        await this.journalWriter.append({
          type: 'system_prompt_changed',
          new_prompt: event.new_prompt,
        });
        this._systemPrompt = event.new_prompt;
        return;
      }
      case 'model_changed': {
        await this.journalWriter.append({
          type: 'model_changed',
          old_model: event.old_model,
          new_model: event.new_model,
        });
        this._model = event.new_model;
        return;
      }
      // thinking level is not mirrored in ContextState memory — it's a
      // Runtime hint consumed by Kosong at LLM call time, not a transcript
      // field. We only persist the audit row.
      case 'thinking_changed': {
        await this.journalWriter.append({
          type: 'thinking_changed',
          level: event.level,
        });
        return;
      }
      // plan_mode is a Runtime / SoulPlus flag too — Slice 8 will wire the
      // mirroring; Slice 1 only persists the audit row.
      case 'plan_mode_changed': {
        await this.journalWriter.append({
          type: 'plan_mode_changed',
          enabled: event.enabled,
        });
        return;
      }
      case 'tools_changed': {
        await this.journalWriter.append({
          type: 'tools_changed',
          operation: event.operation,
          tools: event.tools,
        });
        if (event.operation === 'set_active') {
          this._activeTools = new Set(event.tools);
        } else if (event.operation === 'register') {
          for (const t of event.tools) this._activeTools.add(t);
        } else if (event.operation === 'remove') {
          for (const t of event.tools) this._activeTools.delete(t);
        }
        // Fallthrough to end of function — oxlint flags an explicit `return;`
        // as useless here. The exhaustive-switch return invariant is still
        // enforced by TypeScript's `noFallthroughCasesInSwitch` and the
        // fact that every earlier case ends with `return`.
      }
    }
  }

  async resetToSummary(summary: SummaryMessage): Promise<void> {
    await this.journalWriter.append({
      type: 'compaction',
      summary: summary.summary,
      compacted_range: {
        from_turn: summary.compactedRange.fromTurn,
        to_turn: summary.compactedRange.toTurn,
        message_count: summary.compactedRange.messageCount,
      },
      pre_compact_tokens: summary.preCompactTokens,
      post_compact_tokens: summary.postCompactTokens,
      trigger: summary.trigger,
    });
    // The live projection is replaced with a single synthetic summary
    // message; the full pre-compaction conversation still exists on disk
    // (§4.5.2 resetToSummary contract — actual semantics finalised in
    // Slice 6). Returning an empty history is also allowed by the Slice 1
    // contract, but a synthetic "user: summary" message gives the next
    // turn something to condition on.
    this.history = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: summary.summary }],
        toolCalls: [],
      },
    ];
    this._tokenCountWithPending = summary.postCompactTokens;
  }
}

// ── Public implementations ───────────────────────────────────────────

export interface WiredContextStateOptions {
  readonly journalWriter: JournalWriter;
  readonly initialModel: string;
  readonly initialSystemPrompt?: string;
  readonly initialActiveTools?: ReadonlySet<string>;
  readonly currentTurnId: () => string;
  readonly projector?: ConversationProjector;
}

export class WiredContextState extends BaseContextState {
  constructor(opts: WiredContextStateOptions) {
    super({
      journalWriter: opts.journalWriter,
      initialModel: opts.initialModel,
      ...(opts.initialSystemPrompt !== undefined
        ? { initialSystemPrompt: opts.initialSystemPrompt }
        : {}),
      ...(opts.initialActiveTools !== undefined
        ? { initialActiveTools: opts.initialActiveTools }
        : {}),
      currentTurnId: opts.currentTurnId,
      ...(opts.projector !== undefined ? { projector: opts.projector } : {}),
    });
  }
}

/**
 * Default `turn_id` for `InMemoryContextState` callers that don't pass one
 * in. Embed scenarios don't run a TurnManager, so the value is opaque —
 * it only exists because every persisted record carries a `turn_id`.
 */
export const EMBEDDED_TURN_ID = 'embedded';

export interface InMemoryContextStateOptions {
  readonly initialModel: string;
  readonly initialSystemPrompt?: string;
  readonly initialActiveTools?: ReadonlySet<string>;
  readonly currentTurnId?: () => string;
  readonly projector?: ConversationProjector;
}

export class InMemoryContextState extends BaseContextState {
  constructor(opts: InMemoryContextStateOptions) {
    super({
      journalWriter: new NoopJournalWriter(),
      initialModel: opts.initialModel,
      ...(opts.initialSystemPrompt !== undefined
        ? { initialSystemPrompt: opts.initialSystemPrompt }
        : {}),
      ...(opts.initialActiveTools !== undefined
        ? { initialActiveTools: opts.initialActiveTools }
        : {}),
      currentTurnId: opts.currentTurnId ?? (() => EMBEDDED_TURN_ID),
      ...(opts.projector !== undefined ? { projector: opts.projector } : {}),
    });
  }
}
