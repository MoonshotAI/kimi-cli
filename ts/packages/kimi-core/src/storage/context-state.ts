import type { ContentPart, Message, ToolCall } from '@moonshot-ai/kosong';

import type { EventSink } from '../soul/event-sink.js';
import type { ToolInputDisplay } from '../soul/types.js';
import type { UserInputPart } from '../wire-protocol/types.js';
import { NoopJournalWriter, type JournalWriter } from './journal-writer.js';
import type { NotificationRecord } from './wire-record.js';
import { DefaultConversationProjector, type ConversationProjector } from './projector.js';

// ── Payload types for ContextState write methods ───────────────────────

// Phase 14 §3.5 — `parts` is populated when the wire prompt arrived as a
// multi-modal array (`image_url` / `video_url` / `text`). Legacy callers
// still populate `text` only; consumers that care about multi-modal
// attachments read `parts`.
export interface UserInput {
  text: string;
  parts?: readonly UserInputPart[] | undefined;
}

export interface AssistantMessagePayload {
  text: string | null;
  think: string | null;
  thinkSignature?: string | undefined;
  toolCalls: Array<{ id: string; name: string; args: unknown }>;
  model: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
  };
}

// Phase 25 Stage D — atomic write inputs (additive; legacy
// `appendAssistantMessage` / `appendToolResult` remain in use. Caller
// switchover lands in slice 25c-2).

export interface StepBeginInput {
  uuid: string;
  turnId: string;
  step: number;
}

export interface StepEndInput {
  uuid: string;
  turnId: string;
  step: number;
  usage?:
    | {
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens?: number | undefined;
        cache_write_tokens?: number | undefined;
      }
    | undefined;
  finishReason?: string | undefined;
}

export interface ContentPartInput {
  uuid: string;
  turnId: string;
  step: number;
  stepUuid: string;
  part:
    | { kind: 'text'; text: string }
    | { kind: 'think'; think: string; encrypted?: string | undefined };
}

export interface ToolCallInput {
  uuid: string;
  turnId: string;
  step: number;
  stepUuid: string;
  data: {
    tool_call_id: string;
    tool_name: string;
    args: unknown;
    activity_description?: string | undefined;
    user_facing_name?: string | undefined;
    input_display?: ToolInputDisplay | undefined;
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
  /** Archive file that holds the pre-compaction conversation (M04). */
  archiveFile?: string | undefined;
}

// ── Narrow (Soul) interface ────────────────────────────────────────────

export interface SoulContextState {
  readonly model: string;
  readonly systemPrompt: string;
  readonly activeTools: ReadonlySet<string>;
  readonly tokenCountWithPending: number;

  /**
   * Optional pre-step hook. When set, `runSoulTurn` calls this before
   * each `buildMessages()` so mid-turn notifications can be drained
   * into the ephemeral stash (M3 fix — aligns with Python's per-step
   * `deliver_pending("llm")` semantics). Kept optional so pure-Soul
   * tests and embeddings that don't use TurnManager are unaffected.
   */
  readonly beforeStep?: (() => void) | undefined;

  /**
   * Build the messages that the next LLM call will see. Reads the
   * durable history from memory + drains the one-shot
   * `pendingEphemeralInjections` stash that TurnManager primed at the
   * start of the turn (Slice 2.4). Must remain synchronous and
   * side-effect-free apart from clearing the stash — buildMessages is
   * a nullary pure read from Soul's perspective.
   */
  buildMessages(): Message[];

  /** Drain the steer buffer. Side-effect: empties the buffer. */
  drainSteerMessages(): UserInput[];

  appendAssistantMessage(msg: AssistantMessagePayload): Promise<void>;
  /**
   * Phase 25 Stage C — slice 25c-2 prepends `parentUuid: string | undefined`
   * so the wire `tool_result` row can stamp `parent_uuid` (§A.2) and the
   * replay-projector can reconstruct the tool_call → tool_result link
   * without scanning history for a matching `tool_call_id`. Fallback paths
   * (tool-not-found / zod-parse-fail / beforeToolCall throws) pass the
   * uuid of the `tool_call` row Soul itself just wrote; happy-path writes
   * driven by the orchestrator (25c-3) may pass `undefined` until the
   * parent uuid is threaded through.
   */
  appendToolResult(
    parentUuid: string | undefined,
    toolCallId: string,
    result: ToolResultPayload,
  ): Promise<void>;
  addUserMessages(steers: UserInput[]): Promise<void>;
  applyConfigChange(event: ConfigChangeEvent): Promise<void>;

