/**
 * InteractiveMode — main TUI orchestrator replacing App.tsx + Shell.tsx.
 *
 * Owns the pi-tui TUI instance, layout containers, and event loop.
 */

import {
  TUI,
  ProcessTerminal,
  CombinedAutocompleteProvider,
  type Component,
  type SlashCommand,
  Container,
  Spacer,
  Text,
  type MarkdownTheme,
  type EditorTheme,
} from '@mariozechner/pi-tui';
import chalk from 'chalk';
import type { LoginOptions } from '@moonshot-ai/core';

import type {
  WireClient,
  ApprovalResponseData,
} from '../wire/index.js';
import type { SessionInfo } from '../wire/methods.js';
import { createDefaultRegistry, parseSlashInput } from '../slash/index.js';
import type { SlashCommandContext } from '../slash/index.js';
import { tryDispatchSkill } from '../slash/skill-dispatch.js';
import { getColorPalette } from '../theme/colors.js';
import type { ColorPalette } from '../theme/colors.js';
import { createThemeStyles } from '../theme/styles.js';
import { createMarkdownTheme, createEditorTheme } from '../theme/pi-tui-theme.js';

import type {
  AppState,
  TranscriptEntry,
  LivePaneState,
  ToastNotification,
} from './state.js';
import { INITIAL_LIVE_PANE } from './state.js';
import { decideSessionSwitch } from './session-switch.js';
import { WireHandler, type WireHandlerDelegate } from './WireHandler.js';

import { CustomEditor } from '../components/CustomEditor.js';
import { ChoicePickerComponent, type ChoiceOption } from '../components/ChoicePickerComponent.js';
import { getInputHistoryFile } from '../config/paths.js';
import { loadInputHistory, appendInputHistory } from '../utils/input-history.js';
import { editInExternalEditor, resolveEditorCommand } from '../utils/external-editor.js';
import { saveConfigPatch } from '../config/save.js';
import {
  formatTokenCount,
  renderProgressBar,
  ratioSeverity,
} from '../utils/usage-format.js';
import {
  fetchManagedUsage,
  isManagedKimiCode,
  kimiCodeUsageUrl,
  type UsageRow,
} from '../utils/managed-usage.js';
import { WelcomeComponent } from '../components/WelcomeComponent.js';
import { FooterComponent } from '../components/FooterComponent.js';
import { UserMessageComponent } from '../components/UserMessageComponent.js';
import { AssistantMessageComponent } from '../components/AssistantMessageComponent.js';
import { ThinkingComponent } from '../components/ThinkingComponent.js';
import { LiveThinkingComponent } from '../components/LiveThinkingComponent.js';
import { ToolCallComponent } from '../components/ToolCallComponent.js';
import { ApprovalPanelComponent } from '../components/ApprovalPanelComponent.js';
import { QuestionDialogComponent } from '../components/QuestionDialogComponent.js';
import { SessionPickerComponent } from '../components/SessionPickerComponent.js';
import { HelpPanelComponent } from '../components/HelpPanelComponent.js';
import { TodoPanelComponent, type TodoItem } from '../components/TodoPanelComponent.js';
import { MoonLoader } from '../components/MoonLoader.js';

interface Expandable {
  setExpanded(expanded: boolean): void;
}

function isExpandable(obj: unknown): obj is Expandable {
  return typeof obj === 'object' && obj !== null && 'setExpanded' in obj && typeof (obj as Expandable).setExpanded === 'function';
}

export interface AppOAuthManager {
  logout(): Promise<void>;
  login(options?: LoginOptions): Promise<unknown>;
  hasToken(): Promise<boolean>;
  /** Refresh if needed and return a valid access_token. */
  ensureFresh(options?: { force?: boolean }): Promise<string>;
}

export interface InteractiveModeOptions {
  oauthManagers?: ReadonlyMap<string, AppOAuthManager> | undefined;
  mcpManager?: { close(): Promise<void> } | undefined;
  /**
   * Phase 21 Slice F — when set, the TUI boots without a pre-created
   * session and immediately shows the session picker. Selecting a
   * session resumes it; cancelling exits the process.
   */
  pickerMode?: boolean | undefined;
  /**
   * Phase 21 review hotfix — callback invoked after the picker resolves
   * a session, so the host can run the post-resume steps that
   * `bootstrapCoreShell` would have done inline for a non-picker boot
   * (attach BackgroundProcessManager to the session dir, sync
   * `--plan` / `--yolo` into the core, etc.). Runs *after*
   * `resumeSession` settles and the handler is wired.
   */
  onSessionPicked?: (sessionId: string) => Promise<void>;
}

export class InteractiveMode implements WireHandlerDelegate {
  private ui: TUI;
  private state: AppState;
  private livePane: LivePaneState;
  private wireClient: WireClient;
  private wireHandler: WireHandler;
  private colors: ColorPalette;
  private markdownTheme: MarkdownTheme;

  private transcriptContainer: Container;
  private activityContainer: Container;
  private todoPanelContainer: Container;
  private todoPanel: TodoPanelComponent;
  private queueContainer: Container;
  private editorContainer: Container;
  private footer: FooterComponent;
  private editor: CustomEditor;
  private loadingAnimation: MoonLoader | undefined;
  private phaseSpinner: MoonLoader | undefined;
  private liveThinking: LiveThinkingComponent | undefined;
  private streamingComponent: AssistantMessageComponent | undefined;
  private pendingToolComponents = new Map<string, ToolCallComponent>();
  private toolOutputExpanded = false;
  private lastHistoryContent: string | undefined;
  /** Raw transcript entries — kept so `/theme` and `/clear` can rebuild
   * the corresponding components from the same source data. */
  private transcriptEntries: TranscriptEntry[] = [];

  private toasts: ToastNotification[] = [];
  private sessions: SessionInfo[] = [];
  private loadingSessions = false;
  private showingSessionPicker = false;

  private registry;
  private oauthManagers: ReadonlyMap<string, AppOAuthManager> | undefined;
  private footerSubscription: (() => void) | undefined;
  private readonly pickerMode: boolean;
  private readonly onSessionPicked: ((sessionId: string) => Promise<void>) | undefined;

  public onExit?: () => Promise<void>;

  constructor(
    wireClient: WireClient,
    initialState: AppState,
    options?: InteractiveModeOptions,
  ) {
    this.wireClient = wireClient;
    this.state = { ...initialState };
    this.livePane = { ...INITIAL_LIVE_PANE };
    this.colors = getColorPalette(initialState.theme);
    this.oauthManagers = options?.oauthManagers;
    this.pickerMode = options?.pickerMode ?? false;
    this.onSessionPicked = options?.onSessionPicked;

    this.markdownTheme = createMarkdownTheme(this.colors);
    const editorTheme = createEditorTheme(this.colors);

    this.ui = new TUI(new ProcessTerminal());

    this.transcriptContainer = new Container();
    this.activityContainer = new Container();
    this.todoPanelContainer = new Container();
    this.todoPanel = new TodoPanelComponent(this.colors);
    this.queueContainer = new Container();
    this.editorContainer = new Container();
    this.editor = new CustomEditor(this.ui, editorTheme);
    this.editor.slashHighlightHex = this.colors.primary;
    this.footer = new FooterComponent(this.state, this.colors);

    this.wireHandler = new WireHandler(wireClient, initialState.sessionId, this, this.colors);

    if (this.oauthManagers !== undefined && this.oauthManagers.size > 0) {
      const managersMap = new Map<string, AppOAuthManager>();
      for (const [name, mgr] of this.oauthManagers) {
        managersMap.set(name, mgr);
      }
      const firstName = [...this.oauthManagers.keys()][0];
      this.registry = createDefaultRegistry({
        managers: managersMap,
        ...(firstName !== undefined ? { defaultProviderName: firstName } : {}),
      });
    } else {
      this.registry = createDefaultRegistry();
    }

    this.setupEditor();
    this.setupLayout();
  }

