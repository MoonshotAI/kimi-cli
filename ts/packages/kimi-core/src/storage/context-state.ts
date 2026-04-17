import type { ContentPart, Message, ToolCall } from '@moonshot-ai/kosong';

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
  appendToolResult(toolCallId: string, result: ToolResultPayload): Promise<void>;
  addUserMessages(steers: UserInput[]): Promise<void>;
  applyConfigChange(event: ConfigChangeEvent): Promise<void>;
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
  private readonly currentTurnId: () => string;

  private history: Message[] = [];
  private _systemPrompt: string;
  private _model: string;
  private _activeTools: Set<string>;
  private _tokenCountWithPending = 0;
  private steerBuffer: UserInput[] = [];
  /** M3 — pre-step hook wired by TurnManager (see setBeforeStepHook). */
  beforeStep: (() => void) | undefined = undefined;

  constructor(opts: BaseContextStateOptions) {
    this.journalWriter = opts.journalWriter;
    this.projector = opts.projector ?? new DefaultConversationProjector();
    this.currentTurnId = opts.currentTurnId;
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