  // Phase 25 Stage D — atomic writers. Additive relative to
  // `appendAssistantMessage` / `appendToolResult`; production callers
  // land in slice 25c-2.
  appendStepBegin(input: StepBeginInput): Promise<void>;
  appendStepEnd(input: StepEndInput): Promise<void>;
  appendContentPart(input: ContentPartInput): Promise<void>;
  appendToolCall(input: ToolCallInput): Promise<void>;

  /**
   * Phase 25 Stage C — slice 25c-2. Returns the current turn id so Soul's
   * atomic-write seam can stamp `turn_id` onto `step_begin` / `step_end` /
   * `content_part` / `tool_call` rows without reaching into
   * `BaseContextState`'s private callback. Declared optional to keep
   * legacy Soul fixtures (FakeContextState / RecordingContextState) that
   * don't drive a real turn manager compilation-compatible — production
   * callers (BaseContextState) always implement it.
   */
  currentTurnId?(): string;
  // Phase 2: `resetToSummary` moved down to FullContextState. Soul must
  // not have reset power — compaction is orchestrated by TurnManager
  // which uses the FullContextState view.
}

// ── Wide (SoulPlus) interface ──────────────────────────────────────────

export interface FullContextState extends SoulContextState {
  /**
   * Phase 3 (Slice 3) — the `JournalWriter` backing this context state.
   * Exposed on the wide interface only so SoulPlus-layer callers (e.g.
   * `TurnManager.executeCompaction`) can `flush()` the async-batch
   * buffer before a rotation. Soul must not observe this.
   */
  readonly journalWriter: JournalWriter;

  /**
   * Replace the in-memory conversation projection with a synthetic
   * summary message and reset the token counter. Called by
   * `TurnManager.executeCompaction` after the compaction provider
   * produces a summary and `journal.rotate` archives the old wire.jsonl.
   *
   * Phase 2: this was previously declared on `SoulContextState`; it has
   * moved to `FullContextState` so Soul's type view cannot observe
   * compaction state (铁律 7).
   */
  resetToSummary(summary: SummaryMessage): Promise<void>;

  /**
   * Append a user message. `turnIdOverride` lets TurnManager explicitly
   * bind the first user_message of a brand-new turn to the freshly
   * allocated `turn_id`, instead of relying on the `currentTurnId()`
   * callback (which is set asynchronously and races the WAL write).
   * Slice 3 audit C1.
   */
  appendUserMessage(input: UserInput, turnIdOverride?: string): Promise<void>;
  appendToolResult(
    parentUuid: string | undefined,
    toolCallId: string,
    result: ToolResultPayload,
    turnIdOverride?: string,
  ): Promise<void>;

  /** Push a steer into the buffer for the next `drainSteerMessages()` call. */
  pushSteer(input: UserInput): void;

  /**
   * Wire a pre-step hook that `runSoulTurn` calls before each
   * `buildMessages()`. TurnManager uses this to drain mid-turn
   * notifications into ContextState's ephemeral stash (M3).
   */
  setBeforeStepHook(fn: (() => void) | undefined): void;

  /**
   * Read-only view of the raw conversation history. Used by SoulPlus
   * components (e.g. DynamicInjectionManager) for history scanning
   * (dedup) without triggering buildMessages() side effects.
   */
  getHistory(): readonly Message[];

  /**
   * Phase 1 (Decision #89) — durably append a notification to the
   * conversation history. The notification is rendered as a
   * `<notification ...>` XML user message and added to the in-memory
   * history. For WiredContextState, the WAL record is written first
   * (WAL-then-mirror). The notification persists across turns and is
   * visible in every subsequent `buildMessages()` call.
   */
  appendNotification(data: NotificationRecord['data']): Promise<void>;