  private setupEditor(): void {
    this.editor.onSubmit = (text: string) => {
      this.handleUserInput(text);
    };

    this.editor.onChange = (text: string) => {
      this.updateEditorBorderHighlight(text);
    };

    this.editor.onCtrlC = () => {
      this.wireHandler.cancelStream();
    };

    this.editor.onCtrlD = () => {
      this.stop();
    };

    this.editor.onEscape = () => {
      if (this.showingSessionPicker) {
        this.hideSessionPicker();
        return;
      }
      if (this.state.isStreaming) {
        this.wireHandler.cancelStream();
      }
    };

    this.editor.onShiftTab = () => {
      void this.togglePlanMode();
    };

    this.editor.onOpenExternalEditor = () => {
      void this.openExternalEditor();
    };

    this.editor.onToggleToolExpand = () => {
      this.toggleToolOutputExpansion();
    };

    this.editor.onCtrlS = () => {
      if (!this.state.isStreaming) return;
      const text = this.editor.getText().trim();
      if (text.length > 0) {
        this.editor.setText('');
        this.wireHandler.steerMessage(text);
      } else {
        const first = this.wireHandler.dequeueFirst();
        if (first !== undefined) {
          this.wireHandler.steerMessage(first);
        }
      }
      this.updateQueueDisplay();
      this.ui.requestRender();
    };

    this.editor.onUpArrowEmpty = () => {
      if (!this.state.isStreaming) return false; // let pi-tui's history nav handle it
      const recalled = this.wireHandler.recallLastQueued();
      if (recalled !== undefined) {
        this.editor.setText(recalled);
        this.updateQueueDisplay();
        this.ui.requestRender();
        return true;
      }
      return false;
    };
  }

  private setupLayout(): void {
    this.ui.addChild(this.transcriptContainer);
    this.ui.addChild(this.activityContainer);
    this.ui.addChild(this.todoPanelContainer);
    this.ui.addChild(this.queueContainer);
    this.ui.addChild(this.editorContainer);
    this.ui.addChild(this.footer);
  }

  start(): void {
    this.renderWelcome();
    this.setupAutocomplete();
    void this.loadInputHistory();
    this.editorContainer.addChild(this.editor);
    this.ui.setFocus(this.editor);
    this.ui.start();
    if (!this.pickerMode) {
      this.attachFooterFeed();
      void this.wireHandler.start();
    }
    void this.fetchSessions();
    if (this.pickerMode) {
      // Defer picker launch one tick so the TUI has mounted its
      // layout before we swap focus to the picker component.
      setImmediate(() => {
        void this.bootstrapFromPicker();
      });
    }
  }

  /**
   * Phase 21 Slice F — subscribe the footer to the live wire feed. The
   * caller MUST dispose the previous subscription (via
   * `footerSubscription`) before rebinding, which happens naturally on
   * session switches because `switchSession` / `performModelSwitch` /
   * `spawnFreshSession` all replace `this.wireHandler` before calling
   * this method again.
   */
  private attachFooterFeed(): void {
    this.footerSubscription?.();
    this.footerSubscription = this.footer.attach(this.wireHandler, () => {
      // Keep delegate state in sync with the footer's local copy so
      // `/usage`, `/model`, etc. observe the latest wire-driven fields.
      this.state = { ...this.state };
      this.ui.requestRender();
    });
  }

  /**
   * Phase 21 Slice F — picker-first boot. Pulls the session list, shows
   * the picker, and blocks session creation until the user selects or
   * cancels. Selecting resumes the session and wires the handler
   * against it; cancelling exits the process with code 0.
   */
  private async bootstrapFromPicker(): Promise<void> {
    await this.fetchSessions();
    this.showingSessionPicker = true;
    this.editorContainer.clear();
    const picker = new SessionPickerComponent({
      sessions: this.sessions,
      loading: this.loadingSessions,
      currentSessionId: this.state.sessionId,
      colors: this.colors,
      onSelect: (sessionId: string) => {
        this.hideSessionPicker();
        void this.bootstrapPickedSession(sessionId);
      },
      onCancel: () => {
        // Cancelling the picker at boot means the user opted out of
        // resuming any session — exit cleanly instead of proceeding
        // with a half-initialised shell.
        process.exit(0);
      },
    });
    this.editorContainer.addChild(picker);
    this.ui.setFocus(picker);
    this.ui.requestRender();
  }

