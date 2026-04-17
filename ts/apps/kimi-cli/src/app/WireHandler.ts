/**
 * Wire client integration — class-based replacement for useWire hook.
 *
 * Processes WireMessage events and drives InteractiveMode callbacks.
 */

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
} from '../wire/index.js';
import type {
  AppState,
  TranscriptEntry,
  ToolCallBlockData,
  ToolResultBlockData,
  LivePaneState,
  ToastNotification,
  QueuedMessage,
} from './state.js';

const TOAST_TTL_MS = 5000;

let transcriptIdCounter = 0;

function nextTranscriptId(): string {
  transcriptIdCounter += 1;
  return `entry-${String(transcriptIdCounter)}`;
}

export interface WireHandlerDelegate {
  getState(): AppState;
  setState(patch: Partial<AppState>): void;
  getLivePane(): LivePaneState;
  setLivePane(pane: LivePaneState): void;
  patchLivePane(patch: Partial<LivePaneState>): void;
  resetLivePane(): void;
  addTranscriptEntry(entry: TranscriptEntry): void;
  addToast(toast: ToastNotification): void;
  removeToast(id: string): void;
  onStreamingTextStart(): void;
  onStreamingTextUpdate(fullText: string): void;
  onStreamingTextEnd(): void;
  onToolCallStart(toolCall: ToolCallBlockData): void;
  onToolCallEnd(toolCallId: string, result: ToolResultBlockData): void;
  routeSubagentEvent(parentToolCallId: string, payload: SubagentRoutedPayload): void;
  /**
   * Called when the `SetTodoList` tool finishes. `todos` is the
   * authoritative new list (empty → cleared). Host implementations
   * should mirror the Python UX by pinning this above the input.
   */
  setTodoList(todos: readonly { title: string; status: 'pending' | 'in_progress' | 'done' }[]): void;
}

export interface SubagentRoutedPayload {
  readonly agent_id: string;
  readonly agent_name?: string | undefined;
  readonly sub_event: {
    readonly method: string;
    readonly data: unknown;
  };
}

export class WireHandler {
  private wireClient: WireClient;
  private sessionId: string;
  private delegate: WireHandlerDelegate;

  private isStreaming = false;
  private currentTurnId: string | undefined = undefined;
  private assistantDraft = '';
  private assistantStreamActive = false;
  private thinkingDraft = '';
  private activeToolCalls = new Map<string, ToolCallBlockData>();
  private toastTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private aborted = false;

  private queuedMessages: QueuedMessage[] = [];
  private queueIdCounter = 0;

  constructor(
    wireClient: WireClient,
    sessionId: string,
    delegate: WireHandlerDelegate,
    private readonly colors: import('../theme/colors.js').ColorPalette,
  ) {
    this.wireClient = wireClient;
    this.sessionId = sessionId;
    this.delegate = delegate;
  }

  private makeEntry(
    kind: TranscriptEntry['kind'],
    content: string,
    renderMode: TranscriptEntry['renderMode'],
    extras?: Pick<TranscriptEntry, 'toolCallData' | 'color'>,
  ): TranscriptEntry {
    return {
      id: nextTranscriptId(),
      kind,
      turnId: this.currentTurnId,
      renderMode,
      content,
      toolCallData: extras?.toolCallData,
      color: extras?.color,
    };
  }

  private flushThinkingToTranscript(nextMode: LivePaneState['mode'] = 'idle'): void {
    if (this.thinkingDraft.length === 0) {
      this.delegate.patchLivePane({ thinkingText: '', mode: nextMode });
      return;
    }
    const content = this.thinkingDraft;
    this.thinkingDraft = '';
    this.delegate.addTranscriptEntry(this.makeEntry('thinking', content, 'plain'));
    this.delegate.patchLivePane({ mode: nextMode, thinkingText: '' });
  }

  private finalizeAssistantStream(): void {
    if (this.assistantStreamActive) {
      this.delegate.onStreamingTextEnd();
      this.assistantStreamActive = false;
    }
    this.assistantDraft = '';
    this.delegate.patchLivePane({ assistantText: '' });
  }

