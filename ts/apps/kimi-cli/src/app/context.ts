/**
 * React Context for the Ink TUI application.
 *
 * Provides shared application state and the Wire client to all components
 * in the tree. The context is initialised at the `<App>` level and consumed
 * by hooks and components below it.
 */

import React, { createContext } from 'react';

import type { WireClient, WireMessage, ApprovalRequestData, ApprovalResponseData } from '../wire/index.js';
import type { SessionInfo } from '../wire/methods.js';

import type { Theme } from '../config/schema.js';
import type { ThemeStyles } from '../theme/styles.js';

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
  /** Whether an assistant turn is currently streaming. */
  isStreaming: boolean;
  /** Current streaming phase: 'idle' | 'waiting' (moon spinner) | 'thinking' | 'composing' */
  streamingPhase: 'idle' | 'waiting' | 'thinking' | 'composing';
  /** Timestamp (ms) when the current content block started. */
  streamingStartTime: number;
  /** Color theme. */
  theme: Theme;
  /** Application version string. */
  version: string;
}

// ── CompletedBlock ───────────────────────────────────────────────────

export type CompletedBlockType =
  | 'welcome'
  | 'user'
  | 'assistant'
  | 'tool_call'
  | 'tool_result'
  | 'thinking'
  | 'status';

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

export interface CompletedBlock {
  /** Unique identifier for the block (used as React key in <Static>). */
  id: string;
  /** Discriminant for rendering. */
  type: CompletedBlockType;
  /** Text content of the block. */
  content: string;
  /** Structured tool call data (only for type === 'tool_call'). */
  toolCallData?: ToolCallBlockData | undefined;
  /** Structured tool result data (only for type === 'tool_result'). */
  toolResultData?: ToolResultBlockData | undefined;
}

// ── Pending Approval ────────────────────────────────────────────────

/** An approval request awaiting user response (derived from a WireMessage). */
export interface PendingApproval {
  /** The request message ID (used for respondToRequest). */
  requestId: string;
  /** The approval request data payload. */
  data: ApprovalRequestData;
}

// ── Context value ────────────────────────────────────────────────────

export interface AppContextValue {
  state: AppState;
  setState: (patch: Partial<AppState>) => void;
  wireClient: WireClient;
  /** Theme-aware style helpers (derived from state.theme). */
  styles: ThemeStyles;
  /** All blocks that have been finalised and rendered into <Static>. */
  completedBlocks: CompletedBlock[];
  /** Push a new completed block. */
  pushBlock: (block: CompletedBlock) => void;
  /** Current streaming thinking text (empty string when idle). */
  streamingThinkText: string;
  /** Current streaming text (empty string when idle). */
  streamingText: string;
  /** Set the current streaming text. */
  setStreamingText: (text: string) => void;
  /** Send user input to the wire client and start streaming. */
  sendMessage: (input: string) => void;
  /** Cancel the current streaming turn. */
  cancelStream: () => void;
  /** Tool call currently in progress (shown in dynamic area with spinner). */
  pendingToolCall: ToolCallBlockData | null;
  /** Currently pending approval request, or null if none. */
  pendingApproval: PendingApproval | null;
  /** Respond to the pending approval request. */
  handleApprovalResponse: (response: ApprovalResponseData) => void;

  // ── Phase 7: Session management ──────────────────────────────────
  /** List of sessions from Wire. */
  sessions: SessionInfo[];
  /** Whether the session list is loading. */
  loadingSessions: boolean;
  /** Refresh the session list. */
  refreshSessions: () => Promise<void>;
  /** Switch to a different session. */
  switchSession: (sessionId: string) => void;
  /** Whether the SessionPicker overlay is open. */
  showSessionPicker: boolean;
  /** Open / close the SessionPicker. */
  setShowSessionPicker: (show: boolean) => void;
}

// Placeholder default -- the real value is provided by <App>.
export const AppContext: React.Context<AppContextValue> = createContext<AppContextValue>(
  undefined as unknown as AppContextValue,
);