  /**
   * Phase 1 (Decision #89) — durably append a system reminder to the
   * conversation history. The reminder is rendered as a
   * `<system-reminder>` XML user message and added to the in-memory
   * history. For WiredContextState, the WAL record is written first
   * (WAL-then-mirror). The reminder persists across turns.
   */
  appendSystemReminder(data: { content: string }): Promise<void>;

  /**
   * Slice 20-A — clear the in-memory conversation projection. Writes a
   * durable `context_cleared` wire record FIRST (WAL-then-mirror §4.5.3);
   * on success, resets `history` + `tokenCountWithPending` only.
   *
   * Does NOT touch: model / systemPrompt / activeTools / steerBuffer /
   * beforeStep — those are driven by their own records / runtime hooks.
   * Two successive calls produce two records and both succeed (idempotent).
   */
  clear(): Promise<void>;
}

// ── Shared implementation ─────────────────────────────────────────────

interface BaseContextStateOptions {
  readonly journalWriter: JournalWriter;
  readonly initialModel: string;
  readonly initialSystemPrompt?: string;
  readonly initialActiveTools?: ReadonlySet<string>;
  readonly currentTurnId: () => string;
  readonly projector?: ConversationProjector;
  /**
   * Pre-populated conversation history for session resume. When provided,
   * these messages become the initial in-memory projection WITHOUT being
   * re-written to wire.jsonl. The replay-projector builds this array from
   * the replayed WireRecords.
   */
  readonly initialHistory?: readonly Message[];
  /**
   * Pre-populated token count for session resume. Mirrors the accumulated
   * `tokenCountWithPending` value that ContextState would have reached had
   * all replayed assistant_message records been appended live.
   */
  readonly initialTokenCount?: number;
  /**
   * Phase 16 / 决策 #113 — optional EventSink. When supplied, the
   * `applyConfigChange` model_changed branch emits a transient
   * `{type:'model.changed'}` event after the WAL append so
   * SessionMetaService can derive `last_model`. The emit is
   * fire-and-forget (铁律 4) and happens ONLY after the journal write
   * succeeds (WAL-then-mirror invariant applies to both the in-memory
   * model field and the derived bus event).
   */
  readonly sink?: EventSink;
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
  readonly journalWriter: JournalWriter;
  private readonly projector: ConversationProjector;
  private readonly _currentTurnId: () => string;
  private readonly sink: EventSink | undefined;

  private history: Message[] = [];
  private _systemPrompt: string;
  private _model: string;
  private _activeTools: Set<string>;
  private _tokenCountWithPending = 0;
  private steerBuffer: UserInput[] = [];
  /**
   * Phase 25 Stage D — open step registry for mirror aggregation. Maps a
   * live `step_begin.uuid` to the assistant Message being built in that
   * step. The Message reference is shared with `history[]` so content /
   * tool_call mutations applied here are visible to `buildMessages()`
   * immediately (铁律 4 "内存可见"). Entries are evicted by
   * `appendStepEnd`, after which late parts with the same stepUuid are
   * rejected (D-MSG-ID strict anchoring).
   */
  private openSteps: Map<string, Message> = new Map();
  /** M3 — pre-step hook wired by TurnManager (see setBeforeStepHook). */
  beforeStep: (() => void) | undefined = undefined;

