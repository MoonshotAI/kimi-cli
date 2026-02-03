/**
 * Session stream hook - connects to the session WebSocket for real-time chat
 * This hook manages the WebSocket connection and processes wire protocol messages
 *
 * -----------------------------------------------------------------------------
 * High-level architecture (read this before editing)
 * -----------------------------------------------------------------------------
 *
 * This hook is the "transport + reducer" for the live chat stream:
 * - Transport: maintain exactly one active WebSocket for the currently selected `sessionId`
 * - Reducer: transform the server's JSON-RPC event stream into `LiveMessage[]` for the UI
 *
 * The UI contract is intentionally simple:
 * - `messages`: append-only timeline (with in-place updates while streaming)
 * - `status`: "ready" | "submitted" | "streaming" | "error"
 * - `contextUsage/currentStep`: lightweight progress info
 *
 * -------------------------
 * Data flow / event pipeline
 * -------------------------
 *
 *   Server (JSON-RPC) ─┐
 *                      │ WebSocket `.onmessage` (string)
 *                      ▼
 *                `handleMessage(data)`
 *                      │ JSON.parse → `WireMessage`
 *                      │ extractEvent → `WireEvent`
 *                      ▼
 *                `processEvent(event)`
 *                      │
 *                      ├─ updates small scalar states (status/contextUsage/step)
 *                      ├─ updates "current streaming buffers" (refs)
 *                      └─ updates `messages` via `setMessages(...)`
 *
 * The "streaming buffers" are refs (not state) because they are just accumulators
 * used to build the next message content (think/text/tool args) without fighting
 * React's async render model.
 *
 * ---------------------------------------
 * The hard constraint: no cross-session leak
 * ---------------------------------------
 *
 * Session switches (including "enter draft mode" which sets `sessionId = null`)
 * must be atomic from the UI's perspective:
 * - stop old stream
 * - clear per-session accumulators
 * - (optionally) connect to the new session
 *
 * Why this is tricky:
 * - WebSocket callbacks are async and can fire after we "switch pages".
 * - Calling `ws.close()` does NOT guarantee that previously scheduled callbacks
 *   won't run afterwards.
 *
 * Our solution is two layers:
 * 1) `useLayoutEffect([sessionId])` for teardown before paint (reduces visual flicker).
 * 2) WebSocket identity guards in every callback:
 *      `if (wsRef.current !== ws) return;`
 *    This makes late events harmless: only the currently active socket is allowed
 *    to mutate React state.
 *
 * ---------------------------------------------
 * Three "tabs" people may mean (disambiguation)
 * ---------------------------------------------
 *
 * 1) UI sidebar switching (switching between sessions):
 *
 *    This is in a single React tree. It changes the active context by changing
 *    `sessionId`.
 *
 *    Correctness requirement:
 *    - After a UI switch, no events from the previous session are allowed to
 *      mutate the new screen's state.
 *
 *    Mechanism used here:
 *    - `useLayoutEffect([sessionId])` teardown before paint
 *    - identity guard `if (wsRef.current !== ws) return;` in every callback
 *
 * 2) Browser tabs (two Kimi pages open in Chrome, etc.):
 *
 *    Each browser tab is its own JS runtime, so it has its own hook instance and
 *    its own `wsRef/messages/state`. They are naturally isolated on the client.
 *
 *    The only coupling is server-side (e.g. concurrent session limits), which
 *    shows up as close codes or errors. That policy is *handled* here but is not
 *    part of the core state model.
 *
 * 3) Multi-stream in one UI (render multiple sessions at once inside one page):
 *
 *    NOT supported by this hook by design. This hook intentionally enforces
 *    "one active stream → one message timeline" to stay easy to reason about.
 *
 *    If we ever need true multi-stream in one page, the clean design is:
 *
 *      ┌──────────────────────────┐
 *      │ Map<sessionId, ViewState>│   (store)
 *      └───────────┬──────────────┘
 *                  │ route by connection/session
 *          ┌───────▼────────┐
 *          │ reducer(event) │   (per session entry)
 *          └───────┬────────┘
 *                  │ select by sessionId
 *          ┌───────▼───────────┐
 *          │ UI renders one key │
 *          └────────────────────┘
 *
 *    Key property: events must be routed to the store entry that *owns* the
 *    connection that produced them.
 */
import {
  useState,
  useCallback,
  useRef,
  useEffect,
  useLayoutEffect,
} from "react";
import type { ChatStatus, ToolUIPart } from "ai";
import type { LiveMessage, MessageAttachmentPart } from "./types";
import type { SessionStatus } from "@/lib/api/models";
import { getAuthToken } from "@/lib/auth";
import {
  type ContentPart,
  type TokenUsage,
  type WireMessage,
  type WireEvent,
  type ToolCallState,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type ApprovalRequestEvent,
  type ApprovalResponseDecision,
  type SessionStatusPayload,
  extractEvent,
} from "./wireTypes";
import { createMessageId, getApiBaseUrl } from "./utils";
import { handleToolResult } from "@/features/tool/store";
import { v4 as uuidV4 } from "uuid";

