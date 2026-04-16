/**
 * Wire client integration hook (Wire 2.1).
 *
 * Manages the streaming lifecycle:
 *  1. User calls `sendMessage(input)`.
 *  2. The hook calls `wireClient.prompt(sessionId, input)` (non-blocking).
 *  3. Events arrive via `subscribe()` (started at mount time).
 *  4. content.delta events are appended to streamingText / streamingThinkText.
 *  5. tool.call events push a pending tool call with structured data.
 *  6. tool.result events complete the tool call and push it to completedBlocks.
 *  7. approval.request (type: 'request') pauses and exposes pendingApproval.
 *  8. On turn.end the accumulated text is pushed into completedBlocks.
 *
 * Also handles cancellation via `cancelStream()`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  WireClient,
  WireMessage,
  ContentDeltaData,
  ToolCallData,
  ToolResultData,
  StatusUpdateData,
  ApprovalRequestData,
  ApprovalResponseData,
  QuestionRequestData,
  NotificationData,
  CompactionEndData,
  StepInterruptedData,
  SessionErrorData,
} from '../../wire/index.js';
import type {
  AppState,
  CompletedBlock,
  ToolCallBlockData,
  ToolResultBlockData,
  PendingApproval,
  PendingQuestion,
  ToastNotification,
} from '../context.js';

export interface UseWireResult {
  completedBlocks: CompletedBlock[];
  pushBlock: (block: CompletedBlock) => void;
  streamingThinkText: string;
  streamingText: string;
  setStreamingText: (text: string) => void;
  sendMessage: (input: string) => void;
  cancelStream: () => void;
  pendingToolCall: ToolCallBlockData | null;
  pendingApproval: PendingApproval | null;
  handleApprovalResponse: (response: ApprovalResponseData) => void;
  pendingQuestion: PendingQuestion | null;
  handleQuestionResponse: (answers: string[]) => void;
  /** Active shell-target notifications rendered as top-of-shell toasts. */
  toasts: ToastNotification[];
  /** Dismiss a toast by id (e.g. when its timer expires). */
  dismissToast: (id: string) => void;
}

const TOAST_TTL_MS = 5000;

let blockIdCounter = 0;

function nextBlockId(): string {
  blockIdCounter += 1;
  return `block-${String(blockIdCounter)}`;
}

