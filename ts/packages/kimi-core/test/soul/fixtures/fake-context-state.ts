/**
 * Test helper — a `SoulContextState` implementation that records every
 * write call verbatim so tests can assert Soul's exact interaction with
 * the storage layer without depending on Slice 1's projection logic.
 *
 * Reads (`buildMessages` / `drainSteerMessages` / `model` / `activeTools` /
 * ...) are backed by in-memory fields the test can seed directly.
 *
 * Phase 25 Stage C — Slice 25c-2: upgraded so the 4 atomic writers are
 * full recording stubs (not no-ops). Soul's main-loop switch from
 * `appendAssistantMessage` to `appendStepBegin` + `appendContentPart*` +
 * `appendStepEnd` is visible here as a distinct sequence of
 * `FakeContextCall` variants. `appendToolResult` gains a leading
 * `parentUuid: string | undefined` parameter; the recorded call shape
 * reflects that (fallback paths carry a real parent uuid, happy path
 * carries `undefined` until slice 25c-3 wires the orchestrator).
 */

import type { Message } from '@moonshot-ai/kosong';

import type {
  AssistantMessagePayload,
  ConfigChangeEvent,
  ContentPartInput,
  SoulContextState,
  StepBeginInput,
  StepEndInput,
  SummaryMessage,
  ToolCallInput,
  ToolResultPayload,
  UserInput,
} from '../../../src/storage/context-state.js';

export interface FakeContextStateOptions {
  readonly initialModel?: string | undefined;
  readonly initialSystemPrompt?: string | undefined;
  readonly initialActiveTools?: ReadonlySet<string> | undefined;
  readonly initialTokenCountWithPending?: number | undefined;
  /** Messages returned by each successive `buildMessages()` call. */
  readonly buildMessagesReturn?: Message[] | undefined;
  /** Steer messages returned by the *first* `drainSteerMessages()` call; subsequent calls return []. */
  readonly initialSteerBuffer?: UserInput[] | undefined;
}

export type AppendAssistantCall = {
  kind: 'appendAssistantMessage';
  msg: AssistantMessagePayload;
};
export type AppendToolResultCall = {
  kind: 'appendToolResult';
  /**
   * Phase 25 Stage C — slice 25c-2 prepended `parentUuid` to the
   * `appendToolResult` signature. Recorded verbatim so tests can assert
   * the happy-path case (`undefined`) vs the fallback case (string uuid
   * that matches the matching `appendToolCall` record).
   */
  parentUuid: string | undefined;
  toolCallId: string;
  result: ToolResultPayload;
  turnIdOverride: string | undefined;
};
export type AddUserMessagesCall = {
  kind: 'addUserMessages';
  steers: UserInput[];
};
export type ApplyConfigChangeCall = {
  kind: 'applyConfigChange';
  event: ConfigChangeEvent;
};
export type ResetToSummaryCall = {
  kind: 'resetToSummary';
  summary: SummaryMessage;
};
// Phase 25 Stage C — slice 25c-2: recording variants for the 4 atomic
// writers Soul's main loop now drives.
export type AppendStepBeginCall = {
  kind: 'appendStepBegin';
  input: StepBeginInput;
};
export type AppendStepEndCall = {
  kind: 'appendStepEnd';
  input: StepEndInput;
};
export type AppendContentPartCall = {
  kind: 'appendContentPart';
  input: ContentPartInput;
};
export type AppendToolCallCall = {
  kind: 'appendToolCall';
  input: ToolCallInput;
};

export type FakeContextCall =
  | AppendAssistantCall
  | AppendToolResultCall
  | AddUserMessagesCall
  | ApplyConfigChangeCall
  | ResetToSummaryCall
  | AppendStepBeginCall
  | AppendStepEndCall
  | AppendContentPartCall
  | AppendToolCallCall;

/**
 * Phase 2 visibility note:
 *
 * `FakeContextState` declares `implements SoulContextState` but also
 * carries a `resetToSummary` method. This is **intentional** and does
 * NOT contradict the Phase 2 migration (铁律 7):
 *
 *   - T4 (`test/storage/context-state-reset-summary-visibility.test.ts`)
 *     enforces the visibility contract at the *type* level using
 *     `declare const sc: SoulContextState; sc.resetToSummary(...)`
 *     + `@ts-expect-error`. That check is independent of any concrete
 *     class: adding a method to an implementing class does not widen
 *     the interface's own member set.
 *   - T1 (`test/soul/run-turn-compaction-signal.test.ts`) spies on
 *     `resetToSummary` to prove Soul does NOT call it. That assertion
 *     needs the method to exist on the fixture instance, even though
 *     nothing in `runSoulTurn` can reach it through a
 *     `SoulContextState`-typed handle.
 *
 * Put differently: the method is a test-only extension beyond the
 * `SoulContextState` shape. It is kept here because T1's spy needs a
 * target; the Soul-facing visibility contract is owned by T4, not by
 * this fixture's `implements` clause.
 */
