/**
 * Wire client integration hook.
 *
 * The TUI is split into:
 *  - append-only transcript entries rendered through `<Static>`
 *  - a small live pane for the current turn
 *  - low-frequency chrome state
 *
 * This keeps token-by-token updates confined to a small subtree.
 */

import { startTransition, useCallback, useEffect, useRef, useState } from 'react';

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
import { committedBoundary } from '../../components/markdown/index.js';
import type {
  AppState,
  TranscriptEntry,
  ToolCallBlockData,
  ToolResultBlockData,
  LivePaneState,
  ToastNotification,
  QueuedMessage,
} from '../context.js';

export interface UseWireResult {
  transcriptEntries: TranscriptEntry[];
  appendTranscriptEntry: (entry: TranscriptEntry) => void;
  livePane: LivePaneState;
  sendMessage: (input: string) => void;
  cancelStream: () => void;
  handleApprovalResponse: (response: ApprovalResponseData) => void;
  handleQuestionResponse: (answers: string[]) => void;
  toasts: ToastNotification[];
  dismissToast: (id: string) => void;
  queuedMessages: QueuedMessage[];
  enqueueMessage: (text: string) => void;
  removeFromQueue: (id: string) => void;
  editQueueItem: (id: string, text: string) => void;
  steerMessage: (text: string) => void;
  recallLastQueued: () => string | undefined;
  dequeueFirst: () => string | undefined;
}

const TOAST_TTL_MS = 5000;

const INITIAL_LIVE_PANE: LivePaneState = {
  mode: 'idle',
  thinkingText: '',
  assistantText: '',
  pendingToolCall: null,
  pendingApproval: null,
  pendingQuestion: null,
};

let transcriptIdCounter = 0;

function nextTranscriptId(): string {
  transcriptIdCounter += 1;
  return `entry-${String(transcriptIdCounter)}`;
}

