/**
 * React contexts for the Ink TUI application.
 *
 * The shell is split into smaller subscription domains so high-frequency
 * streaming updates do not force the bottom chrome to re-render.
 */

import React, { createContext, useContext } from 'react';

import type { Theme } from '../config/schema.js';
import type { ThemeStyles } from '../theme/styles.js';
import type { SlashCommandRegistry } from '../slash/registry.js';
import type {
  WireClient,
  ApprovalRequestData,
  ApprovalResponseData,
  QuestionRequestData,
} from '../wire/index.js';
import type { SessionInfo } from '../wire/methods.js';

// ── AppState ─────────────────────────────────────────────────────────

export interface AppState {
  /** Active model name. */
  model: string;
  /** Working directory path. */
  workDir: string;
  /** Current session ID. */
  sessionId: string;
  /** Whether yolo (auto-approve) mode is active. */
  yolo: boolean;
  /** Whether plan mode is active. */
  planMode: boolean;
  /** Whether extended thinking is enabled. */
  thinking: boolean;
  /** Context usage ratio (0-1) from the last status.update. */
  contextUsage: number;
  /** Current context token count. */
  contextTokens: number;
  /** Model's max context window size in tokens. */
  maxContextTokens: number;
  /** Whether an assistant turn is currently streaming. */
  isStreaming: boolean;
  /** Current streaming phase: 'idle' | 'waiting' | 'thinking' | 'composing'. */
  streamingPhase: 'idle' | 'waiting' | 'thinking' | 'composing';
  /** Timestamp (ms) when the current content block started. */
  streamingStartTime: number;
  /** Color theme. */
  theme: Theme;
  /** Application version string. */
  version: string;
}

// ── Transcript / Tool Types ──────────────────────────────────────────

export interface ToolCallBlockData {
  /** Tool call ID. */
  id: string;
  /** Tool name. */
  name: string;
  /** Parsed arguments object. */
  args: Record<string, unknown>;
  /** Human-readable description. */
  description?: string | undefined;
  /** Tool result (populated when the tool finishes). */
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
  /** Unique identifier for use as a React key in `<Static>`. */
  id: string;
  /** Render kind. */
  kind: TranscriptEntryKind;
  /** Turn identifier when the entry belongs to a turn. */
  turnId?: string | undefined;
  /** Rendering mode for text content. */
  renderMode: 'markdown' | 'plain';
  /** Text content. */
  content: string;
  /** Optional Ink color override for status entries. */
  color?: string | undefined;
  /** Structured tool call payload when kind === 'tool_call'. */
  toolCallData?: ToolCallBlockData | undefined;
}

// ── Pending Approval / Question ─────────────────────────────────────

export interface PendingApproval {
  /** The request message ID (used for respondToRequest). */
  requestId: string;
  /** The approval request data payload. */
  data: ApprovalRequestData;
}

export interface PendingQuestion {
  /** The request message ID (used for respondToRequest). */
  requestId: string;
  /** The question request data payload. */
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

// ── Context values ──────────────────────────────────────────────────

export interface TranscriptContextValue {
  entries: TranscriptEntry[];
}

export interface LiveTurnContextValue {
  pane: LivePaneState;
}

export interface ToastContextValue {
  toasts: ToastNotification[];
}

export interface ChromeContextValue {
  state: AppState;
  setState: (patch: Partial<AppState>) => void;
  wireClient: WireClient;
  styles: ThemeStyles;
  sessions: SessionInfo[];
  loadingSessions: boolean;
  showSessionPicker: boolean;
  registry: SlashCommandRegistry;
}

export interface QueuedMessage {
  readonly id: string;
  readonly text: string;
}

export interface ActionsContextValue {
  appendTranscriptEntry: (entry: TranscriptEntry) => void;
  sendMessage: (input: string) => void;
  cancelStream: () => void;
  handleApprovalResponse: (response: ApprovalResponseData) => void;
  handleQuestionResponse: (answers: string[]) => void;
  dismissToast: (id: string) => void;
  executeSlashCommand: (input: string) => Promise<{ message: string; color?: string } | null>;
  refreshSessions: () => Promise<void>;
  switchSession: (sessionId: string) => void;
  setShowSessionPicker: (show: boolean) => void;
  enqueueMessage: (text: string) => void;
  steerMessage: (text: string) => void;
  removeFromQueue: (id: string) => void;
  editQueueItem: (id: string, text: string) => void;
  recallLastQueued: () => string | undefined;
  dequeueFirst: () => string | undefined;
  queuedMessages: QueuedMessage[];
}

const MISSING_PROVIDER = 'Kimi CLI context provider is missing.';

export const TranscriptContext: React.Context<TranscriptContextValue | null> =
  createContext<TranscriptContextValue | null>(null);
export const LiveTurnContext: React.Context<LiveTurnContextValue | null> =
  createContext<LiveTurnContextValue | null>(null);
export const ToastContext: React.Context<ToastContextValue | null> =
  createContext<ToastContextValue | null>(null);
export const ChromeContext: React.Context<ChromeContextValue | null> =
  createContext<ChromeContextValue | null>(null);
export const ActionsContext: React.Context<ActionsContextValue | null> =
  createContext<ActionsContextValue | null>(null);

function assertContext<T>(value: T | null): T {
  if (value === null) {
    throw new Error(MISSING_PROVIDER);
  }
  return value;
}

export function useTranscript(): TranscriptContextValue {
  return assertContext(useContext(TranscriptContext));
}

export function useLiveTurn(): LiveTurnContextValue {
  return assertContext(useContext(LiveTurnContext));
}

export function useToastState(): ToastContextValue {
  return assertContext(useContext(ToastContext));
}

export function useChrome(): ChromeContextValue {
  return assertContext(useContext(ChromeContext));
}

export function useActions(): ActionsContextValue {
  return assertContext(useContext(ActionsContext));
}
