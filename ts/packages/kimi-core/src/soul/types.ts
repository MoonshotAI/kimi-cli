import type { TokenUsage } from '@moonshot-ai/kosong';

export interface StatusSnapshot {
  contextUsage: number;
  yoloEnabled: boolean;
  planMode: boolean;
  contextTokens: number;
  maxContextTokens: number;
}

export type StepStopReason = 'no_tool_calls' | 'tool_rejected';
export type TurnStopReason = 'done' | 'cancelled' | 'error' | 'max_steps';

export interface TurnResult {
  stopReason: TurnStopReason;
  stepCount: number;
  usage: TokenUsage | null;
}

export interface StepResult {
  stopReason: StepStopReason;
  toolCallCount: number;
}
