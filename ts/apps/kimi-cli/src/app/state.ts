/**
 * Application state types.
 *
 * Pure TypeScript interfaces extracted from the former React context layer.
 * No framework dependency — consumed by InteractiveMode and WireHandler.
 */

import type { Theme } from '../config/schema.js';
import type { ModelAlias } from '@moonshot-ai/core';
import type { ThemeStyles } from '../theme/styles.js';
import type {
  WireClient,
  ApprovalRequestData,
  ApprovalResponseData,
  QuestionRequestData,
} from '../wire/index.js';
import type { SessionInfo } from '../wire/methods.js';

// ── AppState ─────────────────────────────────────────────────────────

export interface AppState {
  model: string;
  workDir: string;
  sessionId: string;
  yolo: boolean;
  planMode: boolean;
  thinking: boolean;
  contextUsage: number;
  contextTokens: number;
  maxContextTokens: number;
  isStreaming: boolean;
  streamingPhase: 'idle' | 'waiting' | 'thinking' | 'composing';
  streamingStartTime: number;
  theme: Theme;
  version: string;
  /**
   * External editor command (e.g. `vim`, `code --wait`). Seeded from
   * `config.toml` `default_editor`; overridable via `/editor <cmd>`
   * which persists back to config.toml. Falls through to `$VISUAL` /
   * `$EDITOR` when empty.
   */
  editorCommand: string | null;
  /** All model aliases loaded from config.toml — for /model picker. */
  availableModels: Record<string, ModelAlias>;
}

// ── Transcript / Tool Types ──────────────────────────────────────────

export interface ToolCallBlockData {
  id: string;
  name: string;
  args: Record<string, unknown>;
  description?: string | undefined;
  result?: ToolResultBlockData | undefined;
}

export interface ToolResultBlockData {
  tool_call_id: string;
  output: string;
  is_error?: boolean | undefined;
}

export type TranscriptEntryKind =
  | 'welcome'
  | 'user'
  | 'assistant'
  | 'tool_call'
  | 'thinking'
  | 'status';

export interface TranscriptEntry {
  id: string;
  kind: TranscriptEntryKind;
  turnId?: string | undefined;
  renderMode: 'markdown' | 'plain';
  content: string;
  color?: string | undefined;
  toolCallData?: ToolCallBlockData | undefined;
}

// ── Pending Approval / Question ─────────────────────────────────────

export interface PendingApproval {
  requestId: string;
  data: ApprovalRequestData;
}

export interface PendingQuestion {
  requestId: string;
  data: QuestionRequestData;
}

// ── Toast Notification ──────────────────────────────────────────────

export interface ToastNotification {
  readonly id: string;
  readonly category: string;
  readonly type: string;
  readonly title: string;
  readonly body: string;
  readonly severity: string;
}

// ── Live Pane ───────────────────────────────────────────────────────

export type LivePaneMode =
  | 'idle'
  | 'waiting'
  | 'thinking'
  | 'tool'
  | 'approval'
  | 'question'
  | 'session';

export interface LivePaneState {
  mode: LivePaneMode;
  thinkingText: string;
  assistantText: string;
  pendingToolCall: ToolCallBlockData | null;
  pendingApproval: PendingApproval | null;
  pendingQuestion: PendingQuestion | null;
}

// ── Message Queue ───────────────────────────────────────────────────

export interface QueuedMessage {
  readonly id: string;
  readonly text: string;
}

export const INITIAL_LIVE_PANE: LivePaneState = {
  mode: 'idle',
  thinkingText: '',
  assistantText: '',
  pendingToolCall: null,
  pendingApproval: null,
  pendingQuestion: null,
};
