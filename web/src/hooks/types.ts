import type { ChatStatus, FileUIPart, ToolUIPart } from "ai";

export type NoPreviewAttachment = {
  kind: "nopreview";
  filename: string;
};

export type VideoNoPreviewAttachment = {
  kind: "video-nopreview";
  mediaType: string;
  filename: string;
};

export type MessageAttachmentPart = FileUIPart | NoPreviewAttachment | VideoNoPreviewAttachment;

// Re-export API types for convenience
export type { Session } from "../lib/api/models";

/**
 * Live message in the chat - this is a UI-specific type
 * that extends beyond what the API provides
 */
export type LiveMessage = {
  /** Unique identifier for this UI message (React key) */
  id: string;
  /** Backend message ID from StatusUpdate event (identifies the turn) */
  messageId?: string;
  role: "user" | "assistant";
  content?: string;
  attachments?: MessageAttachmentPart[];
  isStreaming?: boolean;
  variant?:
    | "text"
    | "chain-of-thought"
    | "tool"
    | "code"
    | "thinking"
    | "message-id"
    | "status";
  /** Thinking/reasoning content from the model */
  thinking?: string;
  /** Duration of thinking in seconds */
  thinkingDuration?: number;
  chainOfThought?: {
    title: string;
    steps: {
      label: string;
      description: string;
    }[];
    revealedSteps: number;
    relatedSources?: string[];
  };
  toolCall?: {
    title: string;
    type: ToolUIPart["type"];
    state:
      | ToolUIPart["state"]
      | "approval-requested"
      | "approval-responded"
      | "output-denied";
    input?: ToolUIPart["input"];
    /** Tool call ID for tracking */
    toolCallId?: string;
    /**
     * Tool result fields (aligned with backend ToolReturnValue)
     * @see kosong.tooling.ToolReturnValue
     */
    /** The output content returned by the tool (for model) */
    output?: string;
    /** An explanatory message to be given to the model */
    message?: string;
    /** Content blocks to be displayed to the user */
    display?: Array<{ type: string; data: unknown }>;
    /** Extra debugging/testing data */
    extras?: Record<string, unknown>;
    /** Whether the tool call resulted in an error */
    isError?: boolean;
    /** Error text for display (derived from message when isError) */
    errorText?: string;
    approval?: {
      id: string;
      action: string;
      description: string;
      sender: string;
      toolCallId?: string;
      submitted?: boolean;
      resolved?: boolean;
      approved?: boolean;
      reason?: string;
      response?: unknown;
    };
  };
  codeSnippet?: {
    title: string;
    code: string;
    language: string;
    description?: string;
  };
};

/**
 * Session operations returned by useSessions
 * Uses API types: Session
 */
export type SessionOperations = {
  sessions: import("../lib/api/models").Session[];
  selectedSessionId: string;
  isLoading: boolean;
  error: string | null;
  refreshSessions: () => Promise<void>;
  loadMoreSessions: () => Promise<void>;
  hasMoreSessions: boolean;
  isLoadingMore: boolean;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  refreshSession: (
    sessionId: string,
  ) => Promise<import("../lib/api/models").Session | null>;
  createSession: () => Promise<import("../lib/api/models").Session>;
  deleteSession: (sessionId: string) => Promise<boolean>;
  selectSession: (sessionId: string) => void;
  applySessionStatus: (
    status: import("../lib/api/models").SessionStatus,
  ) => void;
  getRelativeTime: (session: import("../lib/api/models").Session) => string;
};

/**
 * Chat operations
 */
export type ChatOperations = {
  messages: LiveMessage[];
  status: ChatStatus;
  sendMessage: (text: string, attachments?: FileUIPart[]) => Promise<void>;
  cancelStream: () => void;
  clearMessages: () => void;
};