// Regex patterns moved to top level for performance
const DATA_URL_MEDIA_TYPE_REGEX = /^data:([^;,]+)[;,]/;
const NUMBERED_LIST_ITEM_REGEX = /^\d+\.\s+(.+)$/;
const IMAGE_TAG_REGEX = /<image\s+path="([^"]+)"\s+content_type="([^"]+)">/i;
const VIDEO_TAG_REGEX = /<video\s+path="([^"]+)"\s+content_type="([^"]+)">/i;
const DOCUMENT_TAG_REGEX =
  /<document\s+path="([^"]+)"\s+content_type="([^"]+)">/i;
const LEGACY_UPLOADS_REGEX = /`uploads\/([^`]+)`/;
const HTTP_TO_WS_REGEX = /^http/;
const NEWLINE_REGEX = /\r?\n/;

type UseSessionStreamOptions = {
  /** Session ID to connect to */
  sessionId: string | null;
  /** Base URL for WebSocket connection (defaults to current host) */
  baseUrl?: string;
  /** Callback when messages change */
  onMessagesChange?: (messages: LiveMessage[]) => void;
  /** Callback when connection status changes */
  onConnectionChange?: (connected: boolean) => void;
  /** Callback when an error occurs */
  onError?: (error: Error) => void;
  /** Callback when session status changes */
  onSessionStatus?: (status: SessionStatus) => void;
  /** Callback when first turn is complete (for auto-renaming) */
  onFirstTurnComplete?: () => void;
};

type UseSessionStreamReturn = {
  /** Current messages */
  messages: LiveMessage[];
  /** Chat status */
  status: ChatStatus;
  /** Latest runtime session status snapshot */
  sessionStatus: SessionStatus | null;
  /** Whether the stream is still replaying history */
  isReplayingHistory: boolean;
  /** Whether waiting for the first response after sending a prompt */
  isAwaitingFirstResponse: boolean;
  /** Current context usage (0-1) */
  contextUsage: number;
  /** Current token usage for the active step, if available */
  tokenUsage: TokenUsage | null;
  /** Current step number */
  currentStep: number;
  /** Whether connected to the session stream */
  isConnected: boolean;
  /** Send a message to the session (will auto-connect if not connected) */
  sendMessage: (text: string) => Promise<void>;
  /** Respond to an approval request */
  respondToApproval: (
    requestId: string,
    response: ApprovalResponseDecision,
    reason?: string,
  ) => Promise<void>;
  /** Send a cancel request for the current turn */
  cancel: () => void;
  /** Disconnect from the stream */
  disconnect: () => void;
  /** Reconnect to the session */
  reconnect: () => void;
  /** Connect to the session stream */
  connect: () => void;
  /** Set messages directly */
  setMessages: React.Dispatch<React.SetStateAction<LiveMessage[]>>;
  /** Clear all messages */
  clearMessages: () => void;
  /** Connection error if any */
  error: Error | null;
};

type PendingApprovalEntry = {
  requestId: string;
  toolCallId: string;
  messageId?: string;
  rpcId?: string | number;
  submitted?: boolean;
};

/**
 * Hook for connecting to a session's WebSocket stream
 */
export function useSessionStream(
  options: UseSessionStreamOptions,
): UseSessionStreamReturn {
  const {
    sessionId,
    baseUrl,
    onMessagesChange,
    onConnectionChange,
    onError,
    onSessionStatus,
    onFirstTurnComplete,
  } = options;

  const [messages, setMessagesInternal] = useState<LiveMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>("ready");
  const [sessionStatus, setSessionStatus] = useState<SessionStatus | null>(
    null,
  );
  const [contextUsage, setContextUsage] = useState(0);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  const [currentStep, setCurrentStep] = useState(0);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [isAwaitingFirstResponse, setIsAwaitingFirstResponse] = useState(false);
  const [isReplayingHistory, setIsReplayingHistory] = useState(true);

  // Refs
  /**
   * The single source of truth for "which WebSocket is allowed to mutate React state".
   *
   * Important nuance: this ref represents the *current connection attempt*, not only
   * "the currently open socket".
   *
   * Why this exists:
   * - WebSocket callbacks (`onmessage/onclose/onerror/onopen`) are async and can fire
   *   after the UI has already switched to another session (or draft mode).
   * - Simply calling `ws.close()` or setting `wsRef.current = null` does NOT prevent
   *   already-scheduled callbacks from running.
   *
   * Our invariant:
   * - Only callbacks belonging to `wsRef.current` may call `setMessages`, `setStatus`, etc.
   * - Every callback starts with `if (wsRef.current !== ws) return;` to ignore late events.
   */
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const isReplayingRef = useRef(true); // Track if we're still replaying history
  const pendingMessageRef = useRef<string | null>(null); // Message to send after connection
  const awaitingIdleRef = useRef(false); // Track pending idle after cancel
  const awaitingFirstResponseRef = useRef(false); // Track if waiting for first event of a turn
  const lastStatusSeqRef = useRef<number | null>(null);

  // First turn tracking for auto-rename (simplified: backend reads from wire.jsonl)
  const hasTurnStartedRef = useRef(false); // Whether at least one turn has started
  const firstTurnCompleteCalledRef = useRef(false); // Whether onFirstTurnComplete was called

  // Current state accumulators
  const currentThinkingRef = useRef("");
  const currentTextRef = useRef("");
  const currentToolCallsRef = useRef<Map<string, ToolCallState>>(new Map());
  const currentToolCallIdRef = useRef<string | null>(null);
  const thinkingMessageIdRef = useRef<string | null>(null);
  const textMessageIdRef = useRef<string | null>(null);
  const pendingApprovalRequestsRef = useRef<Map<string, PendingApprovalEntry>>(
    new Map(),
  );

  // Wrapped setMessages
  const setMessages: typeof setMessagesInternal = useCallback((action) => {
    setMessagesInternal(action);
  }, []);

  const setAwaitingFirstResponse = useCallback((value: boolean) => {
    awaitingFirstResponseRef.current = value;
    setIsAwaitingFirstResponse(value);
  }, []);
  const clearAwaitingFirstResponse = useCallback(() => {
    if (!awaitingFirstResponseRef.current) {
      return;
    }
    setAwaitingFirstResponse(false);
  }, [setAwaitingFirstResponse]);

  const normalizeSessionStatus = useCallback(
    (payload: SessionStatusPayload): SessionStatus => ({
      sessionId: payload.session_id,
      state: payload.state,
      seq: payload.seq,
      workerId: payload.worker_id ?? undefined,
      reason: payload.reason ?? undefined,
      detail: payload.detail ?? undefined,
      updatedAt: new Date(payload.updated_at),
    }),
    [],
  );

  const completeStreamingMessages = useCallback(() => {
    setMessages((prev) =>
      prev.map((msg) =>
        msg.isStreaming ? { ...msg, isStreaming: false } : msg,
      ),
    );
  }, [setMessages]);

  const applySessionStatus = useCallback(
    (payload: SessionStatusPayload) => {
      const normalized = normalizeSessionStatus(payload);
      const lastSeq = lastStatusSeqRef.current;
      if (lastSeq !== null && normalized.seq <= lastSeq) {
        return;
      }
      lastStatusSeqRef.current = normalized.seq;
      setSessionStatus(normalized);
      onSessionStatus?.(normalized);
      isReplayingRef.current = false;
      setIsReplayingHistory(false);

      switch (normalized.state) {
        case "busy": {
          if (!awaitingIdleRef.current) {
            setStatus("streaming");
          }
          break;
        }
        case "restarting": {
          setStatus("submitted");
          break;
        }
        case "error": {
          setStatus("error");
          setAwaitingFirstResponse(false);
          awaitingIdleRef.current = false;
          completeStreamingMessages();
          break;
        }
        case "stopped":
        case "idle": {
          setStatus("ready");
          setAwaitingFirstResponse(false);
          awaitingIdleRef.current = false;
          completeStreamingMessages();

          // Trigger onFirstTurnComplete only after at least one turn has completed
          if (hasTurnStartedRef.current && !firstTurnCompleteCalledRef.current) {
            firstTurnCompleteCalledRef.current = true;
            onFirstTurnComplete?.();
          }
          break;
        }
      }
    },
    [
      completeStreamingMessages,
      normalizeSessionStatus,
      onSessionStatus,
      setAwaitingFirstResponse,
      onFirstTurnComplete,
    ],
  );

  const updateMessageById = useCallback(
    (messageId: string, transform: (message: LiveMessage) => LiveMessage) => {
      setMessages((prev) =>
        prev.map((message) =>
          message.id === messageId ? transform(message) : message,
        ),
      );
    },
    [setMessages],
  );

  const safeStringify = useCallback((value: unknown): string => {
    if (value === null || value === undefined) {
      return "";
    }
    if (typeof value === "string") {
      return value;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }, []);

  type ParsedUserInput = { text: string; attachments: MessageAttachmentPart[] };

  const parseMediaTypeFromDataUrl = useCallback(
    (url: string): string | null => {
      if (!url.startsWith("data:")) {
        return null;
      }
      const match = DATA_URL_MEDIA_TYPE_REGEX.exec(url);
      return match?.[1] ?? null;
    },
    [],
  );

  const getSessionUploadUrl = useCallback(
    (filename?: string): string | undefined => {
      if (!(sessionId && filename)) {
        return undefined;
      }
      const basePath = baseUrl ?? getApiBaseUrl();
      const token = getAuthToken();
      const tokenParam = token ? `?token=${encodeURIComponent(token)}` : "";
      return `${basePath}/api/sessions/${encodeURIComponent(
        sessionId,
      )}/uploads/${encodeURIComponent(filename)}${tokenParam}`;
    },
    [baseUrl, sessionId],
  );

  const parseUserInput = useCallback(
    (input: string | ContentPart[]): ParsedUserInput => {
      if (typeof input === "string") {
        return { text: input, attachments: [] };
      }

      const textParts: string[] = [];
      const attachments: MessageAttachmentPart[] = [];
      const uploadedFilePaths: string[] = [];
      let inUploadedFilesBlock = false;
      const collectUploadedFilePath = (line: string): boolean => {
        const match = NUMBERED_LIST_ITEM_REGEX.exec(line.trim());
        if (!match) {
          return false;
        }
        const filePath = match[1].trim();
        if (
          !(
            filePath &&
            (filePath.startsWith("/") || filePath.startsWith("uploads/"))
          )
        ) {
          return false;
        }
        uploadedFilePaths.push(filePath);
        return true;
      };

      // Pending metadata for associating with next image_url part
      let pendingFilename: string | undefined;
      let pendingMediaType: string | undefined;

      // State for collecting document content
      let inDocument = false;
      let documentFilename: string | undefined;
      let documentMediaType: string | undefined;
      let documentContent: string[] = [];

      for (const part of input) {
        if (part.type === "text" || part.type === "input_text") {
          const text = part.text;

          // New format: <image path="/path/to/uploads/file.name" content_type="image/png">
          const imageTagMatch = IMAGE_TAG_REGEX.exec(text);
          if (imageTagMatch) {
            // Extract filename from path
            const fullPath = imageTagMatch[1];
            pendingFilename = fullPath.split("/").pop() ?? fullPath;
            pendingMediaType = imageTagMatch[2];
            continue; // Skip this text part, it's just metadata
          }

          // New format: </image> closing tag - skip it
          if (text.trim() === "</image>") {
            continue;
          }

          // New format: <video path="/path/to/uploads/file.name" content_type="video/mp4">
          const videoTagMatch = VIDEO_TAG_REGEX.exec(text);
          if (videoTagMatch) {
            // Extract filename from path
            const fullPath = videoTagMatch[1];
            pendingFilename = fullPath.split("/").pop() ?? fullPath;
            pendingMediaType = videoTagMatch[2];
            continue; // Skip this text part, it's just metadata
          }

          // New format: </video> closing tag - create attachment if no video_url follows
          if (text.trim() === "</video>") {
            // If we have pending video metadata but no video_url part will follow,
            // create a video attachment from the session uploads.
            if (pendingFilename && pendingMediaType?.startsWith("video/")) {
              const url = getSessionUploadUrl(pendingFilename);
              if (url) {
                attachments.push({
                  type: "file",
                  mediaType: pendingMediaType,
                  filename: pendingFilename,
                  url,
                });
              } else {
                attachments.push({
                  kind: "video-nopreview",
                  mediaType: pendingMediaType,
                  filename: pendingFilename,
                });
              }
              pendingFilename = undefined;
              pendingMediaType = undefined;
            }
            continue;
          }

          // New format: <document path="/path/to/uploads/..." content_type="..."> - start collecting
          const documentTagMatch = DOCUMENT_TAG_REGEX.exec(text);
          if (documentTagMatch) {
            inDocument = true;
            // Extract filename from path
            const fullPath = documentTagMatch[1];
            documentFilename = fullPath.split("/").pop() ?? fullPath;
            documentMediaType = documentTagMatch[2];
            documentContent = [];
            continue;
          }

          // New format: </document> - finalize document attachment
          if (text.trim() === "</document>") {
            if (inDocument && documentFilename) {
              const content = documentContent.join("");
              const bytes = new TextEncoder().encode(content);
              const base64 = btoa(String.fromCharCode(...bytes));
              const dataUrl = `data:${documentMediaType ?? "text/plain"};base64,${base64}`;
              attachments.push({
                type: "file",
                mediaType: documentMediaType ?? "text/plain",
                filename: documentFilename,
                url: dataUrl,
              });
            }
            inDocument = false;
            documentFilename = undefined;
            documentMediaType = undefined;
            documentContent = [];
            continue;
          }

          // If inside document, collect content instead of adding to textParts
          if (inDocument) {
            documentContent.push(text);
            continue;
          }

          const lines = text.split(NEWLINE_REGEX);
          const filteredLines: string[] = [];

          for (const line of lines) {
            if (line.includes("<uploaded_files>")) {
              inUploadedFilesBlock = true;
              continue;
            }
            if (line.includes("</uploaded_files>")) {
              inUploadedFilesBlock = false;
              continue;
            }
            if (inUploadedFilesBlock) {
              collectUploadedFilePath(line);
              continue;
            }
            if (collectUploadedFilePath(line)) {
              continue;
            }
            filteredLines.push(line);
          }

          const filteredText = filteredLines.join("\n");

          // Legacy format: `uploads/file.name`
          const legacyMatch = LEGACY_UPLOADS_REGEX.exec(filteredText);
          if (legacyMatch) {
            pendingFilename = legacyMatch[1];
          }

          // Only add non-metadata text parts
          if (filteredText.trim()) {
            textParts.push(filteredText);
          }
          continue;
        }

        if (part.type === "image_url") {
          const inferredMediaType = parseMediaTypeFromDataUrl(
            part.image_url.url,
          );
          attachments.push({
            type: "file",
            mediaType: pendingMediaType ?? inferredMediaType ?? "image/*",
            filename: pendingFilename,
            url: part.image_url.url,
          });
          pendingFilename = undefined;
          pendingMediaType = undefined;
        }

        if (part.type === "video_url") {
          const inferredMediaType = parseMediaTypeFromDataUrl(
            part.video_url.url,
          );
          attachments.push({
            type: "file",
            mediaType: pendingMediaType ?? inferredMediaType ?? "video/*",
            filename: pendingFilename,
            url: part.video_url.url,
          });
          pendingFilename = undefined;
          pendingMediaType = undefined;
        }
      }

      if (uploadedFilePaths.length > 0) {
        const existingFilenames = new Set(
          attachments
            .map((attachment) => attachment.filename)
            .filter((filename): filename is string => Boolean(filename)),
        );
        const seenUploadedFilenames = new Set<string>();
        for (const filePath of uploadedFilePaths) {
          const filename = filePath.split("/").pop() ?? filePath;
          if (!filename) {
            continue;
          }
          if (
            existingFilenames.has(filename) ||
            seenUploadedFilenames.has(filename)
          ) {
            continue;
          }
          attachments.push({
            kind: "nopreview",
            filename,
          });
          seenUploadedFilenames.add(filename);
        }
      }

      return { text: textParts.join("\n\n").trim(), attachments };
    },
    [getSessionUploadUrl, parseMediaTypeFromDataUrl],
  );

  const upsertMessage = useCallback(
    (incoming: LiveMessage) => {
      setMessages((prev) => {
        const index = prev.findIndex((message) => message.id === incoming.id);
        if (index === -1) {
          return [...prev, incoming];
        }
        const next = [...prev];
        next[index] = { ...next[index], ...incoming };
        return next;
      });
    },
    [setMessages],
  );

  // Notify parent of changes
  useEffect(() => {
    onMessagesChange?.(messages);
  }, [messages, onMessagesChange]);

  // Notify parent of connection changes
  useEffect(() => {
    onConnectionChange?.(isConnected);
  }, [isConnected, onConnectionChange]);

  // Create unique message ID
  const getNextMessageId = useCallback(
    (prefix: "user" | "assistant"): string => createMessageId(prefix),
    [],
  );

  // Reset state for new step
  const resetStepState = useCallback(() => {
    currentThinkingRef.current = "";
    currentTextRef.current = "";
    thinkingMessageIdRef.current = null;
    textMessageIdRef.current = null;
  }, []);

  // Reset all state
  const resetState = useCallback(() => {
    resetStepState();
    currentToolCallsRef.current.clear();
    currentToolCallIdRef.current = null;
    pendingApprovalRequestsRef.current.clear();
    setCurrentStep(0);
    setContextUsage(0);
    setTokenUsage(null);
    setError(null);
    setSessionStatus(null);
    lastStatusSeqRef.current = null;
    isReplayingRef.current = true;
    setIsReplayingHistory(true);
    setAwaitingFirstResponse(false);
    // Reset first turn tracking
    hasTurnStartedRef.current = false;
    firstTurnCompleteCalledRef.current = false;
  }, [resetStepState, setAwaitingFirstResponse]);

  // Process a single wire event
  const processEvent = useCallback(
    (event: WireEvent, isReplay = false, rpcMessageId?: string | number) => {
      switch (event.type) {
        case "TurnBegin": {
          const parsedUserInput = parseUserInput(event.payload.user_input);

          // Track that at least one turn has started (for auto-rename trigger)
          if (!isReplay) {
            hasTurnStartedRef.current = true;
          }

          // Add user message
          const userMessageId = getNextMessageId("user");
          const userMessage: LiveMessage = {
            id: userMessageId,
            role: "user",
            content:
              parsedUserInput.text ||
              (parsedUserInput.attachments.length > 0
                ? ""
                : safeStringify(event.payload.user_input ?? "")),
            attachments:
              parsedUserInput.attachments.length > 0
                ? parsedUserInput.attachments
                : undefined,
          };

          upsertMessage(userMessage);
          break;
        }

        case "StepBegin": {
          setCurrentStep(event.payload.n);
          resetStepState();
          if (!isReplay) {
            setStatus("streaming");
          }
          break;
        }

        case "ContentPart": {
          if (!isReplay) {
            clearAwaitingFirstResponse();
          }
          if (event.payload.type === "think" && event.payload.think) {
            // Accumulate thinking content
            currentThinkingRef.current += event.payload.think;

            // Create or update thinking message
            if (!thinkingMessageIdRef.current) {
              thinkingMessageIdRef.current = getNextMessageId("assistant");
              upsertMessage({
                id: thinkingMessageIdRef.current!,
                role: "assistant",
                variant: "thinking",
                thinking: currentThinkingRef.current,
                isStreaming: !isReplay,
              });
            } else {
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === thinkingMessageIdRef.current
                    ? { ...msg, thinking: currentThinkingRef.current }
                    : msg,
                ),
              );
            }
          } else if (event.payload.type === "text" && event.payload.text) {
            // Mark thinking as complete if it exists
            if (thinkingMessageIdRef.current) {
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === thinkingMessageIdRef.current
                    ? { ...msg, isStreaming: false }
                    : msg,
                ),
              );
            }

            // Accumulate text content
            currentTextRef.current += event.payload.text;

            // Create or update text message
            if (!textMessageIdRef.current) {
              textMessageIdRef.current = getNextMessageId("assistant");
              upsertMessage({
                id: textMessageIdRef.current!,
                role: "assistant",
                variant: "text",
                content: currentTextRef.current,
                isStreaming: !isReplay,
              });
            } else {
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === textMessageIdRef.current
                    ? { ...msg, content: currentTextRef.current }
                    : msg,
                ),
              );
            }
          }
          break;
        }

        case "ToolCall": {
          if (!isReplay) {
            clearAwaitingFirstResponse();
          }
          const toolCall = event.payload;
          currentToolCallIdRef.current = toolCall.id;

          // Initialize tool call state
          const initialArgs = toolCall.function.arguments || "";
          currentToolCallsRef.current.set(toolCall.id, {
            id: toolCall.id,
            name: toolCall.function.name,
            arguments: initialArgs,
            argumentsComplete: false,
            messageId: undefined,
          });

          // Parse initial arguments if available
          let parsedInput: unknown;
          if (initialArgs) {
            try {
              parsedInput = JSON.parse(initialArgs);
            } catch {
              // Not valid JSON yet, leave as undefined
            }
          }

          // Create tool message
          const toolMessageId = getNextMessageId("assistant");
          upsertMessage({
            id: toolMessageId,
            role: "assistant",
            variant: "tool",
            toolCall: {
              title: toolCall.function.name,
              type: "tool-call" as ToolUIPart["type"],
              state: "input-streaming" as ToolUIPart["state"],
              toolCallId: toolCall.id,
              input: parsedInput,
            },
            isStreaming: !isReplay,
          });

          // Store message ID in tool call state for later updates
          const tc = currentToolCallsRef.current.get(toolCall.id);
          if (tc) {
            tc.messageId = toolMessageId;
          }
          break;
        }

        case "ToolCallPart": {
          if (currentToolCallIdRef.current) {
            const tc = currentToolCallsRef.current.get(
              currentToolCallIdRef.current,
            );
            if (tc) {
              tc.arguments += event.payload.arguments_part;

              const messageId = tc.messageId;
              if (messageId) {
                let parsedInput: unknown = tc.arguments;
                try {
                  parsedInput = JSON.parse(tc.arguments);
                } catch {
                  // Not complete JSON yet
                }

                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === messageId && msg.toolCall
                      ? {
                          ...msg,
                          toolCall: {
                            ...msg.toolCall,
                            state: "input-available" as ToolUIPart["state"],
                            input: parsedInput,
                          },
                        }
                      : msg,
                  ),
                );
              }
            }
          }
          break;
        }

        case "ToolResult": {
          if (!isReplay) {
            clearAwaitingFirstResponse();
          }
          const { tool_call_id, return_value } = event.payload;
          const tc = currentToolCallsRef.current.get(tool_call_id);

          const outputStr = Array.isArray(return_value.output)
            ? return_value.output
                .map((part) => part.text ?? "")
                .filter(Boolean)
                .join("\n")
            : return_value.output;
          const messageStr = return_value.message;

          if (tc) {
            tc.argumentsComplete = true;
            tc.result = {
              isError: return_value.is_error,
              output: outputStr || undefined,
              message: messageStr || undefined,
            };
          }

          // Match message by toolCallId directly - this is robust against:
          // 1. Out-of-order ToolResult (parallel tool calls)
          // 2. Missing tc.messageId (race conditions)
          // 3. Replay mode (messages already have toolCallId)
          setMessages((prev) =>
            prev.map((msg) => {
              if (msg.toolCall?.toolCallId !== tool_call_id) return msg;
              return {
                ...msg,
                toolCall: {
                  ...msg.toolCall,
                  state: return_value.is_error
                    ? ("output-error" as ToolUIPart["state"])
                    : ("output-available" as ToolUIPart["state"]),
                  // Aligned with backend ToolReturnValue
                  output: outputStr || undefined,
                  message: messageStr || undefined,
                  display: return_value.display,
                  extras: return_value.extras,
                  isError: return_value.is_error,
                  errorText: return_value.is_error
                    ? messageStr || undefined
                    : undefined,
                },
                isStreaming: false,
              };
            }),
          );

          if (currentToolCallIdRef.current === tool_call_id) {
            currentToolCallIdRef.current = null;
          }

          // Handle tool-specific events (e.g., WriteFile → new files notification)
          if (tc) {
            handleToolResult(
              tc.name,
              tc.arguments,
              return_value.is_error,
              isReplay,
            );
          }
          break;
        }

        case "ApprovalRequest": {
          if (!isReplay) {
            clearAwaitingFirstResponse();
          }
          const payload = event.payload;
          const tc = currentToolCallsRef.current.get(payload.tool_call_id);

          const approvalState = {
            id: payload.id,
            action: payload.action,
            description: payload.description,
            sender: payload.sender,
            toolCallId: payload.tool_call_id,
            rpcMessageId,
            submitted: false,
            resolved: false,
          };

          if (tc) {
            tc.approval = approvalState;
          } else {
            const fallbackState: ToolCallState = {
              id: payload.tool_call_id,
              name: payload.action,
              arguments: "",
              argumentsComplete: false,
              messageId: undefined,
              approval: approvalState,
            };
            currentToolCallsRef.current.set(
              payload.tool_call_id,
              fallbackState,
            );
          }

          let messageId = tc?.messageId;

          if (messageId) {
            updateMessageById(messageId, (message) => {
              if (!message.toolCall) {
                return message;
              }
              return {
                ...message,
                isStreaming: false,
                toolCall: {
                  ...message.toolCall,
                  state: "approval-requested",
                  approval: approvalState,
                },
              };
            });
          } else {
            const fallbackMessageId = getNextMessageId("assistant");
            const approvalMessage: LiveMessage = {
              id: fallbackMessageId,
              role: "assistant",
              variant: "tool",
              isStreaming: false,
              toolCall: {
                title: payload.action,
                type: "tool-call" as ToolUIPart["type"],
                state: "approval-requested",
                approval: approvalState,
              },
            };

            currentToolCallsRef.current.set(payload.tool_call_id, {
              ...(currentToolCallsRef.current.get(payload.tool_call_id) ?? {
                id: payload.tool_call_id,
                name: payload.action,
                arguments: "",
                argumentsComplete: false,
              }),
              messageId: fallbackMessageId,
            });

            setMessages((prev) => [...prev, approvalMessage]);
            messageId = fallbackMessageId;
          }

          pendingApprovalRequestsRef.current.set(payload.id, {
            requestId: payload.id,
            toolCallId: payload.tool_call_id,
            messageId,
            rpcId: rpcMessageId,
            submitted: false,
          });

          break;
        }

        case "ApprovalRequestResolved": {
          const { request_id, response } = event.payload;
          const pending = pendingApprovalRequestsRef.current.get(request_id);

          let tc: ToolCallState | undefined;

          if (pending) {
            tc = currentToolCallsRef.current.get(pending.toolCallId);
          }

          if (!tc) {
            for (const entry of currentToolCallsRef.current.values()) {
              if (entry.approval?.id === request_id) {
                tc = entry;
                break;
              }
            }
          }

          const approval = tc?.approval ?? {
            id: request_id,
            action: "",
            description: "",
            sender: "",
            toolCallId: pending?.toolCallId ?? "",
          };

          let approved: boolean | undefined;
          let reason: string | undefined;

          if (typeof response === "boolean") {
            approved = response;
          } else if (response && typeof response === "object") {
            const candidate = response as {
              approved?: unknown;
              reason?: unknown;
            };
            if (typeof candidate.approved === "boolean") {
              approved = candidate.approved;
            }
            if (typeof candidate.reason === "string") {
              reason = candidate.reason;
            }
          } else if (typeof response === "string") {
            const normalizedResponse = response.toLowerCase();
            if (
              normalizedResponse === "approve" ||
              normalizedResponse === "approve_for_session" ||
              normalizedResponse === "approval" ||
              normalizedResponse === "approved"
            ) {
              approved = true;
            } else if (normalizedResponse === "reject") {
              approved = false;
            } else {
              reason = response;
            }
          }

          const updatedApproval = {
            ...approval,
            response,
            resolved: true,
            submitted: true,
            approved,
            reason: reason ?? approval.reason,
          };

          if (tc) {
            tc.approval = updatedApproval;
          }

          const messageId = tc?.messageId ?? pending?.messageId;
          const nextState =
            approved === false ? "output-denied" : "approval-responded";
          const nextStreaming = approved !== false;

          if (messageId) {
            updateMessageById(messageId, (message) => {
              if (!message.toolCall) {
                return message;
              }

              return {
                ...message,
                isStreaming: nextStreaming,
                toolCall: {
                  ...message.toolCall,
                  state: nextState,
                  approval: updatedApproval,
                  errorText:
                    approved === false
                      ? (updatedApproval.reason ?? message.toolCall.errorText)
                      : message.toolCall.errorText,
                },
              };
            });
          }

          if (pending) {
            pendingApprovalRequestsRef.current.delete(pending.requestId);
          } else {
            pendingApprovalRequestsRef.current.delete(request_id);
          }

          break;
        }

        case "StatusUpdate": {
          const nextContextUsage = event.payload.context_usage;
          if (typeof nextContextUsage === "number") {
            setContextUsage(nextContextUsage);
          }

          const nextTokenUsage = event.payload.token_usage;
          if (nextTokenUsage) {
            setTokenUsage(nextTokenUsage);
          }

          // If we have a message_id, create a special message to display it
          const messageId = event.payload.message_id;
          if (messageId) {
            const displayMessageId = getNextMessageId("assistant");
            upsertMessage({
              id: displayMessageId,
              role: "assistant",
              variant: "message-id",
              messageId,
            });
          }
          break;
        }

        case "SessionNotice": {
          if (!isReplay) {
            clearAwaitingFirstResponse();
          }
          if (event.payload.text) {
            setMessages((prev) => [
              ...prev,
              {
                id: getNextMessageId("assistant"),
                role: "assistant",
                variant: "status",
                content: event.payload.text,
              },
            ]);
          }
          break;
        }

        case "StepInterrupted": {
          setMessages((prev) =>
            prev.map((msg) =>
              msg.isStreaming ? { ...msg, isStreaming: false } : msg,
            ),
          );
          setAwaitingFirstResponse(false);
          if (awaitingIdleRef.current) {
            setStatus("submitted");
          } else {
            setStatus("ready");
          }
          break;
        }

        case "CompactionBegin":
        case "CompactionEnd":
          // Could show compaction indicator if needed
          break;

        default:
          break;
      }
    },
    [
      getNextMessageId,
      setMessages,
      resetStepState,
      upsertMessage,
      parseUserInput,
      safeStringify,
      clearAwaitingFirstResponse,
      updateMessageById,
      setAwaitingFirstResponse,
    ],
  );

  // Handle incoming WebSocket message
  const handleMessage = useCallback(
    (data: string) => {
      try {
        console.log("[SessionStream] Received raw message:", data);
        const message: WireMessage = JSON.parse(data);
        console.log("[SessionStream] Parsed message:", message);

        // Check for JSON-RPC error response
        if (message.error) {
          console.error("[SessionStream] Received error:", message.error);
          const err = new Error(message.error.message || "Unknown error");
          setError(err);
          onError?.(err);
          setStatus("error");
          setAwaitingFirstResponse(false);
          awaitingIdleRef.current = false;
          // Mark all streaming messages as complete
          setMessages((prev) =>
            prev.map((msg) =>
              msg.isStreaming ? { ...msg, isStreaming: false } : msg,
            ),
          );
          return;
        }

        if (message.method === "session_status") {
          applySessionStatus(message.params as SessionStatusPayload);
          return;
        }

        // Check for finished status
        if (message.result?.status === "finished") {
          console.log("[SessionStream] Stream finished");
          setStatus("ready");
          setAwaitingFirstResponse(false);
          awaitingIdleRef.current = false;
          isReplayingRef.current = false;
          setIsReplayingHistory(false);
          setMessages((prev) =>
            prev.map((msg) =>
              msg.isStreaming ? { ...msg, isStreaming: false } : msg,
            ),
          );
          return;
        }

        // Check for replay_complete marker (custom event from server)
        if (
          message.method === "event" &&
          (message.params as { type?: string })?.type === "ReplayComplete"
        ) {
          console.log("[SessionStream] Replay complete");
          isReplayingRef.current = false;
          setIsReplayingHistory(false);
          setStatus("ready");
          awaitingIdleRef.current = false;
          return;
        }

        // Check for history_complete - history loaded but environment not ready yet
        // This allows showing history while SSH connection is being established
        if (message.method === "history_complete") {
          console.log(
            "[SessionStream] History loaded, waiting for environment...",
          );
          isReplayingRef.current = false;
          // Keep status as "submitted" - input stays disabled until session_status
          setStatus((current) => (current === "ready" ? current : "submitted"));
          return;
        }

        // Handle approval requests sent as JSON-RPC requests
        if (message.method === "request") {
          const params = message.params as {
            type?: string;
            payload?: unknown;
          };

          if (params?.type === "ApprovalRequest") {
            const approvalEvent: ApprovalRequestEvent = {
              type: "ApprovalRequest",
              payload: params.payload as ApprovalRequestEvent["payload"],
            };
            processEvent(
              approvalEvent,
              isReplayingRef.current,
              message.id ?? (approvalEvent.payload.id as string | number),
            );
            return;
          }
        }

        // Process event
        const event = extractEvent(message);
        console.log("[SessionStream] Extracted event:", event);
        if (event) {
          processEvent(event, isReplayingRef.current);
        }
      } catch (err) {
        console.warn(
          "[SessionStream] Failed to parse WebSocket message:",
          data,
          err,
        );
      }
    },
    [
      processEvent,
      setMessages,
      onError,
      setAwaitingFirstResponse,
      applySessionStatus,
    ],
  );

  // Build WebSocket URL
  const getWebSocketUrl = useCallback(
    (sid: string): string => {
      const token = getAuthToken();
      if (baseUrl) {
        // Convert HTTP URL to WebSocket URL
        const url = baseUrl.replace(HTTP_TO_WS_REGEX, "ws");
        const wsUrl = `${url}/api/sessions/${sid}/stream`;
        return token ? `${wsUrl}?token=${encodeURIComponent(token)}` : wsUrl;
      }

      // Use current host
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const host = window.location.host;
      const wsUrl = `${protocol}//${host}/api/sessions/${sid}/stream`;
      return token ? `${wsUrl}?token=${encodeURIComponent(token)}` : wsUrl;
    },
    [baseUrl],
  );

  // Helper to send pending message
  const sendPendingMessage = useCallback(
    (ws: WebSocket) => {
      const pendingMessage = pendingMessageRef.current;
      if (pendingMessage) {
        pendingMessageRef.current = null;
        const message: WireMessage = {
          jsonrpc: "2.0",
          method: "prompt",
          id: uuidV4(),
          params: {
            user_input: pendingMessage,
          },
        };
        ws.send(JSON.stringify(message));
        setAwaitingFirstResponse(true);
        setStatus("streaming");
        console.log(
          "[SessionStream] Sent pending message after connect:",
          pendingMessage,
        );
      }
    },
    [setAwaitingFirstResponse],
  );

  const respondToApproval = useCallback(
    async (
      requestId: string,
      response: ApprovalResponseDecision,
      reason?: string,
    ) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        throw new Error("Not connected to session stream");
      }

      const pending = pendingApprovalRequestsRef.current.get(requestId);
      if (!pending) {
        throw new Error("Approval request not found");
      }

      if (pending.submitted) {
        return;
      }

      const trimmedReason =
        typeof reason === "string" && reason.trim().length > 0
          ? reason.trim()
          : undefined;

      const isApproved = response !== "reject";
      const rejectionReason = response === "reject" ? trimmedReason : undefined;
      const responseMessage: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: pending.rpcId ?? requestId,
        result: {
          request_id: pending.requestId ?? requestId,
          response,
        },
      };

      try {
        ws.send(JSON.stringify(responseMessage));
      } catch (err) {
        throw err instanceof Error ? err : new Error(String(err));
      }

      pending.submitted = true;
      pendingApprovalRequestsRef.current.set(requestId, pending);

      const tc = currentToolCallsRef.current.get(pending.toolCallId);
      const nextState = isApproved ? "approval-responded" : "output-denied";
      const nextStreaming = isApproved;

      if (tc) {
        const existingApproval = tc.approval ?? {
          id: requestId,
          action: "",
          description: "",
          sender: "",
          toolCallId: pending.toolCallId,
        };

        const updatedApproval = {
          ...existingApproval,
          approved: isApproved,
          reason: isApproved
            ? existingApproval.reason
            : (rejectionReason ?? existingApproval.reason),
          submitted: true,
          resolved: isApproved ? existingApproval.resolved : true,
          response,
        };

        tc.approval = updatedApproval;

        if (tc.messageId) {
          updateMessageById(tc.messageId, (message) => {
            if (!message.toolCall) {
              return message;
            }

            return {
              ...message,
              isStreaming: nextStreaming,
              toolCall: {
                ...message.toolCall,
                state: nextState,
                approval: updatedApproval,
                errorText: isApproved
                  ? message.toolCall.errorText
                  : (rejectionReason ?? message.toolCall.errorText),
              },
            };
          });
        }
      }
    },
    [updateMessageById],
  );

  // Connect to WebSocket
  const connect = useCallback(() => {
    if (!sessionId) return;

    // Close existing connection
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    awaitingIdleRef.current = false;
    resetState();
    setMessages([]);
    setStatus("submitted");
    setAwaitingFirstResponse(Boolean(pendingMessageRef.current));

    const wsUrl = getWebSocketUrl(sessionId);

    try {
      const ws = new WebSocket(wsUrl);
      // Mark this socket as the "current attempt" immediately.
      // If the user switches sessions before `onopen`, `disconnect()` will clear `wsRef.current`,
      // and any late callbacks from this `ws` will be ignored by the identity guard.
      wsRef.current = ws;

      ws.onopen = () => {
        if (wsRef.current !== ws) {
          ws.close();
          return;
        }

        console.log("[SessionStream] Connected to session:", sessionId);
        setIsConnected(true);
        setError(null);
        awaitingIdleRef.current = false;
        setStatus("streaming"); // Will receive replay, then switch to ready

        // Send pending message immediately after connection
        sendPendingMessage(ws);
      };

      ws.onmessage = (event) => {
        if (wsRef.current !== ws) {
          return;
        }

        handleMessage(event.data);
      };

      ws.onerror = (event) => {
        if (wsRef.current !== ws) {
          return;
        }

        console.error("[SessionStream] WebSocket error:", event);
        const err = new Error("WebSocket connection error");
        setError(err);
        onError?.(err);
        setAwaitingFirstResponse(false);
        awaitingIdleRef.current = false;
        pendingMessageRef.current = null; // Clear pending message on error
      };

      ws.onclose = (event) => {
        if (wsRef.current !== ws) {
          return;
        }

        console.log("[SessionStream] Disconnected:", event.code, event.reason);
        setIsConnected(false);
        wsRef.current = null;
        pendingMessageRef.current = null; // Clear pending message on close
        pendingApprovalRequestsRef.current.clear();
        awaitingIdleRef.current = false;
        setAwaitingFirstResponse(false);
        setSessionStatus(null);
        lastStatusSeqRef.current = null;

        // Handle specific close codes
        if (event.code === 4004) {
          const err = new Error("Session not found");
          setError(err);
          onError?.(err);
        } else if (event.code === 4029) {
          const err = new Error("Too many concurrent sessions");
          setError(err);
          onError?.(err);
        }

        // Mark all streaming messages as complete
        setMessages((prev) =>
          prev.map((msg) =>
            msg.isStreaming ? { ...msg, isStreaming: false } : msg,
          ),
        );
        setStatus("ready");
      };
    } catch (err) {
      console.error("[SessionStream] Failed to connect:", err);
      const connectionError =
        err instanceof Error ? err : new Error(String(err));
      setError(connectionError);
      onError?.(connectionError);
      awaitingIdleRef.current = false;
      setAwaitingFirstResponse(false);
      setStatus("error");
      pendingMessageRef.current = null; // Clear pending message on error
    }
  }, [
    sessionId,
    resetState,
    setMessages,
    getWebSocketUrl,
    handleMessage,
    onError,
    sendPendingMessage,
    setAwaitingFirstResponse,
  ]);

  // Send cancel message to server
  // Disconnect
  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current !== null) {
      window.clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    awaitingIdleRef.current = false;
    setAwaitingFirstResponse(false);
    pendingMessageRef.current = null;
    setIsConnected(false);
    setStatus("ready");
    setSessionStatus(null);
    lastStatusSeqRef.current = null;
    pendingApprovalRequestsRef.current.clear();

    // Mark all streaming messages as complete
    setMessages((prev) =>
      prev.map((msg) =>
        msg.isStreaming ? { ...msg, isStreaming: false } : msg,
      ),
    );
  }, [setMessages, setAwaitingFirstResponse]);

  // Send cancel request or disconnect if stream not ready
  const cancel = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.log(
        "[SessionStream] Cancel requested before stream is ready, disconnecting instead",
      );
      awaitingIdleRef.current = false;
      pendingMessageRef.current = null;
      disconnect();
      return;
    }

    const cancelMessage: JsonRpcRequest = {
      jsonrpc: "2.0",
      method: "cancel",
      id: uuidV4(),
    };

    try {
      console.log("[SessionStream] Sending cancel request");
      ws.send(JSON.stringify(cancelMessage));
      const shouldAwaitIdle = status === "streaming" || status === "submitted";
      awaitingIdleRef.current = shouldAwaitIdle;
      if (status === "streaming") {
        setStatus("submitted");
      }
      setAwaitingFirstResponse(false);
    } catch (err) {
      console.error("[SessionStream] Failed to send cancel request:", err);
    }
  }, [status, disconnect, setAwaitingFirstResponse]);

  // Reconnect
  const reconnect = useCallback(() => {
    disconnect();
    // Small delay before reconnecting
    reconnectTimeoutRef.current = window.setTimeout(() => {
      connect();
    }, 100);
  }, [disconnect, connect]);

  // Send message to session (auto-connects if not connected)
  const sendMessage = useCallback(
    async (text: string) => {
      if (!text.trim()) return;

      const trimmedText = text.trim();
      setAwaitingFirstResponse(true);

      // If not connected, store the message and connect
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        if (!sessionId) {
          throw new Error("No session selected");
        }

        pendingMessageRef.current = trimmedText;
        connect();
        return;
      }

      // Send as JSON-RPC prompt message
      const message: WireMessage = {
        jsonrpc: "2.0",
        method: "prompt",
        id: uuidV4(),
        params: {
          user_input: trimmedText,
        },
      };

      wsRef.current.send(JSON.stringify(message));
      awaitingIdleRef.current = false;
      setStatus("streaming");
    },
    [sessionId, connect, setAwaitingFirstResponse],
  );

  // Clear messages
  const clearMessages = useCallback(() => {
    setMessages([]);
    resetState();
  }, [setMessages, resetState]);

  // Auto-connect when sessionId changes
  useLayoutEffect(() => {
    /**
     * Session switches must be "atomic" from the UI's perspective:
     * - stop old stream
     * - clear per-session accumulators
     * - optionally connect to the new session
     *
     * We use `useLayoutEffect` (instead of `useEffect`) so teardown happens before paint,
     * minimizing the chance that the next screen renders while the previous socket still
     * pushes messages.
     *
     * Even if a late event slips through, callback identity guards ensure it can't mutate
     * state unless it belongs to the current `wsRef.current`.
     */
    // When sessionId changes, disconnect from previous session
    if (wsRef.current) {
      disconnect();
    }

    // Reset state for new session
    resetState();
    setMessages([]);

    // Auto-connect if we have a valid sessionId
    if (sessionId) {
      // Small delay to ensure state is settled
      const timeoutId = window.setTimeout(() => {
        connect();
      }, 50);
      return () => {
        window.clearTimeout(timeoutId);
        disconnect();
      };
    }

    setIsReplayingHistory(false);
    return () => {
      disconnect();
    };
  }, [sessionId, connect, disconnect, resetState, setMessages]); // Only depend on sessionId - connect/disconnect are stable

  // Cleanup on unmount
  useEffect(
    () => () => {
      if (reconnectTimeoutRef.current !== null) {
        window.clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    },
    [],
  );

  return {
    messages,
    status,
    sessionStatus,
    isAwaitingFirstResponse,
    contextUsage,
    tokenUsage,
    currentStep,
    isConnected,
    isReplayingHistory,
    sendMessage,
    respondToApproval,
    cancel,
    disconnect,
    reconnect,
    connect,
    setMessages,
    clearMessages,
    error,
  };
}
