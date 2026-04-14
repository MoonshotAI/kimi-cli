import type { ContentPart, ToolCall, ToolCallPart, TokenUsage } from '@moonshot-ai/kosong';

// --- Wire Event Types (Soul → Client, one-way push) ---

export interface TurnBeginEvent {
  type: 'turn.begin';
  turnId: number;
  userInput: string;
  inputKind: 'user' | 'system_trigger';
  triggerSource?: string;
}

export interface TurnEndEvent {
  type: 'turn.end';
  turnId: number;
  /**
   * Why the turn ended. Mirrors {@link TurnResult.stopReason} so integration
   * code can distinguish a successful completion from a forced stop (cancel,
   * error, or hitting `maxStepsPerTurn`).
   */
  reason: 'done' | 'cancelled' | 'error' | 'max_steps';
  success: boolean;
  usage?: TokenUsage;
}

export interface StepBeginEvent {
  type: 'step.begin';
  stepNumber: number;
}

export interface StepEndEvent {
  type: 'step.end';
}

export interface StepInterruptedEvent {
  type: 'step.interrupted';
  error?: string;
}

export interface ContentDeltaEvent {
  type: 'content.delta';
  part: ContentPart;
}

export interface ToolCallEvent {
  type: 'tool.call';
  toolCall: ToolCall;
  description?: string;
}

export interface ToolCallDeltaEvent {
  type: 'tool.call.delta';
  part: ToolCallPart;
}

export interface ToolResultEvent {
  type: 'tool.result';
  toolCallId: string;
  /**
   * Raw tool output forwarded to the client. May be a plain string or a
   * list of {@link ContentPart} values for multimodal tool results (e.g. a
   * tool that returns an image/audio/video URL). Consumers should handle
   * both shapes.
   */
  output: string | ContentPart[];
  isError: boolean;
}

export interface StatusUpdateEvent {
  type: 'status.update';
  contextUsage: number;
  tokenUsage?: TokenUsage;
  planMode: boolean;
  model: string;
}

export interface CompactionBeginEvent {
  type: 'compaction.begin';
}

export interface CompactionEndEvent {
  type: 'compaction.end';
  summary: string;
}

export interface SessionErrorEvent {
  type: 'session.error';
  error: string;
  errorType?:
    | 'rate_limit'
    | 'context_overflow'
    | 'api_error'
    | 'auth_error'
    | 'tool_error'
    | 'internal';
  retryAfterMs?: number;
}

export type WireEvent =
  | TurnBeginEvent
  | TurnEndEvent
  | StepBeginEvent
  | StepEndEvent
  | StepInterruptedEvent
  | ContentDeltaEvent
  | ToolCallEvent
  | ToolCallDeltaEvent
  | ToolResultEvent
  | StatusUpdateEvent
  | CompactionBeginEvent
  | CompactionEndEvent
  | SessionErrorEvent;