export function useWire(
  wireClient: WireClient,
  sessionId: string,
  setState: (patch: Partial<AppState>) => void,
): UseWireResult {
  const [transcriptEntries, setTranscriptEntries] = useState<TranscriptEntry[]>([]);
  const [livePane, setLivePane] = useState<LivePaneState>(INITIAL_LIVE_PANE);
  const [toasts, setToasts] = useState<ToastNotification[]>([]);

  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  const queueIdCounter = useRef(0);

  const sendMessageInternalRef = useRef<((input: string) => void) | undefined>(undefined);

  const toastTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const isStreamingRef = useRef(false);
  const currentTurnIdRef = useRef<string | undefined>(undefined);
  const assistantDraftRef = useRef('');
  const assistantCommittedLengthRef = useRef(0);
  const thinkingDraftRef = useRef('');
  const activeToolCallsRef = useRef<Map<string, ToolCallBlockData>>(new Map());

  const appendTranscriptEntries = useCallback((entries: TranscriptEntry[]) => {
    if (entries.length === 0) return;
    startTransition(() => {
      setTranscriptEntries((prev) => [...prev, ...entries]);
    });
  }, []);

  const appendTranscriptEntry = useCallback((entry: TranscriptEntry) => {
    appendTranscriptEntries([entry]);
  }, [appendTranscriptEntries]);

  const patchLivePane = useCallback((patch: Partial<LivePaneState>) => {
    startTransition(() => {
      setLivePane((prev) => ({ ...prev, ...patch }));
    });
  }, []);

  const resetLivePane = useCallback(() => {
    startTransition(() => {
      setLivePane(INITIAL_LIVE_PANE);
    });
  }, []);

  const patchAppState = useCallback((patch: Partial<AppState>) => {
    startTransition(() => {
      setState(patch);
    });
  }, [setState]);

  const makeEntry = useCallback(
    (
      kind: TranscriptEntry['kind'],
      content: string,
      renderMode: TranscriptEntry['renderMode'],
      extras?: Pick<TranscriptEntry, 'toolCallData'>,
    ): TranscriptEntry => ({
      id: nextTranscriptId(),
      kind,
      turnId: currentTurnIdRef.current,
      renderMode,
      content,
      toolCallData: extras?.toolCallData,
    }),
    [],
  );

  const flushThinkingToTranscript = useCallback(
    (nextMode: LivePaneState['mode'] = 'idle') => {
      if (thinkingDraftRef.current.length === 0) {
        patchLivePane({ thinkingText: '', mode: nextMode });
        return;
      }

      const content = thinkingDraftRef.current;
      thinkingDraftRef.current = '';
      appendTranscriptEntry(makeEntry('thinking', content, 'plain'));
      patchLivePane({
        mode: nextMode,
        thinkingText: '',
      });
    },
    [appendTranscriptEntry, makeEntry, patchLivePane],
  );

  const flushCommittedAssistantBlocks = useCallback(() => {
    if (assistantDraftRef.current.length === 0) return;

    const { committed } = committedBoundary(assistantDraftRef.current);
    if (committed.length <= assistantCommittedLengthRef.current) return;

    const content = committed.slice(assistantCommittedLengthRef.current);
    assistantCommittedLengthRef.current = committed.length;
    appendTranscriptEntry(makeEntry('assistant', content, 'markdown'));
  }, [appendTranscriptEntry, makeEntry]);

  const flushAssistantDraft = useCallback(() => {
    flushCommittedAssistantBlocks();

    const remaining = assistantDraftRef.current.slice(assistantCommittedLengthRef.current);
    if (remaining.length > 0) {
      appendTranscriptEntry(makeEntry('assistant', remaining, 'markdown'));
    }

    assistantDraftRef.current = '';
    assistantCommittedLengthRef.current = 0;
    patchLivePane({ assistantText: '' });
  }, [appendTranscriptEntry, flushCommittedAssistantBlocks, makeEntry, patchLivePane]);

  const flushTurnBuffers = useCallback(
    (nextMode: LivePaneState['mode'] = 'idle') => {
      flushThinkingToTranscript(nextMode);
      flushAssistantDraft();
    },
    [flushAssistantDraft, flushThinkingToTranscript],
  );

  const enqueueMessage = useCallback((text: string) => {
    queueIdCounter.current += 1;
    const item: QueuedMessage = { id: `q-${String(queueIdCounter.current)}`, text };
    setQueuedMessages((prev) => [...prev, item]);
  }, []);

  const removeFromQueue = useCallback((id: string) => {
    setQueuedMessages((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const editQueueItem = useCallback((id: string, text: string) => {
    setQueuedMessages((prev) => prev.map((m) => (m.id === id ? { ...m, text } : m)));
  }, []);

  const recallLastQueued = useCallback((): string | undefined => {
    let recalled: string | undefined;
    setQueuedMessages((prev) => {
      if (prev.length === 0) return prev;
      recalled = prev[prev.length - 1]!.text;
      return prev.slice(0, -1);
    });
    return recalled;
  }, []);

  const dequeueFirst = useCallback((): string | undefined => {
    let dequeued: string | undefined;
    setQueuedMessages((prev) => {
      if (prev.length === 0) return prev;
      dequeued = prev[0]!.text;
      return prev.slice(1);
    });
    return dequeued;
  }, []);

  const steerMessage = useCallback((text: string) => {
    if (!isStreamingRef.current) {
      sendMessageInternalRef.current?.(text);
      return;
    }

    appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'user',
      turnId: currentTurnIdRef.current,
      renderMode: 'plain',
      content: text,
    });

    void wireClient.steer(sessionId, text);
  }, [appendTranscriptEntry, sessionId, wireClient]);

  const cancelStream = useCallback(() => {
    void wireClient.cancel(sessionId);
  }, [wireClient, sessionId]);

  const handleApprovalResponse = useCallback(
    (response: ApprovalResponseData) => {
      const approval = livePane.pendingApproval;
      if (approval === null) return;

      wireClient.respondToRequest(approval.requestId, response);
      patchLivePane({ pendingApproval: null, mode: isStreamingRef.current ? 'waiting' : 'idle' });
    },
    [livePane.pendingApproval, patchLivePane, wireClient],
  );

  const handleQuestionResponse = useCallback(
    (answers: string[]) => {
      const question = livePane.pendingQuestion;
      if (question === null) return;

      wireClient.respondToRequest(question.requestId, { answers });
      patchLivePane({ pendingQuestion: null, mode: isStreamingRef.current ? 'waiting' : 'idle' });
    },
    [livePane.pendingQuestion, patchLivePane, wireClient],
  );

  const dismissToast = useCallback((id: string) => {
    const timer = toastTimersRef.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      toastTimersRef.current.delete(id);
    }

    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback((notification: NotificationData) => {
    setToasts((prev) => {
      if (prev.some((toast) => toast.id === notification.id)) {
        return prev;
      }

      const toast: ToastNotification = {
        id: notification.id,
        category: notification.category,
        type: notification.type,
        title: notification.title,
        body: notification.body,
        severity: notification.severity,
      };

      return [...prev, toast];
    });

    const existing = toastTimersRef.current.get(notification.id);
    if (existing !== undefined) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      toastTimersRef.current.delete(notification.id);
      setToasts((prev) => prev.filter((toast) => toast.id !== notification.id));
    }, TOAST_TTL_MS);

    toastTimersRef.current.set(notification.id, timer);
  }, []);

  const finalizeTurn = useCallback(() => {
    if (!isStreamingRef.current) {
      return;
    }

    flushTurnBuffers('idle');
    activeToolCallsRef.current.clear();
    currentTurnIdRef.current = undefined;
    isStreamingRef.current = false;

    setQueuedMessages((prev) => {
      if (prev.length > 0) {
        const [next, ...rest] = prev;
        setTimeout(() => sendMessageInternalRef.current?.(next!.text), 0);
        return rest;
      }
      return prev;
    });

    patchAppState({
      isStreaming: false,
      streamingPhase: 'idle',
    });
    resetLivePane();
  }, [flushTurnBuffers, patchAppState, resetLivePane]);

  const processMessage = useCallback((msg: WireMessage) => {
    if (msg.turn_id !== undefined) {
      currentTurnIdRef.current = msg.turn_id;
    }

    if (msg.type === 'request') {
      if (msg.method === 'approval.request') {
        flushTurnBuffers('approval');
        const data = msg.data as ApprovalRequestData;
        patchLivePane({
          mode: 'approval',
          pendingApproval: { requestId: msg.id, data },
          pendingQuestion: null,
          pendingToolCall: null,
        });
      } else if (msg.method === 'question.request') {
        flushTurnBuffers('question');
        const data = msg.data as QuestionRequestData;
        patchLivePane({
          mode: 'question',
          pendingApproval: null,
          pendingQuestion: { requestId: msg.id, data },
          pendingToolCall: null,
        });
      }
      return;
    }

    if (msg.type !== 'event') return;

    switch (msg.method) {
      case 'content.delta': {
        const data = msg.data as ContentDeltaData;

        if (data.type === 'think' && data.think !== undefined) {
          thinkingDraftRef.current += data.think;
          patchLivePane({
            mode: 'thinking',
            thinkingText: thinkingDraftRef.current,
          });
          patchAppState({ streamingPhase: 'thinking' });
          break;
        }

        if (data.type === 'text' && data.text !== undefined) {
          if (thinkingDraftRef.current.length > 0) {
            flushThinkingToTranscript('idle');
          }

          assistantDraftRef.current += data.text;
          flushCommittedAssistantBlocks();
          patchLivePane({
            mode: 'idle',
            pendingToolCall: null,
            pendingApproval: null,
            pendingQuestion: null,
          });
          patchAppState({
            streamingPhase: 'composing',
            streamingStartTime: Date.now(),
          });
        }

        break;
      }
      case 'tool.call': {
        const data = msg.data as ToolCallData;
        const toolCall: ToolCallBlockData = {
          id: data.id,
          name: data.name,
          args: data.args,
          description: data.description,
        };

        activeToolCallsRef.current.set(data.id, toolCall);
        flushTurnBuffers('tool');
        patchLivePane({
          mode: 'tool',
          pendingToolCall: toolCall,
          pendingApproval: null,
          pendingQuestion: null,
        });
        break;
      }
      case 'tool.result': {
        const data = msg.data as ToolResultData;
        const matchedCall = activeToolCallsRef.current.get(data.tool_call_id);
        const resultData: ToolResultBlockData = {
          tool_call_id: data.tool_call_id,
          output: data.output,
          is_error: data.is_error,
        };

        if (matchedCall !== undefined) {
          appendTranscriptEntry(
            makeEntry('tool_call', `Used ${matchedCall.name}`, 'plain', {
              toolCallData: { ...matchedCall, result: resultData },
            }),
          );
        }

        activeToolCallsRef.current.delete(data.tool_call_id);
        patchLivePane({
          mode: 'idle',
          pendingToolCall: null,
        });
        break;
      }
      case 'status.update': {
        const data = msg.data as StatusUpdateData;
        const patch: Partial<AppState> = {};

        if (data.context_usage !== undefined) {
          patch.contextUsage = data.context_usage;
        }
        if (data.context_tokens !== undefined) {
          patch.contextTokens = data.context_tokens;
        }
        if (data.max_context_tokens !== undefined) {
          patch.maxContextTokens = data.max_context_tokens;
        }
        if (data.plan_mode !== undefined) {
          patch.planMode = data.plan_mode;
        }
        if (data.model !== undefined) {
          patch.model = data.model;
        }

        if (Object.keys(patch).length > 0) {
          patchAppState(patch);
        }
        break;
      }
      case 'step.begin': {
        patchLivePane({
          mode: 'waiting',
          pendingToolCall: null,
          pendingApproval: null,
          pendingQuestion: null,
        });
        patchAppState({
          streamingPhase: 'waiting',
          streamingStartTime: Date.now(),
        });
        break;
      }
      case 'turn.begin': {
        isStreamingRef.current = true;
        patchLivePane({
          mode: 'waiting',
          thinkingText: '',
          assistantText: '',
          pendingToolCall: null,
          pendingApproval: null,
          pendingQuestion: null,
        });
        patchAppState({
          isStreaming: true,
          streamingPhase: 'waiting',
          streamingStartTime: Date.now(),
        });
        break;
      }
      case 'turn.end': {
        finalizeTurn();
        break;
      }
      case 'step.interrupted': {
        const data = msg.data as StepInterruptedData;
        flushTurnBuffers('idle');
        appendTranscriptEntry(
          makeEntry('status', `Step ${String(data.step)} interrupted: ${data.reason}`, 'plain'),
        );
        break;
      }
      case 'compaction.begin': {
        flushTurnBuffers('waiting');
        patchAppState({
          streamingPhase: 'waiting',
          streamingStartTime: Date.now(),
        });
        appendTranscriptEntry(makeEntry('status', 'Compacting context...', 'plain'));
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
        appendTranscriptEntry(makeEntry('status', summary, 'plain'));
        break;
      }
      case 'notification': {
        pushToast(msg.data as NotificationData);
        break;
      }
      case 'session.error': {
        const data = msg.data as SessionErrorData;
        flushTurnBuffers('idle');
        const detail = data.error_type !== undefined ? ` (${data.error_type})` : '';
        appendTranscriptEntry(makeEntry('status', `Error${detail}: ${data.error}`, 'plain'));
        break;
      }
      default:
        break;
    }
  }, [appendTranscriptEntry, finalizeTurn, flushCommittedAssistantBlocks, flushThinkingToTranscript, flushTurnBuffers, makeEntry, patchAppState, patchLivePane, pushToast]);

  useEffect(() => {
    let active = true;

    void (async () => {
      try {
        for await (const msg of wireClient.subscribe(sessionId)) {
          if (!active) break;
          processMessage(msg);
        }
      } catch {
        // Ignore stream shutdown errors.
      }
    })();

    return () => {
      active = false;
    };
  }, [processMessage, sessionId, wireClient]);

  const sendMessageInternal = useCallback((input: string) => {
    appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'user',
      turnId: undefined,
      renderMode: 'plain',
      content: input,
    });

    currentTurnIdRef.current = undefined;
    assistantDraftRef.current = '';
    assistantCommittedLengthRef.current = 0;
    thinkingDraftRef.current = '';
    activeToolCallsRef.current.clear();
    isStreamingRef.current = true;

    patchLivePane({
      mode: 'waiting',
      thinkingText: '',
      assistantText: '',
      pendingToolCall: null,
      pendingApproval: null,
      pendingQuestion: null,
    });
    patchAppState({
      isStreaming: true,
      streamingPhase: 'waiting',
      streamingStartTime: Date.now(),
    });

    void wireClient.prompt(sessionId, input);
  }, [appendTranscriptEntry, patchAppState, patchLivePane, sessionId, wireClient]);

  sendMessageInternalRef.current = sendMessageInternal;

  const sendMessage = useCallback((input: string) => {
    if (isStreamingRef.current) {
      enqueueMessage(input);
      return;
    }
    sendMessageInternal(input);
  }, [enqueueMessage, sendMessageInternal]);

  useEffect(() => {
    return () => {
      for (const timer of toastTimersRef.current.values()) {
        clearTimeout(timer);
      }
      toastTimersRef.current.clear();
    };
  }, []);

  return {
    transcriptEntries,
    appendTranscriptEntry,
    livePane,
    sendMessage,
    cancelStream,
    handleApprovalResponse,
    handleQuestionResponse,
    toasts,
    dismissToast,
    queuedMessages,
    enqueueMessage,
    removeFromQueue,
    editQueueItem,
    steerMessage,
    recallLastQueued,
    dequeueFirst,
  };
}