  private flushTurnBuffers(nextMode: LivePaneState['mode'] = 'idle'): void {
    this.flushThinkingToTranscript(nextMode);
    this.finalizeAssistantStream();
  }

  private finalizeTurn(): void {
    if (!this.isStreaming) return;
    this.flushTurnBuffers('idle');
    this.activeToolCalls.clear();
    this.currentTurnId = undefined;
    this.isStreaming = false;

    if (this.queuedMessages.length > 0) {
      const [next, ...rest] = this.queuedMessages;
      this.queuedMessages = rest;
      this.delegate.setState({ isStreaming: false, streamingPhase: 'idle' });
      this.delegate.resetLivePane();
      setTimeout(() => this.sendMessageInternal(next!.text), 0);
      return;
    }

    this.delegate.setState({ isStreaming: false, streamingPhase: 'idle' });
    this.delegate.resetLivePane();
  }

  private pushToast(notification: NotificationData): void {
    const toast: ToastNotification = {
      id: notification.id,
      category: notification.category,
      type: notification.type,
      title: notification.title,
      body: notification.body,
      severity: notification.severity,
    };
    this.delegate.addToast(toast);

    const existing = this.toastTimers.get(notification.id);
    if (existing !== undefined) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.toastTimers.delete(notification.id);
      this.delegate.removeToast(notification.id);
    }, TOAST_TTL_MS);
    this.toastTimers.set(notification.id, timer);
  }

  processMessage(msg: WireMessage): void {
    if (msg.turn_id !== undefined) {
      this.currentTurnId = msg.turn_id;
    }

    if (msg.type === 'request') {
      if (msg.method === 'approval.request') {
        this.flushTurnBuffers('approval');
        const data = msg.data as ApprovalRequestData;
        this.delegate.patchLivePane({
          mode: 'approval',
          pendingApproval: { requestId: msg.id, data },
          pendingQuestion: null,
          pendingToolCall: null,
        });
      } else if (msg.method === 'question.request') {
        this.flushTurnBuffers('question');
        const data = msg.data as QuestionRequestData;
        this.delegate.patchLivePane({
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
          this.thinkingDraft += data.think;
          this.delegate.patchLivePane({
            mode: 'thinking',
            thinkingText: this.thinkingDraft,
          });
          this.delegate.setState({ streamingPhase: 'thinking' });
          break;
        }
        if (data.type === 'text' && data.text !== undefined) {
          if (this.thinkingDraft.length > 0) {
            this.flushThinkingToTranscript('idle');
          }

          if (!this.assistantStreamActive) {
            this.assistantStreamActive = true;
            this.delegate.onStreamingTextStart();
          }

          this.assistantDraft += data.text;
          this.delegate.onStreamingTextUpdate(this.assistantDraft);

          this.delegate.patchLivePane({
            mode: 'idle',
            pendingToolCall: null,
            pendingApproval: null,
            pendingQuestion: null,
          });
          this.delegate.setState({
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
        this.activeToolCalls.set(data.id, toolCall);
        this.flushTurnBuffers('tool');
        this.delegate.onToolCallStart(toolCall);
        this.delegate.patchLivePane({
          mode: 'tool',
          pendingToolCall: toolCall,
          pendingApproval: null,
          pendingQuestion: null,
        });
        break;
      }
      case 'tool.result': {
        const data = msg.data as ToolResultData;
        const matchedCall = this.activeToolCalls.get(data.tool_call_id);
        const resultData: ToolResultBlockData = {
          tool_call_id: data.tool_call_id,
          output: data.output,
          is_error: data.is_error,
        };
        if (matchedCall !== undefined) {
          this.delegate.onToolCallEnd(data.tool_call_id, resultData);
          // SetTodoList: surface the authoritative todo list to the
          // host so it can pin the pane above the input. `args.todos`
          // is the LLM-sent list (undefined = query-only, which we
          // intentionally don't propagate since no state changed).
          if (matchedCall.name === 'SetTodoList' && !data.is_error) {
            const rawTodos = (matchedCall.args as { todos?: unknown }).todos;
            if (Array.isArray(rawTodos)) {
              const sanitized = rawTodos
                .filter(isTodoItemShape)
                .map((t) => ({ title: t.title, status: t.status }));
              this.delegate.setTodoList(sanitized);
            }
          }
        }
        this.activeToolCalls.delete(data.tool_call_id);
        this.delegate.patchLivePane({ mode: 'idle', pendingToolCall: null });
        break;
      }
      case 'status.update': {
        const data = msg.data as StatusUpdateData;
        const patch: Partial<AppState> = {};
        if (data.context_usage !== undefined) patch.contextUsage = data.context_usage;
        if (data.context_tokens !== undefined) patch.contextTokens = data.context_tokens;
        if (data.max_context_tokens !== undefined) patch.maxContextTokens = data.max_context_tokens;
        if (data.plan_mode !== undefined) patch.planMode = data.plan_mode;
        if (data.model !== undefined) patch.model = data.model;
        if (Object.keys(patch).length > 0) this.delegate.setState(patch);
        break;
      }
      case 'step.begin': {
        this.delegate.patchLivePane({
          mode: 'waiting',
          pendingToolCall: null,
          pendingApproval: null,
          pendingQuestion: null,
        });
        this.delegate.setState({
          streamingPhase: 'waiting',
          streamingStartTime: Date.now(),
        });
        break;
      }
      case 'turn.begin': {
        this.isStreaming = true;
        this.delegate.patchLivePane({
          mode: 'waiting',
          thinkingText: '',
          assistantText: '',
          pendingToolCall: null,
          pendingApproval: null,
          pendingQuestion: null,
        });
        this.delegate.setState({
          isStreaming: true,
          streamingPhase: 'waiting',
          streamingStartTime: Date.now(),
        });
        break;
      }
      case 'turn.end': {
        this.finalizeTurn();
        break;
      }
      case 'step.interrupted': {
        void (msg.data as StepInterruptedData);
        this.flushTurnBuffers('idle');
        this.delegate.addTranscriptEntry(
          this.makeEntry('status', 'Interrupted by user', 'plain', { color: this.colors.error }),
        );
        break;
      }
      case 'compaction.begin': {
        this.flushTurnBuffers('waiting');
        this.delegate.setState({ streamingPhase: 'waiting', streamingStartTime: Date.now() });
        this.delegate.addTranscriptEntry(this.makeEntry('status', 'Compacting context...', 'plain'));
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
        this.delegate.addTranscriptEntry(this.makeEntry('status', summary, 'plain'));
        break;
      }
      case 'notification': {
        this.pushToast(msg.data as NotificationData);
        break;
      }
      case 'session.error': {
        const data = msg.data as SessionErrorData;
        this.flushTurnBuffers('idle');
        const detail = data.error_type !== undefined ? ` (${data.error_type})` : '';
        this.delegate.addTranscriptEntry(
          this.makeEntry('status', `Error${detail}: ${data.error}`, 'plain'),
        );
        break;
      }
      case 'subagent.event': {
        const data = msg.data as {
          parent_tool_call_id?: unknown;
          agent_id?: unknown;
          agent_name?: unknown;
          sub_event?: unknown;
        };
        if (
          typeof data.parent_tool_call_id !== 'string' ||
          typeof data.agent_id !== 'string' ||
          typeof data.sub_event !== 'object' ||
          data.sub_event === null
        ) {
          break;
        }
        const se = data.sub_event as { method?: unknown; data?: unknown };
        if (typeof se.method !== 'string') break;
        this.delegate.routeSubagentEvent(data.parent_tool_call_id, {
          agent_id: data.agent_id,
          ...(typeof data.agent_name === 'string' ? { agent_name: data.agent_name } : {}),
          sub_event: { method: se.method, data: se.data },
        });
        break;
      }
      default:
        break;
    }
  }

  async start(): Promise<void> {
    try {
      for await (const msg of this.wireClient.subscribe(this.sessionId)) {
        if (this.aborted) break;
        this.processMessage(msg);
      }
    } catch {
      // stream shutdown
    }
  }

  stop(): void {
    this.aborted = true;
    for (const timer of this.toastTimers.values()) {
      clearTimeout(timer);
    }
    this.toastTimers.clear();
  }

  private sendMessageInternal(input: string): void {
    this.delegate.addTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'user',
      turnId: undefined,
      renderMode: 'plain',
      content: input,
    });

    this.currentTurnId = undefined;
    this.assistantDraft = '';
    this.assistantStreamActive = false;
    this.thinkingDraft = '';
    this.activeToolCalls.clear();
    this.isStreaming = true;

    this.delegate.patchLivePane({
      mode: 'waiting',
      thinkingText: '',
      assistantText: '',
      pendingToolCall: null,
      pendingApproval: null,
      pendingQuestion: null,
    });
    this.delegate.setState({
      isStreaming: true,
      streamingPhase: 'waiting',
      streamingStartTime: Date.now(),
    });

    void this.wireClient.prompt(this.sessionId, input);
  }

  sendMessage(input: string): void {
    if (this.isStreaming) {
      this.enqueueMessage(input);
      return;
    }
    this.sendMessageInternal(input);
  }

  steerMessage(input: string): void {
    if (!this.isStreaming) {
      this.sendMessageInternal(input);
      return;
    }

    this.delegate.addTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'user',
      turnId: this.currentTurnId,
      renderMode: 'plain',
      content: input,
    });

    void this.wireClient.steer(this.sessionId, input);
  }

  // ── Queue management ──────────────────────────────────────────────

  enqueueMessage(text: string): void {
    this.queueIdCounter += 1;
    this.queuedMessages.push({ id: `q-${String(this.queueIdCounter)}`, text });
  }

  removeFromQueue(id: string): void {
    this.queuedMessages = this.queuedMessages.filter((m) => m.id !== id);
  }

  editQueueItem(id: string, text: string): void {
    this.queuedMessages = this.queuedMessages.map((m) => (m.id === id ? { ...m, text } : m));
  }

  recallLastQueued(): string | undefined {
    if (this.queuedMessages.length === 0) return undefined;
    const last = this.queuedMessages[this.queuedMessages.length - 1]!;
    this.queuedMessages = this.queuedMessages.slice(0, -1);
    return last.text;
  }

  dequeueFirst(): string | undefined {
    if (this.queuedMessages.length === 0) return undefined;
    const first = this.queuedMessages[0]!;
    this.queuedMessages = this.queuedMessages.slice(1);
    return first.text;
  }

  getQueuedMessages(): readonly QueuedMessage[] {
    return this.queuedMessages;
  }

  cancelStream(): void {
    void this.wireClient.cancel(this.sessionId);
  }

  handleApprovalResponse(response: ApprovalResponseData): void {
    const pane = this.delegate.getLivePane();
    if (pane.pendingApproval === null) return;
    this.wireClient.respondToRequest(pane.pendingApproval.requestId, response);
    this.delegate.patchLivePane({
      pendingApproval: null,
      mode: this.isStreaming ? 'waiting' : 'idle',
    });
  }

  handleQuestionResponse(answers: string[]): void {
    const pane = this.delegate.getLivePane();
    if (pane.pendingQuestion === null) return;
    this.wireClient.respondToRequest(pane.pendingQuestion.requestId, { answers });
    this.delegate.patchLivePane({
      pendingQuestion: null,
      mode: this.isStreaming ? 'waiting' : 'idle',
    });
  }

  dismissToast(id: string): void {
    const timer = this.toastTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.toastTimers.delete(id);
    }
    this.delegate.removeToast(id);
  }
}

function isTodoItemShape(
  value: unknown,
): value is { title: string; status: 'pending' | 'in_progress' | 'done' } {
  if (typeof value !== 'object' || value === null) return false;
  const rec = value as { title?: unknown; status?: unknown };
  if (typeof rec.title !== 'string' || rec.title.length === 0) return false;
  return rec.status === 'pending' || rec.status === 'in_progress' || rec.status === 'done';
}