  private async bootstrapPickedSession(sessionId: string): Promise<void> {
    try {
      if (this.wireClient.resumeSession === undefined) {
        throw new Error('resumeSession not supported by this client');
      }
      const { session_id: resumedId } = await this.wireClient.resumeSession(sessionId);
      this.wireHandler = new WireHandler(this.wireClient, resumedId, this, this.colors);
      this.attachFooterFeed();
      void this.wireHandler.start();
      this.setState({ sessionId: resumedId });
      // Phase 21 review hotfix — now that we actually have a session,
      // let the host run the BPM attach / plan-mode / yolo sync steps
      // it skipped during bootstrapCoreShell. Swallow failures into
      // the transcript so a broken post-pick step doesn't wedge the
      // already-resumed session.
      if (this.onSessionPicked !== undefined) {
        try {
          await this.onSessionPicked(resumedId);
        } catch (postErr) {
          const msg = postErr instanceof Error ? postErr.message : String(postErr);
          this.addTranscriptEntry({
            id: `session-post-err-${String(Date.now())}`,
            kind: 'status',
            renderMode: 'plain',
            content: `Post-resume sync failed: ${msg}`,
            color: this.colors.error,
          });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.addTranscriptEntry({
        id: `session-err-${String(Date.now())}`,
        kind: 'status',
        renderMode: 'plain',
        content: `Failed to resume session: ${msg}`,
        color: this.colors.error,
      });
    }
  }

  private async loadInputHistory(): Promise<void> {
    try {
      const file = getInputHistoryFile(this.state.workDir);
      const entries = await loadInputHistory(file);
      for (const entry of entries) {
        this.editor.addToHistory(entry.content);
      }
      this.lastHistoryContent = entries.length > 0
        ? entries[entries.length - 1]!.content
        : undefined;
    } catch {
      // Ignore — history is best-effort.
    }
  }

  private setupAutocomplete(): void {
    const slashCommands: SlashCommand[] = this.registry.listAll().map((cmd) => ({
      name: cmd.name,
      description: cmd.description,
    }));
    const provider = new CombinedAutocompleteProvider(
      slashCommands,
      this.state.workDir,
    );
    this.editor.setAutocompleteProvider(provider);
  }

  /**
   * Phase 21 Slice F — expose the active session id so the launcher can
   * print a resume hint on exit. Returns an empty string when the user
   * never finished picking a session.
   */
  getCurrentSessionId(): string {
    return this.state.sessionId;
  }

  async stop(): Promise<void> {
    this.footerSubscription?.();
    this.footerSubscription = undefined;
    this.wireHandler.stop();
    this.ui.stop();
    if (this.onExit) {
      await this.onExit();
    }
  }

  private renderWelcome(): void {
    const welcome = new WelcomeComponent(this.state, this.colors);
    this.transcriptContainer.addChild(welcome);
  }

  // ── WireHandlerDelegate ─────────────────────────────────────────

  getState(): AppState {
    return this.state;
  }

  setState(patch: Partial<AppState>): void {
    Object.assign(this.state, patch);
    this.footer.setState(this.state);
    this.updateActivityPane();
    this.ui.requestRender();
  }

  getLivePane(): LivePaneState {
    return this.livePane;
  }

  setLivePane(pane: LivePaneState): void {
    this.livePane = pane;
    this.updateActivityPane();
    this.ui.requestRender();
  }

  patchLivePane(patch: Partial<LivePaneState>): void {
    const hadApproval = this.livePane.pendingApproval;
    const hadQuestion = this.livePane.pendingQuestion;
    Object.assign(this.livePane, patch);

    if (this.livePane.pendingApproval !== null && hadApproval === null) {
      this.showApprovalPanel(
        this.livePane.pendingApproval.requestId,
        this.livePane.pendingApproval.data,
      );
    } else if (this.livePane.pendingQuestion !== null && hadQuestion === null) {
      this.showQuestionDialog(
        this.livePane.pendingQuestion.requestId,
        this.livePane.pendingQuestion.data,
      );
    }

    this.updateActivityPane();
    this.ui.requestRender();
  }

  resetLivePane(): void {
    this.livePane = { ...INITIAL_LIVE_PANE };
    this.updateActivityPane();
    this.updateQueueDisplay();
    this.ui.requestRender();
  }

  addTranscriptEntry(entry: TranscriptEntry): void {
    this.transcriptEntries.push(entry);
    const component = this.createTranscriptComponent(entry);
    if (component) {
      this.transcriptContainer.addChild(component);
      this.ui.requestRender();
    }
  }

  addToast(toast: ToastNotification): void {
    if (this.toasts.some((t) => t.id === toast.id)) return;
    this.toasts.push(toast);
    this.ui.requestRender();
  }

  removeToast(id: string): void {
    this.toasts = this.toasts.filter((t) => t.id !== id);
    this.ui.requestRender();
  }

  onStreamingTextStart(): void {
    this.streamingComponent = new AssistantMessageComponent(this.markdownTheme);
    this.transcriptContainer.addChild(this.streamingComponent);
    this.ui.requestRender();
  }

  onStreamingTextUpdate(fullText: string): void {
    if (this.streamingComponent) {
      this.streamingComponent.updateContent(fullText);
      this.ui.requestRender();
    }
  }

  onStreamingTextEnd(): void {
    this.streamingComponent = undefined;
  }

  onToolCallStart(toolCall: import('./state.js').ToolCallBlockData): void {
    const tc = new ToolCallComponent(toolCall, undefined, this.colors, this.ui, this.markdownTheme);
    if (this.toolOutputExpanded) tc.setExpanded(true);
    this.pendingToolComponents.set(toolCall.id, tc);
    this.transcriptContainer.addChild(tc);
    this.ui.requestRender();
  }

  onToolCallEnd(toolCallId: string, result: import('./state.js').ToolResultBlockData): void {
    const tc = this.pendingToolComponents.get(toolCallId);
    if (tc) {
      tc.setResult(result);
      this.pendingToolComponents.delete(toolCallId);
      this.ui.requestRender();
    }
  }

  setTodoList(todos: readonly TodoItem[]): void {
    this.todoPanel.setTodos(todos);
    this.todoPanelContainer.clear();
    if (!this.todoPanel.isEmpty()) {
      this.todoPanelContainer.addChild(this.todoPanel);
    }
    this.ui.requestRender();
  }

  routeSubagentEvent(
    parentToolCallId: string,
    payload: import('./WireHandler.js').SubagentRoutedPayload,
  ): void {
    // pendingToolComponents only tracks still-streaming tool calls; for
    // sub events that arrive after the parent tool call resolved we'd
    // need a separate lookup. For now we drop late events silently —
    // Python does the same.
    const tc = this.pendingToolComponents.get(parentToolCallId);
    if (tc === undefined) return;
    tc.setSubagentMeta(payload.agent_id, payload.agent_name);

    const { method, data } = payload.sub_event;
    if (method === 'tool.call') {
      const d = data as { id?: unknown; name?: unknown; args?: unknown };
      if (typeof d.id === 'string' && typeof d.name === 'string') {
        tc.appendSubToolCall({
          id: d.id,
          name: d.name,
          args: typeof d.args === 'object' && d.args !== null
            ? (d.args as Record<string, unknown>)
            : {},
        });
      }
    } else if (method === 'tool.result') {
      const d = data as { tool_call_id?: unknown; output?: unknown; is_error?: unknown };
      if (typeof d.tool_call_id === 'string') {
        tc.finishSubToolCall({
          tool_call_id: d.tool_call_id,
          output: typeof d.output === 'string' ? d.output : '',
          ...(typeof d.is_error === 'boolean' ? { is_error: d.is_error } : {}),
        });
      }
    }
    // content.delta / thinking.delta / step.* 等忽略（与 Python 对齐）
  }

  // ── Transcript rendering ────────────────────────────────────────

  private createTranscriptComponent(entry: TranscriptEntry): Component | null {
    switch (entry.kind) {
      case 'user':
        return new UserMessageComponent(entry.content, this.colors);
      case 'assistant':
        return this.createAssistantEntry(entry.content);
      case 'thinking':
        return new ThinkingComponent(entry.content, this.colors, true);
      case 'tool_call':
        if (entry.toolCallData) {
          const tc = new ToolCallComponent(
            entry.toolCallData,
            entry.toolCallData.result,
            this.colors,
            this.ui,
            this.markdownTheme,
          );
          if (this.toolOutputExpanded) tc.setExpanded(true);
          return tc;
        }
        return this.createStatusEntry(entry.content, entry.color);
      case 'status':
        return this.createStatusEntry(entry.content, entry.color);
      default:
        return null;
    }
  }

  private createAssistantEntry(content: string): AssistantMessageComponent {
    const component = new AssistantMessageComponent(this.markdownTheme);
    component.updateContent(content);
    return component;
  }

  private createStatusEntry(content: string, color?: string): Container {
    const container = new Container();
    const styled = color
      ? chalk.hex(color)(content)
      : chalk.dim(content);
    container.addChild(new Text(`  ${styled}`, 0, 0));
    return container;
  }

  // ── Activity pane (streaming state) ─────────────────────────────

  private lastActivityMode: string | undefined;

  private updateActivityPane(): void {
    const effectiveMode = this.showingSessionPicker ? 'hidden'
      : this.livePane.pendingApproval !== null ? 'hidden'
      : this.livePane.pendingQuestion !== null ? 'hidden'
      : this.livePane.mode === 'idle' && this.state.streamingPhase === 'composing' ? 'composing'
      : this.livePane.mode;

    if (effectiveMode === this.lastActivityMode && (effectiveMode === 'waiting' || effectiveMode === 'tool')) {
      return;
    }

    this.activityContainer.clear();
    this.lastActivityMode = effectiveMode;

    switch (effectiveMode) {
      case 'hidden':
        this.stopLoader();
        this.stopPhaseSpinner();
        return;
      case 'waiting': {
        this.stopPhaseSpinner();
        if (!this.loadingAnimation) {
          this.loadingAnimation = new MoonLoader(this.ui, 'moon');
        }
        this.activityContainer.addChild(new Spacer(1));
        this.activityContainer.addChild(this.loadingAnimation);
        break;
      }
      case 'thinking': {
        this.stopLoader();
        if (!this.phaseSpinner) {
          this.phaseSpinner = new MoonLoader(this.ui, 'braille', (s) => chalk.hex(this.colors.text)(s), 'thinking...');
        }
        if (!this.liveThinking) {
          this.liveThinking = new LiveThinkingComponent(this.colors.thinking);
        }
        const text = this.livePane.thinkingText;
        this.liveThinking.setText(text);
        this.activityContainer.addChild(new Spacer(1));
        this.activityContainer.addChild(this.phaseSpinner);
        if (text.length > 0) {
          this.activityContainer.addChild(this.liveThinking);
        }
        break;
      }
      case 'composing': {
        this.stopLoader();
        if (!this.phaseSpinner) {
          this.phaseSpinner = new MoonLoader(this.ui, 'braille', (s) => chalk.hex(this.colors.primary)(s), 'working...');
        }
        this.activityContainer.addChild(this.phaseSpinner);
        break;
      }
      case 'tool': {
        this.stopPhaseSpinner();
        if (!this.loadingAnimation) {
          this.loadingAnimation = new MoonLoader(this.ui, 'moon');
        }
        this.activityContainer.addChild(new Spacer(1));
        this.activityContainer.addChild(this.loadingAnimation);
        break;
      }
      default: {
        this.stopLoader();
        this.stopPhaseSpinner();
        break;
      }
    }
  }

  private stopLoader(): void {
    if (this.loadingAnimation) {
      this.loadingAnimation.stop();
      this.loadingAnimation = undefined;
    }
  }

  private stopPhaseSpinner(): void {
    if (this.phaseSpinner) {
      this.phaseSpinner.stop();
      this.phaseSpinner = undefined;
    }
  }

  // ── Queued messages display ─────────────────────────────────────

  private updateQueueDisplay(): void {
    this.queueContainer.clear();
    const queued = this.wireHandler.getQueuedMessages();
    if (queued.length === 0) return;

    for (const item of queued) {
      this.queueContainer.addChild(
        new Text(chalk.cyan.dim(`  ❯ ${item.text}`), 0, 0),
      );
    }
    this.queueContainer.addChild(
      new Text(chalk.dim('  ↑ to edit · ctrl-s to steer immediately'), 0, 0),
    );
  }

  // ── Expand / collapse tool output (Ctrl+O) ─────────────────────

  private toggleToolOutputExpansion(): void {
    this.toolOutputExpanded = !this.toolOutputExpanded;
    for (const child of this.transcriptContainer.children) {
      if (isExpandable(child)) {
        child.setExpanded(this.toolOutputExpanded);
      }
    }
    this.ui.requestRender();
  }

  // ── Dialog display (container replacement pattern) ──────────────

  showApprovalPanel(requestId: string, data: import('../wire/index.js').ApprovalRequestData): void {
    this.editorContainer.clear();
    const panel = new ApprovalPanelComponent(
      { requestId, data },
      (response: ApprovalResponseData) => {
        this.hideApprovalPanel();
        this.wireHandler.handleApprovalResponse(response);
      },
    );
    panel.onToggleToolExpand = () => this.toggleToolOutputExpansion();
    this.editorContainer.addChild(panel);
    this.ui.setFocus(panel);
    this.ui.requestRender();
  }

  hideApprovalPanel(): void {
    this.editorContainer.clear();
    this.editorContainer.addChild(this.editor);
    this.ui.setFocus(this.editor);
    this.ui.requestRender();
  }

  showQuestionDialog(requestId: string, data: import('../wire/index.js').QuestionRequestData): void {
    this.editorContainer.clear();
    const dialog = new QuestionDialogComponent(
      { requestId, data },
      (answers: string[]) => {
        this.hideQuestionDialog();
        this.wireHandler.handleQuestionResponse(answers);
      },
      this.colors,
    );
    this.editorContainer.addChild(dialog);
    this.ui.setFocus(dialog);
    this.ui.requestRender();
  }

  hideQuestionDialog(): void {
    this.editorContainer.clear();
    this.editorContainer.addChild(this.editor);
    this.ui.setFocus(this.editor);
    this.ui.requestRender();
  }

  async showSessionPicker(): Promise<void> {
    this.showingSessionPicker = true;
    this.editorContainer.clear();

    const picker = new SessionPickerComponent({
      sessions: this.sessions,
      loading: this.loadingSessions,
      currentSessionId: this.state.sessionId,
      colors: this.colors,
      onSelect: (sessionId: string) => {
        this.hideSessionPicker();
        void this.switchSession(sessionId);
      },
      onCancel: () => {
        this.hideSessionPicker();
      },
    });

    this.editorContainer.addChild(picker);
    this.ui.setFocus(picker);
    this.ui.requestRender();
  }

  // ── /help panel ─────────────────────────────────────────────────

  private showingHelpPanel = false;

  private showHelpPanel(): void {
    this.showingHelpPanel = true;
    this.editorContainer.clear();
    const panel = new HelpPanelComponent({
      commands: this.registry.listAll(),
      colors: this.colors,
      onClose: () => this.hideHelpPanel(),
    });
    this.editorContainer.addChild(panel);
    this.ui.setFocus(panel);
    this.ui.requestRender();
  }

  private hideHelpPanel(): void {
    this.showingHelpPanel = false;
    this.editorContainer.clear();
    this.editorContainer.addChild(this.editor);
    this.ui.setFocus(this.editor);
    this.ui.requestRender();
  }

  // ── /usage renderer ─────────────────────────────────────────────

  private async showUsage(): Promise<void> {
    const lines = await this.buildUsageReport();
    this.addTranscriptEntry({
      id: `usage-${String(Date.now())}`,
      kind: 'status',
      renderMode: 'plain',
      content: lines.join('\n'),
    });
  }

  private async buildUsageReport(): Promise<string[]> {
    const accent = chalk.hex(this.colors.primary);
    const dim = chalk.hex(this.colors.textDim);
    const severityHex = (sev: 'ok' | 'warn' | 'danger'): string =>
      sev === 'danger' ? this.colors.error
        : sev === 'warn' ? this.colors.warning
          : this.colors.success;

    const lines: string[] = [];

    // Session usage — wire-aggregated token totals.
    let tokenErr: string | undefined;
    let tokens = {
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cache_read_tokens: 0,
      total_cache_write_tokens: 0,
      total_cost_usd: 0,
    };
    try {
      tokens = await this.wireClient.getUsage(this.state.sessionId);
    } catch (err) {
      tokenErr = err instanceof Error ? err.message : String(err);
    }
    lines.push(accent('Session usage'));
    if (tokenErr !== undefined) {
      lines.push(chalk.hex(this.colors.error)(`  (failed: ${tokenErr})`));
    } else {
      lines.push(dim(`  Input      ${formatTokenCount(tokens.total_input_tokens)}`));
      lines.push(dim(`  Output     ${formatTokenCount(tokens.total_output_tokens)}`));
      lines.push(dim(`  Cache read ${formatTokenCount(tokens.total_cache_read_tokens)}`));
      lines.push(dim(`  Cache wrt  ${formatTokenCount(tokens.total_cache_write_tokens)}`));
      lines.push(
        dim(
          `  Cost       ${
            tokens.total_cost_usd > 0
              ? `$${tokens.total_cost_usd.toFixed(4)}`
              : '— (not tracked)'
          }`,
        ),
      );
    }

    // Context window — live utilisation from status.update events.
    const ctxTokens = this.state.contextTokens;
    const maxCtx = this.state.maxContextTokens;
    if (maxCtx > 0) {
      const ratio = Math.max(0, Math.min(ctxTokens / maxCtx, 1));
      const bar = renderProgressBar(ratio, 20);
      const pct = `${(ratio * 100).toFixed(1)}%`;
      const barColoured = chalk.hex(severityHex(ratioSeverity(ratio)))(bar);
      lines.push('');
      lines.push(accent('Context window'));
      lines.push(
        `  ${barColoured} ${pct} ` +
          dim(`(${formatTokenCount(ctxTokens)} / ${formatTokenCount(maxCtx)})`),
      );
    }

    // Managed-platform quotas — only for managed:kimi-code.
    const platformSection = await this.tryBuildManagedUsageSection(accent, dim, severityHex);
    if (platformSection.length > 0) {
      lines.push('');
      lines.push(...platformSection);
    }

    return lines;
  }

  private async tryBuildManagedUsageSection(
    accent: (s: string) => string,
    dim: (s: string) => string,
    severityHex: (sev: 'ok' | 'warn' | 'danger') => string,
  ): Promise<string[]> {
    const alias = this.state.model;
    const providerKey = this.state.availableModels[alias]?.provider;
    if (!isManagedKimiCode(providerKey)) return [];
    const manager = this.oauthManagers?.get(providerKey ?? '');
    if (manager === undefined) {
      return [
        accent('Plan usage'),
        dim('  No OAuth session for this provider. Run /login to enable plan quotas.'),
      ];
    }
    let token: string;
    try {
      token = await manager.ensureFresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return [
        accent('Plan usage'),
        chalk.hex(this.colors.error)(`  Failed to obtain access token: ${msg}`),
      ];
    }
    const res = await fetchManagedUsage(kimiCodeUsageUrl(), token);
    if (res.kind === 'error') {
      return [accent('Plan usage'), chalk.hex(this.colors.error)(`  ${res.message}`)];
    }
    const { summary, limits } = res.parsed;
    if (summary === null && limits.length === 0) {
      return [accent('Plan usage'), dim('  No usage data available.')];
    }

    const rows: UsageRow[] = [];
    if (summary !== null) rows.push(summary);
    rows.push(...limits);
    const labelWidth = Math.max(10, ...rows.map((r) => r.label.length));
    const out: string[] = [accent('Plan usage')];
    for (const row of rows) {
      const ratioUsed = row.limit > 0 ? row.used / row.limit : 0;
      const leftRatio = 1 - Math.max(0, Math.min(ratioUsed, 1));
      const bar = renderProgressBar(Math.max(0, Math.min(ratioUsed, 1)), 20);
      const pct = `${Math.round(leftRatio * 100)}% left`;
      const barColoured = chalk.hex(severityHex(ratioSeverity(ratioUsed)))(bar);
      const label = row.label.padEnd(labelWidth, ' ');
      const resetStr = row.resetHint ? dim(` (${row.resetHint})`) : '';
      out.push(`  ${dim(label)} ${barColoured} ${pct}${resetStr}`);
    }
    return out;
  }

  hideSessionPicker(): void {
    this.showingSessionPicker = false;
    this.editorContainer.clear();
    this.editorContainer.addChild(this.editor);
    this.ui.setFocus(this.editor);
    this.ui.requestRender();
  }

  private showEditorPicker(): void {
    const currentValue = this.state.editorCommand ?? '';
    const options: ChoiceOption[] = [
      { value: 'code --wait', label: 'VS Code (code --wait)' },
      { value: 'vim', label: 'Vim' },
      { value: 'nvim', label: 'Neovim' },
      { value: 'nano', label: 'Nano' },
      { value: '', label: 'Auto-detect ($VISUAL / $EDITOR)' },
    ];
    this.editorContainer.clear();
    const picker = new ChoicePickerComponent({
      title: 'Select external editor',
      hint: '↑↓ navigate · Enter select · Esc cancel',
      options,
      currentValue,
      colors: this.colors,
      onSelect: (value) => {
        this.closeEditorPicker();
        this.applyEditorChoice(value);
      },
      onCancel: () => {
        this.closeEditorPicker();
      },
    });
    this.editorContainer.addChild(picker);
    this.ui.setFocus(picker);
    this.ui.requestRender();
  }

  private closeEditorPicker(): void {
    this.editorContainer.clear();
    this.editorContainer.addChild(this.editor);
    this.ui.setFocus(this.editor);
    this.ui.requestRender();
  }

  private applyEditorChoice(value: string): void {
    const previous = this.state.editorCommand ?? '';
    if (value === previous) {
      this.addTranscriptEntry({
        id: `editor-${String(Date.now())}`,
        kind: 'status',
        renderMode: 'plain',
        content: `Editor unchanged: ${value.length > 0 ? value : 'auto-detect'}`,
      });
      return;
    }

    this.setState({ editorCommand: value.length > 0 ? value : null });
    try {
      saveConfigPatch({ default_editor: value });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.addTranscriptEntry({
        id: `editor-err-${String(Date.now())}`,
        kind: 'status',
        renderMode: 'plain',
        content: `Editor updated in memory but failed to persist: ${msg}`,
        color: this.colors.error,
      });
      return;
    }
    this.addTranscriptEntry({
      id: `editor-${String(Date.now())}`,
      kind: 'status',
      renderMode: 'plain',
      content: value.length > 0
        ? `Editor set to "${value}" and saved to config.toml.`
        : 'Editor set to auto-detect ($VISUAL / $EDITOR).',
    });
  }

  // ── Model picker ─────────────────────────────────────────────────

  private showModelPicker(): void {
    const entries = Object.entries(this.state.availableModels);
    if (entries.length === 0) {
      this.addTranscriptEntry({
        id: `model-${String(Date.now())}`,
        kind: 'status',
        renderMode: 'plain',
        content: 'No models configured. Edit ~/.kimi/config.toml to add one.',
        color: this.colors.error,
      });
      return;
    }
    const options: ChoiceOption[] = entries.map(([alias, cfg]) => ({
      value: alias,
      label: `${cfg.model} (${cfg.provider})`,
    }));
    this.editorContainer.clear();
    const picker = new ChoicePickerComponent({
      title: 'Select a model',
      hint: '↑↓ navigate · Enter select · Esc cancel',
      options,
      currentValue: this.state.model,
      colors: this.colors,
      onSelect: (alias) => {
        this.closeModelPicker();
        this.showThinkingPicker(alias);
      },
      onCancel: () => this.closeModelPicker(),
    });
    this.editorContainer.addChild(picker);
    this.ui.setFocus(picker);
    this.ui.requestRender();
  }

  private showThinkingPicker(alias: string): void {
    const model = this.state.availableModels[alias];
    const caps = model?.capabilities ?? [];
    // Parity with Python: always_thinking forces on; thinking asks;
    // otherwise force off.
    if (caps.includes('always_thinking')) {
      void this.performModelSwitch(alias, true);
      return;
    }
    if (!caps.includes('thinking')) {
      void this.performModelSwitch(alias, false);
      return;
    }
    const options: ChoiceOption[] = [
      { value: 'on', label: 'Thinking: on' },
      { value: 'off', label: 'Thinking: off' },
    ];
    this.editorContainer.clear();
    const picker = new ChoicePickerComponent({
      title: `Enable thinking for ${alias}?`,
      hint: '↑↓ navigate · Enter select · Esc cancel',
      options,
      currentValue: this.state.thinking ? 'on' : 'off',
      colors: this.colors,
      onSelect: (value) => {
        this.closeModelPicker();
        void this.performModelSwitch(alias, value === 'on');
      },
      onCancel: () => this.closeModelPicker(),
    });
    this.editorContainer.addChild(picker);
    this.ui.setFocus(picker);
    this.ui.requestRender();
  }

  private closeModelPicker(): void {
    this.editorContainer.clear();
    this.editorContainer.addChild(this.editor);
    this.ui.setFocus(this.editor);
    this.ui.requestRender();
  }

  private async performModelSwitch(alias: string, thinking: boolean): Promise<void> {
    if (this.state.isStreaming) {
      this.addTranscriptEntry({
        id: `model-${String(Date.now())}`,
        kind: 'status',
        renderMode: 'plain',
        content: 'Cannot switch models while streaming — press Esc or Ctrl-C first.',
        color: this.colors.error,
      });
      return;
    }

    if (alias === this.state.model && thinking === this.state.thinking) {
      this.addTranscriptEntry({
        id: `model-${String(Date.now())}`,
        kind: 'status',
        renderMode: 'plain',
        content: `Already using ${alias} with thinking ${thinking ? 'on' : 'off'}.`,
        color: this.colors.textDim,
      });
      return;
    }

    if (typeof this.wireClient.switchModel !== 'function') {
      this.addTranscriptEntry({
        id: `model-${String(Date.now())}`,
        kind: 'status',
        renderMode: 'plain',
        content: 'Model switching not configured on this build.',
        color: this.colors.error,
      });
      return;
    }

    const prevModel = this.state.model;
    const sessionId = this.state.sessionId;
    try {
      this.wireHandler.stop();
      const { session_id: newId } = await this.wireClient.switchModel(sessionId, alias);
      // The new ManagedSession (same id) has a fresh queue; rebuild the
      // WireHandler so its subscribe loop listens on the right one.
      this.wireHandler = new WireHandler(this.wireClient, newId, this, this.colors);
      this.attachFooterFeed();
      void this.wireHandler.start();
      this.setState({ sessionId: newId, model: alias, thinking });
      try {
        saveConfigPatch({ default_model: alias, default_thinking: thinking });
      } catch (persistErr) {
        const msg = persistErr instanceof Error ? persistErr.message : String(persistErr);
        this.addTranscriptEntry({
          id: `model-warn-${String(Date.now())}`,
          kind: 'status',
          renderMode: 'plain',
          content: `Switched but failed to persist to config.toml: ${msg}`,
          color: this.colors.warning,
        });
      }
      this.addTranscriptEntry({
        id: `model-${String(Date.now())}`,
        kind: 'status',
        renderMode: 'plain',
        content: `Switched to ${alias} with thinking ${thinking ? 'on' : 'off'}.`,
        color: this.colors.success,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.addTranscriptEntry({
        id: `model-err-${String(Date.now())}`,
        kind: 'status',
        renderMode: 'plain',
        content: `Failed to switch model: ${msg}`,
        color: this.colors.error,
      });
      // Best-effort recovery: try to resume the previous session so the
      // user is not stranded.
      try {
        this.wireHandler = new WireHandler(this.wireClient, sessionId, this, this.colors);
        this.attachFooterFeed();
        void this.wireHandler.start();
      } catch {
        // nothing useful left to do
      }
      void prevModel;
    }
  }

  // ── Session management ──────────────────────────────────────────

  private async fetchSessions(): Promise<void> {
    this.loadingSessions = true;
    try {
      const result = await this.wireClient.listSessions();
      this.sessions = result.sessions;
    } catch {
      // silently ignore
    } finally {
      this.loadingSessions = false;
    }
  }

  /**
   * Swap the active session. Mirrors the /new + /model live-rebuild
   * pattern: stop the old WireHandler, destroy the old ManagedSession
   * so its event queue closes, resume the target session through
   * KimiCoreClient (which triggers wire.jsonl replay + fresh SoulPlus),
   * then wire up a brand-new WireHandler on the new queue.
   *
   * Guard decisions live in {@link decideSessionSwitch}; this method
   * only does the side-effects that follow a 'proceed' verdict.
   */
  private async switchSession(newSessionId: string): Promise<void> {
    const decision = decideSessionSwitch({
      currentSessionId: this.state.sessionId,
      targetSessionId: newSessionId,
      isStreaming: this.state.isStreaming,
      currentWorkDir: this.state.workDir,
      sessions: this.sessions,
      clientSupportsResumeSession: typeof this.wireClient.resumeSession === 'function',
    });
    if (decision.kind === 'noop') {
      this.addTranscriptEntry({
        id: `session-${String(Date.now())}`,
        kind: 'status',
        renderMode: 'plain',
        content: 'Already on this session.',
        color: this.colors.textDim,
      });
      return;
    }
    if (decision.kind === 'error') {
      this.addTranscriptEntry({
        id: `session-err-${String(Date.now())}`,
        kind: 'status',
        renderMode: 'plain',
        content: decision.message,
        color: this.colors.error,
      });
      return;
    }

    const target = decision.target;
    const oldId = this.state.sessionId;
    try {
      this.wireHandler.stop();
      await this.wireClient.destroySession(oldId);
      // Type narrowing: decideSessionSwitch already verified this.
      const { session_id: resumedId } = await this.wireClient.resumeSession!(newSessionId);
      this.wireHandler = new WireHandler(this.wireClient, resumedId, this, this.colors);
      this.attachFooterFeed();
      void this.wireHandler.start();
      this.setState({ sessionId: resumedId });
      this.clearTranscriptAndRedraw();
      const label = target.title !== null && target.title.length > 0
        ? `${target.title} (${resumedId})`
        : resumedId;
      this.addTranscriptEntry({
        id: `session-${String(Date.now())}`,
        kind: 'status',
        renderMode: 'plain',
        content: `Switched to session ${label}.`,
        color: this.colors.success,
      });
      void this.fetchSessions();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.addTranscriptEntry({
        id: `session-err-${String(Date.now())}`,
        kind: 'status',
        renderMode: 'plain',
        content: `Failed to switch session: ${msg}`,
        color: this.colors.error,
      });
      // Best-effort recovery: re-resume the old session so the user
      // isn't stranded without a live WireHandler.
      try {
        if (typeof this.wireClient.resumeSession === 'function') {
          await this.wireClient.resumeSession(oldId);
        }
        this.wireHandler = new WireHandler(this.wireClient, oldId, this, this.colors);
        this.attachFooterFeed();
        void this.wireHandler.start();
      } catch {
        // No safe recovery left — user should restart.
      }
    }
  }

  // ── User input handling ─────────────────────────────────────────

  private handleUserInput(text: string): void {
    // Ignore empty / whitespace-only submissions — pressing Enter on an
    // empty input box should be a no-op, not a wire round-trip.
    if (text.trim().length === 0) return;
    void this.persistInputHistory(text);
    if (text.startsWith('/')) {
      void this.executeSlashCommand(text);
    } else {
      this.wireHandler.sendMessage(text);
      this.updateQueueDisplay();
      this.ui.requestRender();
    }
  }

  // ── Reload / re-render ───────────────────────────────────────────

  private async performReload(action: import('../slash/index.js').ReloadAction): Promise<void> {
    if (this.state.isStreaming) {
      this.addTranscriptEntry({
        id: `reload-${String(Date.now())}`,
        kind: 'status',
        renderMode: 'plain',
        content: `Cannot /${action} while streaming — press Esc or Ctrl-C first.`,
        color: this.colors.error,
      });
      return;
    }

    switch (action) {
      case 'clear': {
        // Phase 20 §A — drop the Core-side conversation context first
        // so the next prompt starts from an empty history. Runs AFTER
        // the `isStreaming` guard above so a mid-turn /clear never
        // corrupts the active turn. If the wire call fails the UI
        // reload is still useful (user still sees a clean transcript),
        // so swallow the error and surface it as a status line instead.
        let clearErrorMessage: string | undefined;
        try {
          await this.wireClient.clear(this.state.sessionId);
        } catch (error) {
          if (error instanceof Error) {
            clearErrorMessage = error.message;
          } else if (typeof error === 'string') {
            clearErrorMessage = error;
          } else {
            // Non-Error throwables (BigInt, circular objects, etc.) —
            // fall back to a stable sentinel rather than risking a
            // second throw from JSON.stringify inside the catch.
            clearErrorMessage = 'unknown error';
          }
        }
        this.clearTranscriptAndRedraw();
        this.addTranscriptEntry({
          id: `reload-${String(Date.now())}`,
          kind: 'status',
          renderMode: 'plain',
          content:
            clearErrorMessage === undefined
              ? 'Context cleared.'
              : `Transcript cleared (core clear failed: ${clearErrorMessage}).`,
          color: clearErrorMessage === undefined ? this.colors.textDim : this.colors.error,
        });
        break;
      }
      case 'new':
        await this.spawnFreshSession();
        break;
      case 'theme':
        this.applyThemeChange();
        break;
      case 'undo':
        await this.reloadAfterUndo();
        break;
    }
    this.ui.requestRender();
  }

  /**
   * Phase 21 §D.1 — post-rollback handoff. The wire client already
   * truncated `wire.jsonl` in place; we tear the in-memory session down
   * and resume it so SoulPlus / ContextState rebuild from the shorter
   * history. The transcript is cleared so the UI state matches the
   * underlying session state — replay remains a future-phase concern.
   */
  private async reloadAfterUndo(): Promise<void> {
    const sessionId = this.state.sessionId;
    try {
      this.wireHandler.stop();
      await this.wireClient.destroySession(sessionId);
      if (this.wireClient.resumeSession === undefined) {
        throw new Error('resumeSession not supported by this client');
      }
      const { session_id: resumedId } = await this.wireClient.resumeSession(sessionId);
      this.wireHandler = new WireHandler(this.wireClient, resumedId, this, this.colors);
      this.attachFooterFeed();
      void this.wireHandler.start();
      this.setState({ sessionId: resumedId });
      this.clearTranscriptAndRedraw();
      this.addTranscriptEntry({
        id: `reload-${String(Date.now())}`,
        kind: 'status',
        renderMode: 'plain',
        content: 'Previous turn rolled back.',
        color: this.colors.textDim,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.addTranscriptEntry({
        id: `reload-err-${String(Date.now())}`,
        kind: 'status',
        renderMode: 'plain',
        content: `/undo reload failed: ${msg}`,
        color: this.colors.error,
      });
    }
  }

  private clearTranscriptAndRedraw(): void {
    this.transcriptEntries = [];
    this.transcriptContainer.clear();
    this.pendingToolComponents.clear();
    this.streamingComponent = undefined;
    this.todoPanel.clear();
    this.todoPanelContainer.clear();
    this.renderWelcome();
  }

  private rebuildTranscriptFromEntries(): void {
    this.transcriptContainer.clear();
    this.pendingToolComponents.clear();
    this.streamingComponent = undefined;
    this.renderWelcome();
    for (const entry of this.transcriptEntries) {
      const component = this.createTranscriptComponent(entry);
      if (component !== null) {
        this.transcriptContainer.addChild(component);
      }
    }
  }

  private applyThemeChange(): void {
    this.colors = getColorPalette(this.state.theme);
    this.markdownTheme = createMarkdownTheme(this.colors);
    this.footer.setColors(this.colors);
    this.todoPanel.setColors(this.colors);
    // Re-apply the border colour with the new palette, respecting the
    // current slash-highlight state.
    this.updateEditorBorderHighlight(this.editor.getText());
    this.rebuildTranscriptFromEntries();
  }

  /**
   * Re-apply slash highlighting state for the current editor text.
   * Two visual signals are combined:
   *   - editor border flips to `colors.primary` when input starts with `/`
   *   - the leading `/token` itself is re-coloured via CustomEditor's
   *     ANSI-aware post-processor (`slashHighlightHex`)
   * Called from `onChange` and on theme changes.
   */
  private updateEditorBorderHighlight(text: string): void {
    const editorTheme = createEditorTheme(this.colors);
    const trimmed = text.trimStart();
    if (trimmed.startsWith('/')) {
      const primary = this.colors.primary;
      this.editor.borderColor = (s: string) => chalk.hex(primary)(s);
    } else {
      this.editor.borderColor = editorTheme.borderColor;
    }
    // Keep the token colour in sync with the palette — the editor only
    // paints when the input actually starts with `/` so it's safe to
    // set unconditionally.
    this.editor.slashHighlightHex = this.colors.primary;
    this.ui.requestRender();
  }

  private async spawnFreshSession(): Promise<void> {
    try {
      this.wireHandler.stop();
      const { session_id: newId } = await this.wireClient.createSession(this.state.workDir);
      // Build a new WireHandler rooted at the new session so its
      // subscribe loop listens on the right queue.
      this.wireHandler = new WireHandler(this.wireClient, newId, this, this.colors);
      this.attachFooterFeed();
      void this.wireHandler.start();
      this.setState({ sessionId: newId });
      this.clearTranscriptAndRedraw();
      this.addTranscriptEntry({
        id: `reload-${String(Date.now())}`,
        kind: 'status',
        renderMode: 'plain',
        content: `Started a new session (${newId}).`,
        color: this.colors.textDim,
      });
      void this.fetchSessions();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.addTranscriptEntry({
        id: `reload-err-${String(Date.now())}`,
        kind: 'status',
        renderMode: 'plain',
        content: `Failed to start a new session: ${msg}`,
        color: this.colors.error,
      });
    }
  }

  private externalEditorRunning = false;

  private async openExternalEditor(): Promise<void> {
    if (this.externalEditorRunning) return;
    const cmd = resolveEditorCommand(this.state.editorCommand);
    if (cmd === undefined) {
      this.addTranscriptEntry({
        id: `editor-${String(Date.now())}`,
        kind: 'status',
        renderMode: 'plain',
        content: 'No editor configured. Set $VISUAL / $EDITOR, or run /editor <command>.',
        color: this.colors.error,
      });
      return;
    }
    this.externalEditorRunning = true;
    const seed = this.editor.getExpandedText?.() ?? this.editor.getText();
    this.ui.stop();
    // Let pi-tui's terminal reset escape sequences flush before the
    // child takes over the TTY; otherwise the child occasionally sees
    // the tail of "\x1b[?2004l" etc. as its first input on slow TTYs.
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      const result = await editInExternalEditor(seed, cmd);
      if (result !== undefined) {
        this.editor.setText(result.replace(/\r\n/g, '\n').replace(/\n$/, ''));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.addTranscriptEntry({
        id: `editor-err-${String(Date.now())}`,
        kind: 'status',
        renderMode: 'plain',
        content: `External editor failed: ${msg}`,
        color: this.colors.error,
      });
    } finally {
      // The child held stdin with `stdio:'inherit'` — Node's stdin can
      // end up in a half-paused state after it exits. Pause explicitly
      // so pi-tui's Terminal.start can re-take ownership from a known
      // baseline (setRawMode(true) + resume()).
      if (typeof process.stdin.pause === 'function') {
        process.stdin.pause();
      }
      this.ui.start();
      // Refocus the editor and force a full repaint — previousLines
      // inside pi-tui was invalidated by the child's screen output.
      this.ui.setFocus(this.editor);
      this.ui.requestRender(true);
      this.externalEditorRunning = false;
    }
  }

  private async togglePlanMode(): Promise<void> {
    const enabled = !this.state.planMode;
    this.setState({ planMode: enabled });
    this.addTranscriptEntry({
      id: `plan-${String(Date.now())}`,
      kind: 'status',
      renderMode: 'plain',
      content: `Plan mode: ${enabled ? 'ON' : 'OFF'}`,
      color: this.colors.primary,
    });
    try {
      await this.wireClient.setPlanMode(this.state.sessionId, enabled);
    } catch (err) {
      // Roll back local state and surface the failure so the footer doesn't lie.
      this.setState({ planMode: !enabled });
      const msg = err instanceof Error ? err.message : String(err);
      this.addTranscriptEntry({
        id: `plan-err-${String(Date.now())}`,
        kind: 'status',
        renderMode: 'plain',
        content: `Failed to toggle plan mode: ${msg}`,
        color: this.colors.error,
      });
    }
  }

  private async persistInputHistory(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    if (trimmed === this.lastHistoryContent) return;
    this.editor.addToHistory(trimmed);
    try {
      const file = getInputHistoryFile(this.state.workDir);
      const written = await appendInputHistory(file, trimmed, this.lastHistoryContent);
      if (written) this.lastHistoryContent = trimmed;
    } catch {
      // Best-effort — keep the in-memory history even if disk write fails.
      this.lastHistoryContent = trimmed;
    }
  }

  private async executeSlashCommand(input: string): Promise<void> {
    const parsed = parseSlashInput(input);
    if (!parsed) return;

    const def = this.registry.find(parsed.name);
    if (!def) {
      // Phase 21 §D.2 — fall through to skill dispatch. Built-ins win
      // (lookup above already resolved `parsed.name` against the
      // registry), so a skill only fires when no built-in matches.
      const result = await tryDispatchSkill(
        this.wireClient,
        this.state.sessionId,
        parsed.name,
        parsed.args,
      );
      this.addTranscriptEntry({
        id: `slash-${Date.now()}`,
        kind: 'status',
        renderMode: 'plain',
        content: result.message,
      });
      return;
    }

    const ctx: SlashCommandContext = {
      wireClient: this.wireClient,
      appState: this.state,
      setAppState: (patch) => this.setState(patch),
      showStatus: (message: string) => {
        this.addTranscriptEntry({
          id: `status-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          kind: 'status',
          renderMode: 'plain',
          content: message,
        });
      },
    };

    let result;
    try {
      result = await def.execute(parsed.args, ctx);
    } catch (error) {
      this.addTranscriptEntry({
        id: `slash-err-${Date.now()}`,
        kind: 'status',
        renderMode: 'plain',
        content: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    switch (result.type) {
      case 'exit':
        void this.stop();
        break;
      case 'reload':
        void this.performReload(result.action);
        break;
      case 'ok': {
        if (!result.message) return;

        if (result.message === '__show_help__') {
          this.showHelpPanel();
          return;
        }

        if (result.message === '__show_sessions__') {
          await this.fetchSessions();
          void this.showSessionPicker();
          return;
        }

        if (result.message === '__show_editor_picker__') {
          this.showEditorPicker();
          return;
        }

        if (result.message === '__show_model_picker__') {
          this.showModelPicker();
          return;
        }

        if (result.message === '__show_usage__') {
          void this.showUsage();
          return;
        }
        if (result.message.startsWith('__show_model_picker__:')) {
          const alias = result.message.slice('__show_model_picker__:'.length);
          this.showThinkingPicker(alias);
          return;
        }

        if (result.message.startsWith('__send_as_message__:')) {
          const msg = result.message.slice('__send_as_message__:'.length);
          this.wireHandler.sendMessage(msg);
          return;
        }

        this.addTranscriptEntry({
          id: `slash-${Date.now()}`,
          kind: 'status',
          renderMode: 'plain',
          content: result.message,
          ...(result.color !== undefined ? { color: result.color } : {}),
        });
        break;
      }
    }
  }
}
