/**
 * Wire protocol types for Kimi CLI communication
 * Based on the JSON-RPC 2.0 event stream format from stdio.jsonl
 */

// Base JSON-RPC 2.0 message types
export type JsonRpcRequest = {
  jsonrpc: "2.0";
  method: string;
  id?: string | number;
  params?: unknown;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export type SessionState = "stopped" | "idle" | "busy" | "restarting" | "error";

export type SessionStatusPayload = {
  session_id: string;
  state: SessionState;
  seq: number;
  worker_id?: string | null;
  reason?: string | null;
  detail?: string | null;
  updated_at: string;
};

// Event types from the wire protocol
export type TurnBeginEvent = {
  type: "TurnBegin";
  payload: {
    user_input: string | ContentPart[];
  };
};

export type StepBeginEvent = {
  type: "StepBegin";
  payload: {
    n: number;
  };
};

export type StepInterruptedEvent = {
  type: "StepInterrupted";
  payload?: Record<string, never>;
};

export type ContentPartEvent = {
  type: "ContentPart";
  payload: {
    type: "think" | "text" | "image_url" | "audio_url" | "video_url";
    think?: string;
    text?: string;
    image_url?: { url: string; id?: string | null };
    audio_url?: { url: string; id?: string | null };
    video_url?: { url: string; id?: string | null };
    encrypted?: string | null;
  };
};

export type ToolCallEvent = {
  type: "ToolCall";
  payload: {
    type: "function";
    id: string;
    function: {
      name: string;
      arguments: string;
    };
    extras?: unknown;
  };
};

export type ToolCallPartEvent = {
  type: "ToolCallPart";
  payload: {
    arguments_part: string;
  };
};

/**
 * Tool result event from backend
 * @see kosong.tooling.ToolReturnValue for the source type
 */
/** Content part in tool output (for model consumption) */
export type ToolOutputPart = {
  type: string;
  text?: string;
  [key: string]: unknown;
};

export type ToolResultEvent = {
  type: "ToolResult";
  payload: {
    tool_call_id: string;
    return_value: {
      /** Whether the tool call resulted in an error */
      is_error: boolean;
      /** The output content returned by the tool (for model) */
      output: ToolOutputPart[] | string;
      /** An explanatory message to be given to the model (system reminder) */
      message: string;
      /** Content blocks to be displayed to the user */
      display: Array<{ type: string; data: unknown }>;
      /** Extra debugging/testing data */
      extras?: Record<string, unknown>;
    };
  };
};

export type TokenUsage = {
  input_other: number;
  output: number;
  input_cache_read: number;
  input_cache_creation: number;
};

export type StatusUpdateEvent = {
  type: "StatusUpdate";
  payload: {
    context_usage: number | null;
    token_usage?: TokenUsage | null;
    message_id?: string;
  };
};

export type SessionNoticeEvent = {
  type: "SessionNotice";
  payload: {
    text: string;
    kind: "restart";
    reason?: string | null;
    restart_ms?: number | null;
  };
};

export type CompactionBeginEvent = {
  type: "CompactionBegin";
  payload?: Record<string, never>;
};

export type CompactionEndEvent = {
  type: "CompactionEnd";
  payload?: Record<string, never>;
};

export type ApprovalRequestEvent = {
  type: "ApprovalRequest";
  payload: {
    id: string;
    action: string;
    description: string;
    sender: string;
    tool_call_id: string;
  };
};

export type ApprovalRequestResolvedEvent = {
  type: "ApprovalRequestResolved";
  payload: {
    request_id: string;
    response: unknown;
  };
};

export type ApprovalResponseDecision =
  | "approve"
  | "approve_for_session"
  | "reject";

// Union of all event types
export type WireEvent =
  | TurnBeginEvent
  | StepBeginEvent
  | StepInterruptedEvent
  | ContentPartEvent
  | ToolCallEvent
  | ToolCallPartEvent
  | ToolResultEvent
  | StatusUpdateEvent
  | SessionNoticeEvent
  | CompactionBeginEvent
  | CompactionEndEvent
  | ApprovalRequestEvent
  | ApprovalRequestResolvedEvent;

// Parsed wire message
export type WireMessage = {
  jsonrpc: "2.0";
  method?:
    | "event"
    | "prompt"
    | "history_complete"
    | "request"
    | "response"
    | "session_status";
  id?: string | number;
  params?:
    | {
        type?: string;
        payload?: unknown;
        user_input?: string;
      }
    | SessionStatusPayload;
  result?: {
    status?: string;
    slash_commands?: Array<{
      name: string;
      description: string;
      aliases: string[];
    }>;
    [key: string]: unknown;
  };
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

// Parsed tool call state for tracking
export type ToolCallState = {
  id: string;
  name: string;
  arguments: string;
  argumentsComplete: boolean;
  messageId?: string;
  approval?: ToolApprovalState;
  result?: {
    isError: boolean;
    output?: string;
    message?: string;
  };
};

export type ToolApprovalState = {
  id: string;
  action: string;
  description: string;
  sender: string;
  toolCallId: string;
  rpcMessageId?: string | number;
  submitted?: boolean;
  resolved?: boolean;
  approved?: boolean;
  reason?: string;
  response?: unknown;
};

// Content part for accumulated content
export type ContentPart =
  | {
      type: "text" | "input_text";
      text: string;
      content?: string;
    }
  | {
      type: "think";
      think: string;
      content?: string;
    }
  | {
      type: "image_url";
      image_url: { url: string; id?: string | null };
    }
  | {
      type: "audio_url";
      audio_url: { url: string; id?: string | null };
    }
  | {
      type: "video_url";
      video_url: { url: string; id?: string | null };
    }
  | {
      type: "image" | "input_image";
      image_url?: string;
      url?: string;
      mime_type?: string;
      alt?: string;
      data?: unknown;
    }
  | {
      type: "audio" | "input_audio";
      audio_url?: string;
      transcript?: string;
      data?: unknown;
    }
  | {
      type: "video" | "input_video";
      video_url?: string;
      data?: unknown;
    };

// Parsed turn state for tracking conversation
export type TurnState = {
  userInput: string;
  steps: StepState[];
  currentStep: number;
  contextUsage: number;
  isComplete: boolean;
};

export type StepState = {
  n: number;
  thinkingContent: string;
  textContent: string;
  toolCalls: ToolCallState[];
  isStreaming: boolean;
};

/**
 * Parse a JSONL file content into wire messages
 */
export function parseWireMessages(jsonlContent: string): WireMessage[] {
  const lines = jsonlContent.trim().split("\n");
  const messages: WireMessage[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as WireMessage;
      if (parsed.jsonrpc === "2.0") {
        messages.push(parsed);
      }
    } catch {
      console.warn("Failed to parse wire message:", line);
    }
  }

  return messages;
}

/**
 * Extract event from wire message
 */
export function extractEvent(message: WireMessage): WireEvent | null {
  if (message.method !== "event" || !message.params) {
    return null;
  }

  const params = message.params as { type: string; payload: unknown };
  return {
    type: params.type,
    payload: params.payload,
  } as WireEvent;
}
