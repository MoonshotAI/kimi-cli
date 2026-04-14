/**
 * Test helper — a `SoulContextState` implementation that records every
 * write call verbatim so tests can assert Soul's exact interaction with
 * the storage layer without depending on Slice 1's projection logic.
 *
 * Reads (`buildMessages` / `drainSteerMessages` / `model` / `activeTools` /
 * ...) are backed by in-memory fields the test can seed directly.
 */

import type { Message } from '@moonshot-ai/kosong';

import type {
  AssistantMessagePayload,
  ConfigChangeEvent,
  SoulContextState,
  SummaryMessage,
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
  toolCallId: string;
  result: ToolResultPayload;
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

export type FakeContextCall =
  | AppendAssistantCall
  | AppendToolResultCall
  | AddUserMessagesCall
  | ApplyConfigChangeCall
  | ResetToSummaryCall;

export class FakeContextState implements SoulContextState {
  readonly calls: FakeContextCall[] = [];

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

  async appendToolResult(toolCallId: string, result: ToolResultPayload): Promise<void> {
    this.calls.push({ kind: 'appendToolResult', toolCallId, result });
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
}