export class FakeContextState implements SoulContextState {
  readonly calls: FakeContextCall[] = [];
  beforeStep: (() => void) | undefined = undefined;

  private _model: string;
  private _systemPrompt: string;
  private _activeTools: Set<string>;
  private _tokenCountWithPending: number;
  private _buildMessagesReturn: Message[];
  private _steerBuffer: UserInput[];
  private _drainCount = 0;

  constructor(opts: FakeContextStateOptions = {}) {
    this._model = opts.initialModel ?? 'fake-model';
    this._systemPrompt = opts.initialSystemPrompt ?? 'fake system prompt';
    this._activeTools = new Set(opts.initialActiveTools ?? []);
    this._tokenCountWithPending = opts.initialTokenCountWithPending ?? 0;
    this._buildMessagesReturn = opts.buildMessagesReturn ?? [];
    this._steerBuffer = [...(opts.initialSteerBuffer ?? [])];
  }

  // ── Synchronous reads ─────────────────────────────────────────────

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

  setTokenCountWithPending(v: number): void {
    this._tokenCountWithPending = v;
  }

  setBuildMessagesReturn(messages: Message[]): void {
    this._buildMessagesReturn = messages;
  }

  pushSteer(input: UserInput): void {
    this._steerBuffer.push({ ...input });
  }

  readonly buildMessagesCalls: number[] = [];

  buildMessages(): Message[] {
    this.buildMessagesCalls.push(this.calls.length);
    return this._buildMessagesReturn;
  }

  drainSteerMessages(): UserInput[] {
    this._drainCount += 1;
    if (this._drainCount === 1) {
      const drained = this._steerBuffer;
      this._steerBuffer = [];
      return drained;
    }
    return [];
  }

  get drainCount(): number {
    return this._drainCount;
  }

  // ── Async writes (recorded into `calls`) ──────────────────────────

  async appendAssistantMessage(msg: AssistantMessagePayload): Promise<void> {
    this.calls.push({ kind: 'appendAssistantMessage', msg });
  }

  async appendToolResult(
    parentUuid: string | undefined,
    toolCallId: string,
    result: ToolResultPayload,
    turnIdOverride?: string,
  ): Promise<void> {
    this.calls.push({
      kind: 'appendToolResult',
      parentUuid,
      toolCallId,
      result,
      turnIdOverride,
    });
  }

  async addUserMessages(steers: UserInput[]): Promise<void> {
    this.calls.push({ kind: 'addUserMessages', steers: [...steers] });
  }

  async applyConfigChange(event: ConfigChangeEvent): Promise<void> {
    this.calls.push({ kind: 'applyConfigChange', event });
  }

  async resetToSummary(summary: SummaryMessage): Promise<void> {
    this.calls.push({ kind: 'resetToSummary', summary });
  }

  // Phase 25 Stage C — slice 25c-2 recording stubs. Soul's main loop
  // now drives these; tests assert on the recorded `calls` array in
  // order to pin step begin / content_part / step end sequencing and
  // the fallback-path appendToolCall writes.
  async appendStepBegin(input: StepBeginInput): Promise<void> {
    this.calls.push({ kind: 'appendStepBegin', input });
  }
  async appendStepEnd(input: StepEndInput): Promise<void> {
    this.calls.push({ kind: 'appendStepEnd', input });
  }
  async appendContentPart(input: ContentPartInput): Promise<void> {
    this.calls.push({ kind: 'appendContentPart', input });
  }
  async appendToolCall(input: ToolCallInput): Promise<void> {
    this.calls.push({ kind: 'appendToolCall', input });
  }

  // ── Convenience filters ───────────────────────────────────────────

  assistantCalls(): AppendAssistantCall[] {
    return this.calls.filter((c): c is AppendAssistantCall => c.kind === 'appendAssistantMessage');
  }

  toolResultCalls(): AppendToolResultCall[] {
    return this.calls.filter((c): c is AppendToolResultCall => c.kind === 'appendToolResult');
  }

  addUserMessagesCalls(): AddUserMessagesCall[] {
    return this.calls.filter((c): c is AddUserMessagesCall => c.kind === 'addUserMessages');
  }

  // Phase 25 Stage C — slice 25c-2 atomic-call filters (parallel to
  // `assistantCalls()` / `toolResultCalls()` above).
  stepBeginCalls(): AppendStepBeginCall[] {
    return this.calls.filter((c): c is AppendStepBeginCall => c.kind === 'appendStepBegin');
  }
  stepEndCalls(): AppendStepEndCall[] {
    return this.calls.filter((c): c is AppendStepEndCall => c.kind === 'appendStepEnd');
  }
  contentPartCalls(): AppendContentPartCall[] {
    return this.calls.filter((c): c is AppendContentPartCall => c.kind === 'appendContentPart');
  }
  toolCallCalls(): AppendToolCallCall[] {
    return this.calls.filter((c): c is AppendToolCallCall => c.kind === 'appendToolCall');
  }
}
