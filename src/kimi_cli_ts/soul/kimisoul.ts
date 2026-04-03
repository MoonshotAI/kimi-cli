/**
 * KimiSoul — corresponds to Python soul/kimisoul.py
 * The core agent loop: receive input → call LLM → execute tools → repeat.
 */

import type { Message, ContentPart, ToolCall, TokenUsage, StatusSnapshot, SlashCommand, ModelCapability } from "../types.ts";
import type { ToolResult } from "../tools/types.ts";
import type { LLM, StreamChunk, ChatOptions } from "../llm.ts";
import type { HookEngine } from "../hooks/engine.ts";
import type { Config } from "../config.ts";
import type { Session } from "../session.ts";
import { Context } from "./context.ts";
import { Agent, type Runtime } from "./agent.ts";
import { KimiToolset } from "./toolset.ts";
import { SlashCommandRegistry } from "./slash.ts";
import { compactContext, shouldCompact } from "./compaction.ts";
import { toolResultMessage, systemReminder } from "./message.ts";
import type { DynamicInjection, DynamicInjectionProvider } from "./dynamic_injection.ts";
import { normalizeHistory } from "./dynamic_injection.ts";
import { PlanModeInjectionProvider } from "./dynamic_injections/plan_mode.ts";
import { YoloModeInjectionProvider } from "./dynamic_injections/yolo_mode.ts";
import { handleNew, handleSessions, handleTitle } from "../ui/shell/commands/session.ts";
import { handleModel, createModelPanel } from "../ui/shell/commands/model.ts";
import { handleLogin, handleLogout, createLoginPanel } from "../ui/shell/commands/login.ts";
import { handleHooks, handleMcp, handleDebug, handleChangelog } from "../ui/shell/commands/info.ts";
import { handleExport, handleImport } from "../ui/shell/commands/export_import.ts";
import { handleWeb, handleVis, handleReload, handleTask } from "../ui/shell/commands/misc.ts";
import { handleUsage } from "../ui/shell/commands/usage.ts";
import { handleFeedback } from "../ui/shell/commands/feedback.ts";
import { handleEditor } from "../ui/shell/commands/editor.ts";
import { handleInit } from "../ui/shell/commands/init.ts";
import { handleAddDir } from "../ui/shell/commands/add_dir.ts";
import { logger } from "../utils/logging.ts";

// ── Errors ─────────────────────────────────────────

export class LLMNotSet extends Error {
  constructor() {
    super("LLM not set");
    this.name = "LLMNotSet";
  }
}

export class LLMNotSupported extends Error {
  readonly modelName: string;
  readonly capabilities: ModelCapability[];
  constructor(modelName: string, capabilities: ModelCapability[]) {
    const word = capabilities.length === 1 ? "capability" : "capabilities";
    super(
      `LLM model '${modelName}' does not support required ${word}: ${capabilities.join(", ")}`,
    );
    this.name = "LLMNotSupported";
    this.modelName = modelName;
    this.capabilities = capabilities;
  }
}

export class MaxStepsReached extends Error {
  readonly maxSteps: number;
  constructor(maxSteps: number) {
    super(`Reached max steps per turn: ${maxSteps}`);
    this.name = "MaxStepsReached";
    this.maxSteps = maxSteps;
  }
}

export class RunCancelled extends Error {
  constructor() {
    super("The run was cancelled");
    this.name = "RunCancelled";
  }
}

export class BackToTheFuture extends Error {
  readonly checkpointId: number;
  readonly messages: Message[];
  constructor(checkpointId: number, messages: Message[]) {
    super(`Reverting context to checkpoint ${checkpointId}`);
    this.name = "BackToTheFuture";
    this.checkpointId = checkpointId;
    this.messages = messages;
  }
}

// ── Wire event callbacks ────────────────────────────

export interface SoulCallbacks {
  onTurnBegin?: (userInput: string | ContentPart[]) => void;
  onTurnEnd?: () => void;
  onStepBegin?: (stepNum: number) => void;
  onStepInterrupted?: () => void;
  onTextDelta?: (text: string) => void;
  onThinkDelta?: (text: string) => void;
  onToolCall?: (toolCall: ToolCall) => void;
  onToolResult?: (toolCallId: string, result: ToolResult) => void;
  onStatusUpdate?: (status: Partial<StatusSnapshot>) => void;
  onCompactionBegin?: () => void;
  onCompactionEnd?: () => void;
  onError?: (error: Error) => void;
  onNotification?: (title: string, body: string) => void;
}

// ── Retry helpers ───────────────────────────────────

