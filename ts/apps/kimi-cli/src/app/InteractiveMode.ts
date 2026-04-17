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
import { WireHandler, type WireHandlerDelegate } from './WireHandler.js';

import { CustomEditor } from '../components/CustomEditor.js';
import { ChoicePickerComponent, type ChoiceOption } from '../components/ChoicePickerComponent.js';
import { getInputHistoryFile } from '../config/paths.js';
import { loadInputHistory, appendInputHistory } from '../utils/input-history.js';
import { editInExternalEditor, resolveEditorCommand } from '../utils/external-editor.js';
import { saveConfigPatch } from '../config/save.js';
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
}

export interface InteractiveModeOptions {
  oauthManagers?: ReadonlyMap<string, AppOAuthManager> | undefined;
  mcpManager?: { close(): Promise<void> } | undefined;
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

  private toasts: ToastNotification[] = [];
  private sessions: SessionInfo[] = [];
  private loadingSessions = false;
  private showingSessionPicker = false;

  private registry;
  private oauthManagers: ReadonlyMap<string, AppOAuthManager> | undefined;

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

    this.markdownTheme = createMarkdownTheme(this.colors);
    const editorTheme = createEditorTheme(this.colors);

    this.ui = new TUI(new ProcessTerminal());

    this.transcriptContainer = new Container();
    this.activityContainer = new Container();
    this.queueContainer = new Container();
    this.editorContainer = new Container();
    this.editor = new CustomEditor(this.ui, editorTheme);
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
    void this.wireHandler.start();
    void this.fetchSessions();
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

  async stop(): Promise<void> {
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
        this.switchSession(sessionId);
      },
      onCancel: () => {
        this.hideSessionPicker();
      },
    });

    this.editorContainer.addChild(picker);
    this.ui.setFocus(picker);
    this.ui.requestRender();
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

  private switchSession(newSessionId: string): void {
    this.setState({ sessionId: newSessionId });
    void this.wireClient.resume(newSessionId);
  }

  // ── User input handling ─────────────────────────────────────────

  private handleUserInput(text: string): void {
    void this.persistInputHistory(text);
    if (text.startsWith('/')) {
      void this.executeSlashCommand(text);
    } else {
      this.wireHandler.sendMessage(text);
      this.updateQueueDisplay();
      this.ui.requestRender();
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
      this.addTranscriptEntry({
        id: `slash-${Date.now()}`,
        kind: 'status',
        renderMode: 'plain',
        content: `Unknown command: /${parsed.name}`,
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
        this.addTranscriptEntry({
          id: `slash-${Date.now()}`,
          kind: 'status',
          renderMode: 'plain',
          content: 'Session reset. (Full reload not yet implemented)',
        });
        break;
      case 'ok': {
        if (!result.message) return;

        if (result.message === '__show_help__') {
          const cmds = this.registry.listAll();
          const lines = cmds.map((c) => {
            const aliases =
              c.aliases.length > 0 ? ` (${c.aliases.map((a) => '/' + a).join(', ')})` : '';
            return `  /${c.name}${aliases} -- ${c.description}`;
          });
          this.addTranscriptEntry({
            id: `slash-${Date.now()}`,
            kind: 'status',
            renderMode: 'plain',
            content: 'Available commands:\n' + lines.join('\n'),
          });
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