export function useWire(
  wireClient: WireClient,
  sessionId: string,
  setState: (patch: Partial<AppState>) => void,
): UseWireResult {
  const [completedBlocks, setCompletedBlocks] = useState<CompletedBlock[]>([]);
  const [streamingThinkText, setStreamingThinkText] = useState('');
  const [streamingText, setStreamingText] = useState('');
  const [pendingToolCall, setPendingToolCall] = useState<ToolCallBlockData | null>(null);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null);
  const [toasts, setToasts] = useState<ToastNotification[]>([]);
  const toastTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const isStreamingRef = useRef(false);
  const accumulatedTextRef = useRef('');
  const accumulatedThinkRef = useRef('');

  // Track active tool calls by ID so we can pair them with results.
  const activeToolCallsRef = useRef<Map<string, ToolCallBlockData>>(new Map());

  const pushBlock = useCallback((block: CompletedBlock) => {
    setCompletedBlocks((prev) => [...prev, block]);
  }, []);

  const cancelStream = useCallback(() => {
    void wireClient.cancel(sessionId);
  }, [wireClient, sessionId]);

  const handleApprovalResponse = useCallback(
    (response: ApprovalResponseData) => {
      const approval = pendingApproval;
      if (approval === null) return;

      // Send response via respondToRequest.
      wireClient.respondToRequest(approval.requestId, response);

      // Clear the pending approval state.
      setPendingApproval(null);
    },
    [pendingApproval, wireClient],
  );

  const handleQuestionResponse = useCallback(
    (answers: string[]) => {
      const question = pendingQuestion;
      if (question === null) return;
      wireClient.respondToRequest(question.requestId, { answers });
      setPendingQuestion(null);
    },
    [pendingQuestion, wireClient],
  );

  const dismissToast = useCallback((id: string) => {
    const timer = toastTimersRef.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      toastTimersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const pushToast = useCallback((notif: NotificationData) => {
    // Skip duplicates: a notification with a known id is ignored so
    // a notification that targets both wire + shell cannot render
    // twice (the wire channel is not subscribed today but the guard
    // is cheap and future-proof).
    setToasts((prev) => {
      if (prev.some((t) => t.id === notif.id)) return prev;
      const toast: ToastNotification = {
        id: notif.id,
        category: notif.category,
        type: notif.type,
        title: notif.title,
        body: notif.body,
        severity: notif.severity,
      };
      return [...prev, toast];
    });
    // Reset any prior timer with the same id and start a fresh one.
    const existing = toastTimersRef.current.get(notif.id);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      toastTimersRef.current.delete(notif.id);
      setToasts((prev) => prev.filter((t) => t.id !== notif.id));
    }, TOAST_TTL_MS);
    toastTimersRef.current.set(notif.id, timer);
  }, []);

  // ── Event processing ────────────────────────────────────────────

  function processMessage(msg: WireMessage): void {
    // Handle Core-initiated requests (e.g. approval.request)
    if (msg.type === 'request') {
      if (msg.method === 'approval.request') {
        flushStreamingText();
        const data = msg.data as ApprovalRequestData;
        setPendingApproval({ requestId: msg.id, data });
      } else if (msg.method === 'question.request') {
        flushStreamingText();
        const data = msg.data as QuestionRequestData;
        setPendingQuestion({ requestId: msg.id, data });
      }
      return;
    }

    // Handle events
    if (msg.type !== 'event') return;

    switch (msg.method) {
      case 'content.delta': {
        const data = msg.data as ContentDeltaData;
        if (data.type === 'text' && data.text !== undefined) {
          // If we were thinking, flush thinking to Static.
          // Clear dynamic state BEFORE pushing to Static to avoid
          // a frame where both dynamic and static thinking are visible.
          if (accumulatedThinkRef.current.length > 0) {
            const thinkContent = accumulatedThinkRef.current;
            accumulatedThinkRef.current = '';
            setStreamingThinkText('');
            const thinkBlock: CompletedBlock = {
              id: nextBlockId(),
              type: 'thinking',
              content: thinkContent,
            };
            setCompletedBlocks((prev) => [...prev, thinkBlock]);
          }
          accumulatedTextRef.current += data.text;
          setStreamingText(accumulatedTextRef.current);
          setState({ streamingPhase: 'composing', streamingStartTime: Date.now() });
        } else if (data.type === 'think' && data.think !== undefined) {
          accumulatedThinkRef.current += data.think;
          setStreamingThinkText(accumulatedThinkRef.current);
          setState({ streamingPhase: 'thinking' });
        }
        break;
      }
      case 'tool.call': {
        const data = msg.data as ToolCallData;
        const tcBlockData: ToolCallBlockData = {
          id: data.id,
          name: data.name,
          args: data.args,
          description: data.description,
        };
        activeToolCallsRef.current.set(data.id, tcBlockData);

        // Flush any accumulated text before showing tool call
        flushStreamingText();

        // Show in dynamic area with loading spinner (no result yet)
        setPendingToolCall(tcBlockData);
        break;
      }
      case 'tool.result': {
        const data = msg.data as ToolResultData;
        const matchedCall = activeToolCallsRef.current.get(data.tool_call_id);

        // Move from dynamic area to Static
        setPendingToolCall(null);

        if (matchedCall) {
          const resultData: ToolResultBlockData = {
            tool_call_id: data.tool_call_id,
            output: data.output,
            is_error: data.is_error,
          };
          const toolCallBlock: CompletedBlock = {
            id: nextBlockId(),
            type: 'tool_call',
            content: `Used ${matchedCall.name}`,
            toolCallData: { ...matchedCall, result: resultData },
          };
          setCompletedBlocks((prev) => [...prev, toolCallBlock]);
        }

        // Clean up the active tool call
        activeToolCallsRef.current.delete(data.tool_call_id);
        break;
      }
      case 'status.update': {
        const data = msg.data as StatusUpdateData;
        if (data.context_usage !== undefined) {
          setState({ contextUsage: data.context_usage });
        }
        break;
      }
      case 'turn.begin': {
        // Mark streaming as active
        if (!isStreamingRef.current) {
          isStreamingRef.current = true;
          setState({
            isStreaming: true,
            streamingPhase: 'waiting',
            streamingStartTime: Date.now(),
          });
        }
        break;
      }
      case 'turn.end': {
        finalizeTurn();
        break;
      }
      case 'step.interrupted': {
        const data = msg.data as StepInterruptedData;
        flushStreamingText();
        setCompletedBlocks((prev) => [
          ...prev,
          {
            id: nextBlockId(),
            type: 'status',
            content: `Step ${String(data.step)} interrupted: ${data.reason}`,
          },
        ]);
        break;
      }
      case 'compaction.begin': {
        flushStreamingText();
        setState({ streamingPhase: 'waiting', streamingStartTime: Date.now() });
        setCompletedBlocks((prev) => [
          ...prev,
          {
            id: nextBlockId(),
            type: 'status',
            content: 'Compacting context...',
          },
        ]);
        break;
      }
      case 'compaction.end': {
        const data = msg.data as CompactionEndData;
        const before = data.tokens_before;
        const after = data.tokens_after;
        const summary =
          before !== undefined && after !== undefined
            ? `Compaction complete: ${String(before)} → ${String(after)} tokens`
            : 'Compaction complete.';
        setCompletedBlocks((prev) => [
          ...prev,
          { id: nextBlockId(), type: 'status', content: summary },
        ]);
        break;
      }
      case 'notification': {
        const data = msg.data as NotificationData;
        pushToast(data);
        break;
      }
      case 'session.error': {
        const data = msg.data as SessionErrorData;
        flushStreamingText();
        const detail = data.error_type !== undefined ? ` (${data.error_type})` : '';
        setCompletedBlocks((prev) => [
          ...prev,
          {
            id: nextBlockId(),
            type: 'status',
            content: `Error${detail}: ${data.error}`,
          },
        ]);
        break;
      }
      default:
        // Other events not yet handled.
        break;
    }
  }

  function flushStreamingText(): void {
    if (accumulatedThinkRef.current.length > 0) {
      const thinkBlock: CompletedBlock = {
        id: nextBlockId(),
        type: 'thinking',
        content: accumulatedThinkRef.current,
      };
      setCompletedBlocks((prev) => [...prev, thinkBlock]);
      accumulatedThinkRef.current = '';
    }

    if (accumulatedTextRef.current.length > 0) {
      const assistantBlock: CompletedBlock = {
        id: nextBlockId(),
        type: 'assistant',
        content: accumulatedTextRef.current,
      };
      setCompletedBlocks((prev) => [...prev, assistantBlock]);
      accumulatedTextRef.current = '';
      setStreamingText('');
    }
  }

  function finalizeTurn(): void {
    if (!isStreamingRef.current) {
      return;
    }

    flushStreamingText();

    // Reset streaming state.
    accumulatedTextRef.current = '';
    accumulatedThinkRef.current = '';
    setStreamingText('');
    setStreamingThinkText('');
    isStreamingRef.current = false;
    setState({ isStreaming: false, streamingPhase: 'idle' });
  }

  // ── Subscribe to events at mount time ───────────────────────────

  useEffect(() => {
    let active = true;

    void (async () => {
      try {
        for await (const msg of wireClient.subscribe(sessionId)) {
          if (!active) break;
          processMessage(msg);
        }
      } catch {
        // Stream ended or errored
      }
    })();

    return () => {
      active = false;
    };
    // We intentionally only subscribe once at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wireClient, sessionId]);

  // ── Send message ────────────────────────────────────────────────

  const sendMessage = useCallback(
    (input: string) => {
      if (isStreamingRef.current) {
        return; // Already streaming, ignore.
      }

      // Slash-command routing moved to `InputArea → App.executeSlashCommand`
      // (Slice 4.x merge). The SlashCommandRegistry now owns parsing and
      // dispatching, so `sendMessage` only handles plain user prompts.

      // Push user message as a completed block.
      const userBlock: CompletedBlock = {
        id: nextBlockId(),
        type: 'user',
        content: input,
      };
      setCompletedBlocks((prev) => [...prev, userBlock]);

      // Reset streaming state.
      accumulatedTextRef.current = '';
      accumulatedThinkRef.current = '';
      activeToolCallsRef.current.clear();
      setStreamingThinkText('');
      setStreamingText('');
      setPendingToolCall(null);
      setPendingApproval(null);
      setPendingQuestion(null);
      isStreamingRef.current = true;
      setState({ isStreaming: true, streamingPhase: 'waiting', streamingStartTime: Date.now() });

      // Non-blocking prompt -- events arrive via subscribe()
      void wireClient.prompt(sessionId, input);
    },
    [wireClient, sessionId, setState],
  );

  // Clear pending toast timers when the hook unmounts so a late
  // firing timeout cannot call setState after unmount.
  useEffect(() => {
    return () => {
      for (const timer of toastTimersRef.current.values()) {
        clearTimeout(timer);
      }
      toastTimersRef.current.clear();
    };
  }, []);

  return {
    completedBlocks,
    pushBlock,
    streamingThinkText,
    streamingText,
    setStreamingText,
    sendMessage,
    cancelStream,
    pendingToolCall,
    pendingApproval,
    handleApprovalResponse,
    pendingQuestion,
    handleQuestionResponse,
    toasts,
    dismissToast,
  };
}