function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  // HTTP status codes that are retryable
  if (/\b(429|500|502|503|504)\b/.test(msg)) return true;
  // Network errors
  if (msg.includes("timeout") || msg.includes("econnreset") ||
      msg.includes("econnrefused") || msg.includes("connection") ||
      msg.includes("network") || msg.includes("fetch failed") ||
      msg.includes("socket hang up")) return true;
  // Empty response
  if (msg.includes("empty response") || msg.includes("no body")) return true;
  return false;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry with exponential backoff and jitter. */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  label: string,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= maxRetries || !isRetryableError(err)) {
        throw err;
      }
      const baseDelay = Math.min(300 * Math.pow(2, attempt), 5000);
      const jitter = Math.random() * 500;
      const delay = baseDelay + jitter;
      logger.warn(`${label}: retryable error (attempt ${attempt + 1}/${maxRetries}), retrying in ${Math.round(delay)}ms: ${err instanceof Error ? err.message : err}`);
      await sleep(delay);
    }
  }
  throw lastError;
}

// ── KimiSoul ────────────────────────────────────────

export class KimiSoul {
  private agent: Agent;
  private context: Context;
  private callbacks: SoulCallbacks;
  private abortController: AbortController | null = null;
  private _isRunning = false;
  private _planMode = false;
  private _planSessionId: string | null = null;
  private _pendingPlanActivationInjection = false;
  private _injectionProviders: DynamicInjectionProvider[];
  private _stepCount = 0;
  private _totalUsage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
  };
  // Steer queue: messages injected during a running turn
  private _pendingSteers: Message[] = [];
  // Track whether any tool was rejected without feedback this turn
  private _toolRejectedNoFeedback = false;

  constructor(opts: {
    agent: Agent;
    context: Context;
    callbacks?: SoulCallbacks;
  }) {
    this.agent = opts.agent;
    this.context = opts.context;
    this.callbacks = opts.callbacks ?? {};

    // Restore plan mode from session state
    this._planMode = opts.agent.runtime.session.state.plan_mode ?? false;
    this._planSessionId = opts.agent.runtime.session.state.plan_session_id ?? null;
    if (this._planMode) {
      this._ensurePlanSessionId();
    }

    // Initialize dynamic injection providers
    this._injectionProviders = [
      new PlanModeInjectionProvider(),
      new YoloModeInjectionProvider(),
    ];
  }

  // ── Properties ───────────────────────────────────

  get runtime(): Runtime {
    return this.agent.runtime;
  }

  get config(): Config {
    return this.agent.runtime.config;
  }

  get session(): Session {
    return this.agent.runtime.session;
  }

  get ctx(): Context {
    return this.context;
  }

  get name(): string {
    return this.agent.name;
  }

  get modelName(): string {
    return this.agent.modelName;
  }

  get modelCapabilities(): Set<ModelCapability> | null {
    return this.agent.modelCapabilities;
  }

  get thinking(): boolean {
    return this.agent.runtime.llm?.hasCapability("thinking") ?? false;
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  get planMode(): boolean {
    return this._planMode;
  }

  get isYolo(): boolean {
    return this.agent.runtime.approval.isYolo();
  }

  get status(): StatusSnapshot {
    const llm = this.agent.runtime.llm;
    const maxCtx = llm?.maxContextSize ?? 0;
    const tokenCount = this.context.tokenCountWithPending;
    return {
      contextUsage: maxCtx > 0 ? tokenCount / maxCtx : null,
      contextTokens: tokenCount,
      maxContextTokens: maxCtx,
      tokenUsage: this._totalUsage,
      planMode: this._planMode,
      mcpStatus: null,
    };
  }

  get hookEngine(): HookEngine {
    return this.agent.runtime.hookEngine;
  }

  /** Push a notification to the UI (appears in message list). */
  notify(title: string, body: string): void {
    this.callbacks.onNotification?.(title, body);
  }

  get availableSlashCommands(): SlashCommand[] {
    return this.agent.slashCommands.list();
  }

  // ── Plan mode ────────────────────────────────────

  /** Toggle plan mode from a tool call. Returns the new state. */
  async togglePlanMode(): Promise<boolean> {
    return this._setPlanMode(!this._planMode, "tool");
  }

  /** Toggle plan mode from a manual entry point (slash command, keybinding). */
  async togglePlanModeFromManual(): Promise<boolean> {
    return this._setPlanMode(!this._planMode, "manual");
  }

  /** Set plan mode to a specific state from manual entry points. */
  async setPlanModeFromManual(enabled: boolean): Promise<boolean> {
    return this._setPlanMode(enabled, "manual");
  }

  setPlanMode(on: boolean): void {
    this._setPlanMode(on, "tool");
  }

  private _setPlanMode(enabled: boolean, source: "manual" | "tool"): boolean {
    if (enabled === this._planMode) return this._planMode;
    this._planMode = enabled;
    if (enabled) {
      this._ensurePlanSessionId();
      this._pendingPlanActivationInjection = source === "manual";
    } else {
      this._pendingPlanActivationInjection = false;
      this._planSessionId = null;
      this.agent.runtime.session.state.plan_session_id = null;
    }
    // Persist to session state
    this.agent.runtime.session.state.plan_mode = this._planMode;
    this.callbacks.onStatusUpdate?.({ planMode: this._planMode });
    return this._planMode;
  }

  private _ensurePlanSessionId(): void {
    if (this._planSessionId == null) {
      this._planSessionId = crypto.randomUUID().replace(/-/g, "");
      this.agent.runtime.session.state.plan_session_id = this._planSessionId;
    }
  }

  /** Get the plan file path for the current session. */
  getPlanFilePath(): string | null {
    if (this._planSessionId == null) return null;
    const workDir = this.agent.runtime.session.workDir;
    return `${workDir}/.kimi/plans/${this._planSessionId}.md`;
  }

  /** Read the current plan file content. */
  readCurrentPlan(): string | null {
    const path = this.getPlanFilePath();
    if (!path) return null;
    try {
      const file = Bun.file(path);
      // Synchronous existence check is not available — use a simple approach
      return file.size > 0 ? null : null; // Will be refined when plan tools exist
    } catch {
      return null;
    }
  }

  /** Delete the current plan file. */
  clearCurrentPlan(): void {
    const path = this.getPlanFilePath();
    if (!path) return;
    try {
      const { unlinkSync } = require("node:fs");
      unlinkSync(path);
    } catch {
      // File may not exist
    }
  }

  /**
   * Schedule a plan-mode activation reminder for the next turn.
   *
   * Use this when plan mode is already active (e.g. restored session with
   * `--plan` flag) and `_setPlanMode` would early-return because the
   * state hasn't actually changed.
   */
  schedulePlanActivationReminder(): void {
    if (this._planMode) {
      this._pendingPlanActivationInjection = true;
    }
  }

  /** Consume the next-step activation reminder scheduled by a manual toggle. */
  consumePendingPlanActivationInjection(): boolean {
    if (!this._planMode || !this._pendingPlanActivationInjection) return false;
    this._pendingPlanActivationInjection = false;
    return true;
  }

  /** Register an additional dynamic injection provider. */
  addInjectionProvider(provider: DynamicInjectionProvider): void {
    this._injectionProviders.push(provider);
  }

  // ── Yolo mode ────────────────────────────────────

  setYolo(yolo: boolean): void {
    this.agent.runtime.approval.setYolo(yolo);
  }

  // ── Main entry point ─────────────────────────────

  async run(userInput: string | ContentPart[]): Promise<void> {
    if (this._isRunning) {
      logger.warn("Soul is already running, ignoring input");
      return;
    }

    // Check for slash commands
    if (typeof userInput === "string" && userInput.trim().startsWith("/")) {
      const handled = await this.agent.slashCommands.execute(userInput);
      if (handled) return;
    }

    this._isRunning = true;
    this.abortController = new AbortController();
    this._toolRejectedNoFeedback = false;

    let turnStarted = false;
    let turnFinished = false;
    try {
      this.callbacks.onTurnBegin?.(userInput);
      this._wireLog({ type: "turn_begin", user_input: typeof userInput === "string" ? userInput : "[complex]" });
      turnStarted = true;
      await this._turn(userInput);
      this._wireLog({ type: "turn_end" });
      this.callbacks.onTurnEnd?.();
      turnFinished = true;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        logger.info("Turn aborted");
        this.callbacks.onStepInterrupted?.();
      } else if (err instanceof MaxStepsReached) {
        logger.warn(err.message);
        this.callbacks.onError?.(err);
        this.callbacks.onTurnEnd?.();
        turnFinished = true;
      } else {
        logger.error(`Turn error: ${err}`);
        this.callbacks.onError?.(
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    } finally {
      if (turnStarted && !turnFinished) {
        this._wireLog({ type: "turn_end" });
        this.callbacks.onTurnEnd?.();
      }
      this._isRunning = false;
      this.abortController = null;
      this._pendingSteers = [];
    }
  }

  /** Abort the current turn. */
  abort(): void {
    this.abortController?.abort();
  }

  /** Steer: inject follow-up input during a running turn. */
  async steer(content: string | ContentPart[]): Promise<void> {
    if (!this._isRunning) return;
    const msg: Message = {
      role: "user",
      content: typeof content === "string" ? content : content,
    };
    this._pendingSteers.push(msg);
  }

  // ── Turn execution ──────────────────────────────

  private async _turn(userInput: string | ContentPart[]): Promise<void> {
    // Append user message
    const userMsg: Message = {
      role: "user",
      content: typeof userInput === "string" ? userInput : userInput,
    };
    await this.context.appendMessage(userMsg);

    // Agent loop
    await this._agentLoop();
  }

  // ── Agent loop ──────────────────────────────────

  private async _agentLoop(): Promise<void> {
    const maxSteps = this.agent.runtime.config.loop_control.max_steps_per_turn;
    this._stepCount = 0;

    while (true) {
      // Check max steps — raise exception like Python
      if (this._stepCount >= maxSteps) {
        throw new MaxStepsReached(maxSteps);
      }

      // Check abort
      if (this.abortController?.signal.aborted) {
        this.callbacks.onStepInterrupted?.();
        break;
      }

      // Consume pending steers
      const hadSteers = await this._consumePendingSteers();

      // Check if compaction needed
      await this._maybeCompact();

      // Execute one step
      this._stepCount++;
      this.callbacks.onStepBegin?.(this._stepCount);

      const maxRetries = this.agent.runtime.config.loop_control.max_retries_per_step;
      const toolCalls = await withRetry(
        () => this._step(),
        maxRetries,
        `step ${this._stepCount}`,
      );

      // No tool calls = turn is done (unless steers are pending)
      if (toolCalls.length === 0) {
        // Check for pending steers — if any, force another iteration
        if (this._pendingSteers.length > 0) {
          continue;
        }
        break;
      }

      // Execute tools and collect results — shielded from abort
      await this._executeToolsShielded(toolCalls);

      // If a tool was rejected without feedback, stop the turn
      if (this._toolRejectedNoFeedback && this.agent.runtime.role !== "subagent") {
        logger.info("Turn stopped: tool was rejected without feedback");
        break;
      }
    }
  }

  /**
   * Execute tools and append results to context.
   * This is "shielded" from abort to keep context consistent —
   * once we start appending, we finish even if abort fires.
   */
  private async _executeToolsShielded(toolCalls: ToolCall[]): Promise<void> {
    for (const tc of toolCalls) {
      // Check abort before each tool, but don't interrupt mid-append
      if (this.abortController?.signal.aborted) break;

      const result = await this.agent.toolset.handle(tc);

      // Detect tool rejection without feedback
      if (result.isError && result.message?.includes("rejected by the user")) {
        // If the rejection message is just the standard template, no user feedback
        if (!result.extras?.userFeedback) {
          this._toolRejectedNoFeedback = true;
        }
      }

      // Build tool result message and append to context
      const resultMsg = toolResultMessage({
        toolCallId: tc.id,
        output: result.output,
        isError: result.isError,
        message: result.message,
      });
      // Append atomically — even if abort was signaled during tool execution,
      // we still append the result to keep context consistent
      await this.context.appendMessage(resultMsg);
    }
  }

  /** Drain the steer queue into context. Returns true if any steers were consumed. */
  private async _consumePendingSteers(): Promise<boolean> {
    if (this._pendingSteers.length === 0) return false;
    const steers = this._pendingSteers.splice(0);
    for (const msg of steers) {
      await this.context.appendMessage(msg);
    }
    return true;
  }

  // ── Single step ─────────────────────────────────

  private async _step(): Promise<ToolCall[]> {
    const llm = this.agent.runtime.llm;
    if (!llm) {
      throw new Error("No LLM configured");
    }

    // Build messages for LLM — normalize to merge adjacent user messages
    const rawMessages = [...this.context.history] as Message[];

    // Collect dynamic injections from providers (plan mode, yolo mode, etc.)
    const injections = await this._collectInjections();
    if (injections.length > 0) {
      // Add as the last user message wrapped in system-reminder tags
      const injectionContent = injections
        .map((inj) => `<system-reminder>\n${inj.content}\n</system-reminder>`)
        .join("\n\n");
      rawMessages.push({
        role: "user",
        content: injectionContent,
      });
    }

    // Normalize: merge adjacent user messages to avoid API errors
    const messages = normalizeHistory(rawMessages);

    // Call LLM
    const chatOptions: ChatOptions = {
      system: this.agent.systemPrompt,
      tools: this.agent.toolset.definitions(),
      signal: this.abortController?.signal,
    };

    let assistantText = "";
    let thinkText = "";
    const toolCalls: ToolCall[] = [];
    let usage: TokenUsage | null = null;

    const stream = llm.chat(messages, chatOptions);

    for await (const chunk of stream) {
      switch (chunk.type) {
        case "text":
          assistantText += chunk.text;
          this.callbacks.onTextDelta?.(chunk.text);
          break;

        case "think":
          thinkText += chunk.text;
          this.callbacks.onThinkDelta?.(chunk.text);
          break;

        case "tool_call":
          toolCalls.push({
            id: chunk.id,
            name: chunk.name,
            arguments: chunk.arguments,
          });
          this.callbacks.onToolCall?.({
            id: chunk.id,
            name: chunk.name,
            arguments: chunk.arguments,
          });
          break;

        case "usage":
          usage = chunk.usage;
          this._totalUsage = {
            inputTokens:
              this._totalUsage.inputTokens + chunk.usage.inputTokens,
            outputTokens:
              this._totalUsage.outputTokens + chunk.usage.outputTokens,
          };
          break;

        case "done":
          break;
      }
    }

    // Build assistant message content
    const contentParts: ContentPart[] = [];
    if (assistantText) {
      contentParts.push({ type: "text", text: assistantText });
    }
    for (const tc of toolCalls) {
      contentParts.push({
        type: "tool_use",
        id: tc.id,
        name: tc.name,
        input: JSON.parse(tc.arguments || "{}"),
      });
    }

    // Append assistant message to context
    // Note: reasoning_content (thinkText) is stored separately in the message
    // and will be serialized as reasoning_content field for the API
    if (contentParts.length > 0) {
      const assistantMsg: Message & { reasoning_content?: string } = {
        role: "assistant",
        content: contentParts,
      };
      // Preserve thinking content so it can be sent back to the model
      if (thinkText) {
        assistantMsg.reasoning_content = thinkText;
      }
      await this.context.appendMessage(assistantMsg);
    }

    // Update token count
    if (usage) {
      await this.context.updateTokenCount(usage);
    }

    // Wire log step results
    if (assistantText) {
      this._wireLog({ type: "text_part", text: assistantText });
    }
    for (const tc of toolCalls) {
      this._wireLog({ type: "tool_call", name: tc.name, id: tc.id });
    }

    // Send status update
    this.callbacks.onStatusUpdate?.(this.status);

    return toolCalls;
  }

  // ── Dynamic injections ──────────────────────────

  /** Collect dynamic injections from all registered providers. */
  private async _collectInjections(): Promise<DynamicInjection[]> {
    const injections: DynamicInjection[] = [];
    for (const provider of this._injectionProviders) {
      try {
        const result = await provider.getInjections(this.context.history, this);
        injections.push(...result);
      } catch (err) {
        logger.warn(`Injection provider failed: ${err}`);
      }
    }
    return injections;
  }

  // ── Compaction ──────────────────────────────────

  private async _maybeCompact(): Promise<void> {
    const llm = this.agent.runtime.llm;
    if (!llm) return;

    const lc = this.agent.runtime.config.loop_control;

    if (
      shouldCompact(
        this.context.tokenCountWithPending,
        llm.maxContextSize,
        lc.reserved_context_size,
        lc.compaction_trigger_ratio,
      )
    ) {
      this.callbacks.onCompactionBegin?.();
      try {
        await compactContext(this.context, llm);
      } catch (err) {
        logger.error(`Compaction failed: ${err}`);
      }
      this.callbacks.onCompactionEnd?.();
    }
  }

  // ── Slash command wiring ────────────────────────

  wireSlashCommands(): void {
    const registry = this.agent.slashCommands;

    // Wire /clear
    const clearCmd = registry.get("clear");
    if (clearCmd) {
      clearCmd.handler = async () => {
        await this.context.clear();
        await this.context.writeSystemPrompt(this.agent.systemPrompt);
        logger.info("Context cleared");
        this.callbacks.onStatusUpdate?.(this.status);
      };
    }

    // Wire /compact
    const compactCmd = registry.get("compact");
    if (compactCmd) {
      compactCmd.handler = async (args: string) => {
        if (this.context.nCheckpoints === 0) {
          logger.info("The context is empty.");
          return;
        }
        const llm = this.agent.runtime.llm;
        if (!llm) return;
        logger.info("Running `/compact`");
        await compactContext(this.context, llm, { focus: args || undefined });
        this.callbacks.onStatusUpdate?.(this.status);
      };
    }

    // Wire /yolo
    const yoloCmd = registry.get("yolo");
    if (yoloCmd) {
      yoloCmd.handler = async () => {
        if (this.agent.runtime.approval.isYolo()) {
          this.agent.runtime.approval.setYolo(false);
          logger.info("YOLO mode: OFF");
        } else {
          this.agent.runtime.approval.setYolo(true);
          logger.info("YOLO mode: ON");
        }
      };
    }

    // Wire /plan with subcmd support (on/off/view/clear/toggle)
    const planCmd = registry.get("plan");
    if (planCmd) {
      planCmd.handler = async (args: string) => {
        const subcmd = args.trim().toLowerCase();
        if (subcmd === "on") {
          if (!this._planMode) await this.togglePlanModeFromManual();
          const planPath = this.getPlanFilePath();
          logger.info(`Plan mode ON. Plan file: ${planPath}`);
          this.callbacks.onStatusUpdate?.({ planMode: this._planMode });
        } else if (subcmd === "off") {
          if (this._planMode) await this.togglePlanModeFromManual();
          logger.info("Plan mode OFF. All tools are now available.");
          this.callbacks.onStatusUpdate?.({ planMode: this._planMode });
        } else if (subcmd === "view") {
          const content = this.readCurrentPlan();
          if (content) {
            logger.info(content);
          } else {
            logger.info("No plan file found for this session.");
          }
        } else if (subcmd === "clear") {
          this.clearCurrentPlan();
          logger.info("Plan cleared.");
        } else {
          // Default: toggle
          const newState = await this.togglePlanModeFromManual();
          if (newState) {
            const planPath = this.getPlanFilePath();
            logger.info(`Plan mode ON. Write your plan to: ${planPath}`);
          } else {
            logger.info("Plan mode OFF. All tools are now available.");
          }
          this.callbacks.onStatusUpdate?.({ planMode: this._planMode });
        }
      };
    }

    // Wire /model
    const modelCmd = registry.get("model");
    if (modelCmd) {
      const notify = (t: string, b: string) => this.notify(t, b);
      const configMeta = { isFromDefaultLocation: true, sourceFile: null };
      modelCmd.handler = async () => {
        await handleModel(this.agent.runtime.config, configMeta, notify);
      };
      modelCmd.panel = () => createModelPanel(this.agent.runtime.config, configMeta, notify);
    }

    // Wire /export
    const exportCmd = registry.get("export");
    if (exportCmd) {
      exportCmd.handler = async (args: string) => {
        await handleExport(this.context, this.agent.runtime.session, args);
      };
    }

    // Wire /import
    const importCmd = registry.get("import");
    if (importCmd) {
      importCmd.handler = async (args: string) => {
        await handleImport(this.context, this.agent.runtime.session, args);
      };
    }

    // Wire /web
    const webCmd = registry.get("web");
    if (webCmd) {
      webCmd.handler = async () => {
        handleWeb(this.agent.runtime.session.id);
      };
    }

    // Wire /vis
    const visCmd = registry.get("vis");
    if (visCmd) {
      visCmd.handler = async () => {
        handleVis(this.agent.runtime.session.id);
      };
    }

    // Wire /reload
    const reloadCmd = registry.get("reload");
    if (reloadCmd) {
      reloadCmd.handler = async () => {
        handleReload();
      };
    }

    // Wire /task
    const taskCmd = registry.get("task");
    if (taskCmd) {
      taskCmd.handler = async () => {
        handleTask();
      };
    }

    // Wire /login
    const loginCmd = registry.get("login");
    if (loginCmd) {
      const notify = (t: string, b: string) => this.notify(t, b);
      loginCmd.handler = async () => {
        await handleLogin(this.agent.runtime.config, notify);
      };
      loginCmd.panel = () => createLoginPanel(this.agent.runtime.config, notify);
    }

    // Wire /logout
    const logoutCmd = registry.get("logout");
    if (logoutCmd) {
      logoutCmd.handler = async () => {
        await handleLogout(this.agent.runtime.config, (t, b) => this.notify(t, b));
      };
    }

    // Wire /usage
    const usageCmd = registry.get("usage");
    if (usageCmd) {
      usageCmd.handler = async () => {
        await handleUsage(this.agent.runtime.config, this.agent.runtime.config.default_model || undefined);
      };
    }

    // Wire /feedback
    const feedbackCmd = registry.get("feedback");
    if (feedbackCmd) {
      feedbackCmd.handler = async (args: string) => {
        await handleFeedback(
          this.agent.runtime.config,
          args,
          this.agent.runtime.session.id,
          this.agent.runtime.config.default_model || undefined,
        );
      };
    }

    // Wire /editor
    const editorCmd = registry.get("editor");
    if (editorCmd) {
      editorCmd.handler = async (args: string) => {
        await handleEditor(this.agent.runtime.config, { isFromDefaultLocation: true, sourceFile: null }, args);
      };
    }

    // Wire /hooks
    const hooksCmd = registry.get("hooks");
    if (hooksCmd) {
      hooksCmd.handler = async () => {
        handleHooks(this.agent.runtime.hookEngine);
      };
    }

    // Wire /mcp
    const mcpCmd = registry.get("mcp");
    if (mcpCmd) {
      mcpCmd.handler = async () => {
        handleMcp(this.agent.runtime.config);
      };
    }

    // Wire /debug
    const debugCmd = registry.get("debug");
    if (debugCmd) {
      debugCmd.handler = async () => {
        handleDebug(this.context);
      };
    }

    // Wire /changelog
    const changelogCmd = registry.get("changelog");
    if (changelogCmd) {
      changelogCmd.handler = async () => {
        handleChangelog();
      };
    }

    // Wire /new
    const newCmd = registry.get("new");
    if (newCmd) {
      newCmd.handler = async () => {
        await handleNew(this.agent.runtime.session);
      };
    }

    // Wire /sessions
    const sessionsCmd = registry.get("sessions");
    if (sessionsCmd) {
      sessionsCmd.handler = async () => {
        await handleSessions(this.agent.runtime.session);
      };
    }

    // Wire /title
    const titleCmd = registry.get("title");
    if (titleCmd) {
      titleCmd.handler = async (args: string) => {
        await handleTitle(this.agent.runtime.session, args);
      };
    }

    // Wire /init
    const initCmd = registry.get("init");
    if (initCmd) {
      initCmd.handler = async () => {
        const result = await handleInit(this.agent.runtime.session.workDir);
        if (result) {
          // Inject the generated AGENTS.md into context so the LLM knows about it
          await this.context.appendMessage({
            role: "user",
            content: `The user ran /init. Generated AGENTS.md:\n${result}`,
          });
        }
      };
    }

    // Wire /add-dir
    const addDirCmd = registry.get("add-dir");
    if (addDirCmd) {
      addDirCmd.handler = async (args: string) => {
        const result = await handleAddDir(
          this.agent.runtime.session,
          this.agent.runtime.session.workDir,
          args,
        );
        if (result) {
          // Inject directory info into context so the LLM knows about it
          await this.context.appendMessage({
            role: "user",
            content: result,
          });
        }
      };
    }
  }

  /** Wire tool context callbacks (plan mode, ask user, etc.) to the soul. */
  wireToolContext(): void {
    const ctx = this.agent.toolset.context;
    ctx.setPlanMode = (on: boolean) => this.setPlanMode(on);
    ctx.getPlanMode = () => this._planMode;
    ctx.getPlanFilePath = () => this.getPlanFilePath() ?? undefined;
    ctx.togglePlanMode = () => this.togglePlanMode();
  }

  // ── Wire file logging ────────────────────────────

  /**
   * Append a wire event to the session's wire.jsonl file.
   * Used for session title generation and debugging.
   */
  private async _wireLog(event: Record<string, unknown>): Promise<void> {
    const wireFile = this.agent.runtime.session.wireFile;
    if (!wireFile) return;
    try {
      const { appendFile } = await import("node:fs/promises");
      const line = JSON.stringify({ ...event, ts: Date.now() }) + "\n";
      await appendFile(wireFile, line, "utf-8");
    } catch {
      // Wire logging is best-effort — don't crash on failure
    }
  }
}

// ── FlowRunner ─────────────────────────────────────

import type { Flow, FlowNode, FlowEdge } from "../skill/flow/index.ts";
import { parseChoice } from "../skill/flow/index.ts";

const DEFAULT_MAX_FLOW_MOVES = 1000;
const FLOW_COMMAND_PREFIX = "flow:";

interface FlowTurnResult {
  /** Number of agent steps used in this turn. */
  stepCount: number;
  /** Why the turn stopped. */
  stopReason: "no_tool_calls" | "tool_rejected";
  /** The final assistant message text, if any. */
  finalText: string | undefined;
}

/**
 * Drives the agent through a Flow graph, executing task and decision nodes.
 * Corresponds to Python `FlowRunner` in `soul/kimisoul.py`.
 */
export class FlowRunner {
  private readonly _flow: Flow;
  private readonly _name: string | undefined;
  private readonly _maxMoves: number;

  constructor(flow: Flow, opts?: { name?: string; maxMoves?: number }) {
    this._flow = flow;
    this._name = opts?.name;
    this._maxMoves = opts?.maxMoves ?? DEFAULT_MAX_FLOW_MOVES;
  }

  /**
   * Build a FlowRunner for the ralph (auto-repeat) loop pattern.
   * The agent runs a task repeatedly until it chooses STOP.
   */
  static ralphLoop(
    promptText: string,
    maxRalphIterations: number,
  ): FlowRunner {
    const totalRuns =
      maxRalphIterations < 0 ? 1_000_000_000_000_000 : maxRalphIterations + 1;

    const nodes: Record<string, FlowNode> = {
      BEGIN: { id: "BEGIN", label: "BEGIN", kind: "begin" },
      END: { id: "END", label: "END", kind: "end" },
      R1: { id: "R1", label: promptText, kind: "task" },
      R2: {
        id: "R2",
        label:
          `${promptText}. (You are running in an automated loop where the same ` +
          "prompt is fed repeatedly. Only choose STOP when the task is fully complete. " +
          "Including it will stop further iterations. If you are not 100% sure, " +
          "choose CONTINUE.)",
        kind: "decision",
      },
    };

    const outgoing: Record<string, FlowEdge[]> = {
      BEGIN: [{ src: "BEGIN", dst: "R1", label: undefined }],
      R1: [{ src: "R1", dst: "R2", label: undefined }],
      R2: [
        { src: "R2", dst: "R2", label: "CONTINUE" },
        { src: "R2", dst: "END", label: "STOP" },
      ],
      END: [],
    };

    const flow: Flow = { nodes, outgoing, beginId: "BEGIN", endId: "END" };
    return new FlowRunner(flow, { maxMoves: totalRuns });
  }

  /** Execute the flow graph using the given KimiSoul. */
  async run(soul: KimiSoul, args: string): Promise<void> {
    if (args.trim()) {
      const command = this._name
        ? `/${FLOW_COMMAND_PREFIX}${this._name}`
        : "/flow";
      logger.warn(`Agent flow ${command} ignores args: ${args}`);
      return;
    }

    let currentId = this._flow.beginId;
    let moves = 0;
    let totalSteps = 0;

    while (true) {
      const node = this._flow.nodes[currentId];
      if (!node) {
        logger.error(`Agent flow: unknown node "${currentId}"; stopping.`);
        return;
      }
      const edges = this._flow.outgoing[currentId] ?? [];

      if (node.kind === "end") {
        logger.info(`Agent flow reached END node ${currentId}`);
        return;
      }

      if (node.kind === "begin") {
        if (edges.length === 0) {
          logger.error(
            `Agent flow BEGIN node "${node.id}" has no outgoing edges; stopping.`,
          );
          return;
        }
        currentId = edges[0]!.dst;
        continue;
      }

      if (moves >= this._maxMoves) {
        throw new MaxStepsReached(totalSteps);
      }

      const result = await this._executeFlowNode(soul, node, edges);
      totalSteps += result.stepsUsed;
      if (result.nextId === undefined) return;
      moves++;
      currentId = result.nextId;
    }
  }

  private async _executeFlowNode(
    soul: KimiSoul,
    node: FlowNode,
    edges: FlowEdge[],
  ): Promise<{ nextId: string | undefined; stepsUsed: number }> {
    if (edges.length === 0) {
      logger.error(
        `Agent flow node "${node.id}" has no outgoing edges; stopping.`,
      );
      return { nextId: undefined, stepsUsed: 0 };
    }

    const basePrompt = FlowRunner._buildFlowPrompt(node, edges);
    let prompt = basePrompt;
    let stepsUsed = 0;

    while (true) {
      const result = await FlowRunner._flowTurn(soul, prompt);
      stepsUsed += result.stepCount;

      if (result.stopReason === "tool_rejected") {
        logger.error("Agent flow stopped after tool rejection.");
        return { nextId: undefined, stepsUsed };
      }

      if (node.kind !== "decision") {
        return { nextId: edges[0]!.dst, stepsUsed };
      }

      const choice = result.finalText
        ? parseChoice(result.finalText)
        : undefined;
      const nextId = FlowRunner._matchFlowEdge(edges, choice);
      if (nextId !== undefined) {
        return { nextId, stepsUsed };
      }

      const options = edges.map((e) => e.label ?? "").join(", ");
      logger.warn(
        `Agent flow invalid choice. Got: ${choice ?? "<missing>"}. Available: ${options}.`,
      );
      prompt =
        `${basePrompt}\n\n` +
        "Your last response did not include a valid choice. " +
        "Reply with one of the choices using <choice>...</choice>.";
    }
  }

  private static _buildFlowPrompt(
    node: FlowNode,
    edges: FlowEdge[],
  ): string {
    if (node.kind !== "decision") {
      return node.label;
    }

    const choices = edges.filter((e) => e.label).map((e) => e.label!);
    const lines = [
      node.label,
      "",
      "Available branches:",
      ...choices.map((c) => `- ${c}`),
      "",
      "Reply with a choice using <choice>...</choice>.",
    ];
    return lines.join("\n");
  }

  private static _matchFlowEdge(
    edges: FlowEdge[],
    choice: string | undefined,
  ): string | undefined {
    if (!choice) return undefined;
    for (const edge of edges) {
      if (edge.label === choice) return edge.dst;
    }
    return undefined;
  }

  private static async _flowTurn(
    soul: KimiSoul,
    prompt: string,
  ): Promise<FlowTurnResult> {
    // TODO: Wire TurnBegin/TurnEnd events once wire_send is available
    // For now, drive the soul's internal _turn method
    const stepsBefore = soul["_stepCount"];
    await soul["_turn"](prompt);
    const stepsAfter = soul["_stepCount"];

    // Extract final assistant text from context
    const history = soul["context"].messages;
    const lastMsg = history.length > 0 ? history[history.length - 1] : undefined;
    let finalText: string | undefined;
    if (lastMsg?.role === "assistant") {
      finalText =
        typeof lastMsg.content === "string"
          ? lastMsg.content
          : Array.isArray(lastMsg.content)
            ? lastMsg.content
                .filter((p): p is { type: "text"; text: string } => "type" in p && p.type === "text")
                .map((p) => p.text)
                .join(" ")
            : undefined;
    }

    return {
      stepCount: stepsAfter - stepsBefore,
      stopReason: "no_tool_calls",
      finalText,
    };
  }
}
