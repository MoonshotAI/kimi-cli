/**
 * React Context for the Ink TUI application.
 *
 * Provides shared application state and the Wire client to all components
 * in the tree. The context is initialised at the `<App>` level and consumed
 * by hooks and components below it.
 */

import React, { createContext } from 'react';

import type { WireClient } from '@moonshot-ai/kimi-wire-mock';

import type { Theme } from '../config/schema.js';
import type { ThemeStyles } from '../theme/styles.js';

// ── AppState ─────────────────────────────────────────────────────────

export interface AppState {
  /** Current input mode: 'agent' sends to AI, 'shell' executes commands (Ctrl-X toggle). */
  inputMode: 'agent' | 'shell';
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
  /** Context usage ratio (0-1) from the last StatusUpdate. */
  contextUsage: number;
  /** Whether an assistant turn is currently streaming. */
  isStreaming: boolean;
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

export interface CompletedBlock {
  /** Unique identifier for the block (used as React key in <Static>). */
  id: string;
  /** Discriminant for rendering. */
  type: CompletedBlockType;
  /** Text content of the block. */
  content: string;
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
  /** Current streaming text (empty string when idle). */
  streamingText: string;
  /** Set the current streaming text. */
  setStreamingText: (text: string) => void;
  /** Send user input to the wire client and start streaming. */
  sendMessage: (input: string) => void;
  /** Cancel the current streaming turn. */
  cancelStream: () => void;
}

// Placeholder default -- the real value is provided by <App>.
export const AppContext: React.Context<AppContextValue> = createContext<AppContextValue>(
  undefined as unknown as AppContextValue,
);