  constructor(opts: BaseContextStateOptions) {
    this.journalWriter = opts.journalWriter;
    this.projector = opts.projector ?? new DefaultConversationProjector();
    this._currentTurnId = opts.currentTurnId;
    this.sink = opts.sink;
    this._model = opts.initialModel;
    this._systemPrompt = opts.initialSystemPrompt ?? '';
    this._activeTools = new Set(opts.initialActiveTools ?? []);
    if (opts.initialHistory !== undefined) {
      this.history = [...opts.initialHistory];
    }
    if (opts.initialTokenCount !== undefined) {
      this._tokenCountWithPending = opts.initialTokenCount;
    }
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

  currentTurnId(): string {
    return this._currentTurnId();
  }

  buildMessages(): Message[] {
    // Phase 1 (Decision #89): notifications and system reminders are
    // now durable entries in history (appendNotification /
    // appendSystemReminder), so there is no ephemeral stash to drain.
    // The projector reads them naturally from the history array.
    return this.projector.project({
      history: this.history,
      systemPrompt: this._systemPrompt,
      model: this._model,
      activeTools: this._activeTools,
    });
  }

  drainSteerMessages(): UserInput[] {
    const drained = this.steerBuffer;
    this.steerBuffer = [];
    return drained;
  }

  pushSteer(input: UserInput): void {
    this.steerBuffer.push({ ...input });
  }

  setBeforeStepHook(fn: (() => void) | undefined): void {
    this.beforeStep = fn;
  }

  getHistory(): readonly Message[] {
    return this.history;
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
    // Phase 14 §3.5 (review BLK-1) — persist the full multi-modal parts
    // array to the WAL so session replay can reconstruct image_url /
    // video_url attachments. The in-memory `history` stays text-only so
    // Soul remains multi-modal-transparent (concatenating text parts is
    // enough for the current LLM prompt shape).
    await this.journalWriter.append({
      type: 'user_message',
      turn_id: turnId,
      content: input.parts !== undefined ? input.parts : input.text,
    });
    // Phase 17 §A.7 — when the wire prompt was multi-modal (parts
    // contain anything other than plain text), preserve the full
    // ContentPart array in history so KosongAdapter forwards the
    // image/video attachments to the underlying provider. Pure-text
    // prompts (and parts that are 100% text) keep the legacy flat
    // single-text shape so nothing downstream regresses.
    const hasNonText =
      input.parts !== undefined && input.parts.some((p) => p.type !== 'text');
    if (hasNonText && input.parts !== undefined) {
      const content: ContentPart[] = [];
      for (const part of input.parts) {
        if (part.type === 'text') {
          content.push({ type: 'text', text: part.text });
        } else if (part.type === 'image_url') {
          content.push({ type: 'image_url', imageUrl: part.image_url });
        } else {
          content.push({ type: 'video_url', videoUrl: part.video_url });
        }
      }
      this.history.push({ role: 'user', content, toolCalls: [] });
    } else {
      const textContent =
        input.parts !== undefined
          ? input.parts
              .filter((p): p is Extract<UserInputPart, { type: 'text' }> => p.type === 'text')
              .map((p) => p.text)
              .join('')
          : input.text;
      this.history.push({
        role: 'user',
        content: [{ type: 'text', text: textContent }],
        toolCalls: [],
      });
    }
  }

  async appendAssistantMessage(msg: AssistantMessagePayload): Promise<void> {
    const append: Parameters<JournalWriter['append']>[0] = {
      type: 'assistant_message',
      turn_id: this.currentTurnId(),
      text: msg.text,
      think: msg.think,
      ...(msg.thinkSignature !== undefined ? { think_signature: msg.thinkSignature } : {}),
      tool_calls: msg.toolCalls,
      model: msg.model,
      ...(msg.usage !== undefined ? { usage: msg.usage } : {}),
    };
    await this.journalWriter.append(append);

    const content: ContentPart[] = [];
    if (msg.think !== null && msg.think.length > 0) {
      const thinkPart: ContentPart = { type: 'think', think: msg.think };
      if (msg.thinkSignature !== undefined) {
        (thinkPart as { encrypted?: string }).encrypted = msg.thinkSignature;
      }
      content.push(thinkPart);
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
    parentUuid: string | undefined,
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
    // `parent_uuid` is spread conditionally so a fallback path that writes
    // `parentUuid: undefined` does NOT stamp `parent_uuid: undefined` onto
    // the WAL row. JSON.stringify would drop the key anyway, but we keep
    // the shape explicit so the "field omitted" contract (§A.2) survives
    // round-trips through any middleware that observes the object before
    // serialisation.
    const append: Parameters<JournalWriter['append']>[0] = {
      type: 'tool_result',
      turn_id: turnId,
      tool_call_id: toolCallId,
      output: normalisedOutput,
      ...(parentUuid !== undefined ? { parent_uuid: parentUuid } : {}),
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

  // ── Phase 25 Stage D — atomic writers (WAL-then-mirror) ─────────────

  async appendStepBegin(input: StepBeginInput): Promise<void> {
    await this.journalWriter.append({
      type: 'step_begin',
      uuid: input.uuid,
      turn_id: input.turnId,
      step: input.step,
    });
    const message: Message = {
      role: 'assistant',
      content: [],
      toolCalls: [],
    };
    this.history.push(message);
    this.openSteps.set(input.uuid, message);
  }

  async appendStepEnd(input: StepEndInput): Promise<void> {
    await this.journalWriter.append({
      type: 'step_end',
      uuid: input.uuid,
      turn_id: input.turnId,
      step: input.step,
      ...(input.usage !== undefined ? { usage: input.usage } : {}),
      ...(input.finishReason !== undefined ? { finish_reason: input.finishReason } : {}),
    });
    this.openSteps.delete(input.uuid);
    if (input.usage !== undefined) {
      this._tokenCountWithPending += input.usage.input_tokens + input.usage.output_tokens;
    }
  }

  async appendContentPart(input: ContentPartInput): Promise<void> {
    // Strict D-MSG-ID: reject orphan BEFORE any WAL write so an orphan
    // row can never land on disk and corrupt replay.
    const openMessage = this.openSteps.get(input.stepUuid);
    if (openMessage === undefined) {
      throw new Error(
        `appendContentPart: unknown stepUuid '${input.stepUuid}' (no open step_begin)`,
      );
    }
    await this.journalWriter.append({
      type: 'content_part',
      uuid: input.uuid,
      turn_id: input.turnId,
      step: input.step,
      step_uuid: input.stepUuid,
      role: 'assistant',
      part:
        input.part.kind === 'text'
          ? { kind: 'text', text: input.part.text }
          : input.part.encrypted !== undefined
            ? { kind: 'think', think: input.part.think, encrypted: input.part.encrypted }
            : { kind: 'think', think: input.part.think },
    });
    if (input.part.kind === 'text') {
      openMessage.content.push({ type: 'text', text: input.part.text });
    } else {
      const thinkPart: ContentPart = { type: 'think', think: input.part.think };
      if (input.part.encrypted !== undefined) {
        (thinkPart as { encrypted?: string }).encrypted = input.part.encrypted;
      }
      openMessage.content.push(thinkPart);
    }
  }

  async appendToolCall(input: ToolCallInput): Promise<void> {
    const openMessage = this.openSteps.get(input.stepUuid);
    if (openMessage === undefined) {
      throw new Error(
        `appendToolCall: unknown stepUuid '${input.stepUuid}' (no open step_begin)`,
      );
    }
    // Strip display-hint keys whose value is `undefined` so the WAL row
    // matches the "no `undefined` keys on the wire" contract (the
    // corresponding tests assert `.toBeUndefined()` on absence, not on
    // an `undefined` value).
    const data: {
      tool_call_id: string;
      tool_name: string;
      args: unknown;
      activity_description?: string | undefined;
      user_facing_name?: string | undefined;
      input_display?: ToolInputDisplay | undefined;
    } = {
      tool_call_id: input.data.tool_call_id,
      tool_name: input.data.tool_name,
      args: input.data.args,
      ...(input.data.activity_description !== undefined
        ? { activity_description: input.data.activity_description }
        : {}),
      ...(input.data.user_facing_name !== undefined
        ? { user_facing_name: input.data.user_facing_name }
        : {}),
      ...(input.data.input_display !== undefined
        ? { input_display: input.data.input_display }
        : {}),
    };
    await this.journalWriter.append({
      type: 'tool_call',
      uuid: input.uuid,
      turn_id: input.turnId,
      step: input.step,
      step_uuid: input.stepUuid,
      data,
    });
    // Normalise undefined args to null — mirrors appendAssistantMessage
    // (L489) so the two write paths produce identical in-memory ToolCall
    // shapes. JSON.stringify(undefined) returns the native `undefined`
    // (not a string), which would violate kosong's
    // `ToolCall.function.arguments: string | null` contract.
    const normalisedArgs =
      input.data.args === undefined ? null : JSON.stringify(input.data.args);
    const toolCall: ToolCall = {
      type: 'function',
      id: input.data.tool_call_id,
      function: {
        name: input.data.tool_name,
        arguments: normalisedArgs,
      },
    };
    openMessage.toolCalls.push(toolCall);
  }

  async addUserMessages(steers: UserInput[]): Promise<void> {
    for (const steer of steers) {
      await this.appendUserMessage(steer);
    }
  }

  async appendNotification(data: NotificationRecord['data']): Promise<void> {
    // WAL write (no-op for InMemoryContextState via NoopJournalWriter)
    await this.journalWriter.append({
      type: 'notification',
      data,
    });
    // Mirror: add as a synthetic user message with <notification> XML
    const text = renderNotificationXml(data);
    this.history.push({
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
    });
  }

  async appendSystemReminder(data: { content: string }): Promise<void> {
    // WAL write (no-op for InMemoryContextState via NoopJournalWriter)
    await this.journalWriter.append({
      type: 'system_reminder',
      content: data.content,
    });
    // Mirror: add as a synthetic user message with <system-reminder> XML
    const text = `<system-reminder>\n${data.content}\n</system-reminder>`;
    this.history.push({
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
    });
  }

  async clear(): Promise<void> {
    // WAL-then-mirror §4.5.3: append the durable record FIRST. If the
    // append throws, the in-memory projection stays intact.
    await this.journalWriter.append({ type: 'context_cleared' });
    this.history = [];
    this._tokenCountWithPending = 0;
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
        // Phase 16 / 决策 #113 — fire-and-forget derived-field bus event
        // so SessionMetaService can update `last_model`. Must happen AFTER
        // the WAL append (WAL-then-mirror §4.5.3). Listener failures
        // cannot propagate back here (铁律 4 — EventSink fire-and-forget).
        this.sink?.emit({
          type: 'model.changed',
          data: { new_model: event.new_model },
        });
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
      ...(summary.archiveFile !== undefined ? { archive_file: summary.archiveFile } : {}),
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

// ── Notification XML rendering (shared with projector.ts) ────────────

/**
 * Render a NotificationData payload as XML. Same format as
 * `projector.ts:renderNotificationXml` — duplicated here to avoid a
 * circular dependency (context-state → projector is one-way).
 */
function renderNotificationXml(data: Record<string, unknown>): string {
  const id = notifStringAttr(data['id'], 'unknown');
  const category = notifStringAttr(data['category'], 'unknown');
  const type = notifStringAttr(data['type'], 'unknown');
  const sourceKind = notifStringAttr(data['source_kind'], 'unknown');
  const sourceId = notifStringAttr(data['source_id'], 'unknown');
  const title = typeof data['title'] === 'string' ? data['title'] : '';
  const severity = typeof data['severity'] === 'string' ? data['severity'] : '';
  const body = typeof data['body'] === 'string' ? data['body'] : '';

  const lines: string[] = [
    `<notification id="${id}" category="${category}" type="${type}" source_kind="${sourceKind}" source_id="${sourceId}">`,
  ];
  if (title.length > 0) lines.push(`Title: ${title}`);
  if (severity.length > 0) lines.push(`Severity: ${severity}`);
  if (body.length > 0) lines.push(body);
  lines.push('</notification>');
  return lines.join('\n');
}

function notifStringAttr(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

// ── Public implementations ───────────────────────────────────────────

export interface WiredContextStateOptions {
  readonly journalWriter: JournalWriter;
  readonly initialModel: string;
  readonly initialSystemPrompt?: string;
  readonly initialActiveTools?: ReadonlySet<string>;
  readonly currentTurnId: () => string;
  readonly projector?: ConversationProjector;
  /** Pre-populated history for session resume (Slice 3.4). */
  readonly initialHistory?: readonly Message[];
  /** Pre-populated token count for session resume (Slice 3.4). */
  readonly initialTokenCount?: number;
  /**
   * Phase 16 / 决策 #113 — optional sink for derived-field events
   * (currently only `model.changed`). Forwards into BaseContextState.
   */
  readonly sink?: EventSink;
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
      ...(opts.initialHistory !== undefined ? { initialHistory: opts.initialHistory } : {}),
      ...(opts.initialTokenCount !== undefined
        ? { initialTokenCount: opts.initialTokenCount }
        : {}),
      ...(opts.sink !== undefined ? { sink: opts.sink } : {}),
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
  /** Pre-populated history for replay / test scenarios. */
  readonly initialHistory?: readonly Message[];
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
      ...(opts.initialHistory !== undefined ? { initialHistory: opts.initialHistory } : {}),
    });
  }
}
