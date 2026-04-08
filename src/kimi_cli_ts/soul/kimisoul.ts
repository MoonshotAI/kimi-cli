/**
 * KimiSoul — corresponds to Python soul/kimisoul.py
 * The core agent loop: receive input → call LLM → execute tools → repeat.
 */

import type {
	Message,
	ContentPart,
	ToolCall,
	TokenUsage,
	StatusSnapshot,
	SlashCommand,
	ModelCapability,
} from "../types.ts";
import type { ToolResult } from "../tools/types.ts";
import type { LLM, StreamChunk, ChatOptions, LLMProvider } from "../llm.ts";
import {
	ChatProviderError,
	APIConnectionError,
	APITimeoutError,
	APIStatusError,
	APIEmptyResponseError,
	isRetryableChatProvider,
} from "../llm.ts";
import type { HookEngine } from "../hooks/engine.ts";
import type { Config } from "../config.ts";
import type { Session } from "../session.ts";
import { Context } from "./context.ts";
import { Agent, type Runtime } from "./agent.ts";
import { KimiToolset } from "./toolset.ts";
import { SlashCommandRegistry } from "./slash.ts";
import { compactContext, shouldCompact } from "./compaction.ts";
import { toolResultMessage, systemReminder, checkMessage } from "./message.ts";
import type {
	DynamicInjection,
	DynamicInjectionProvider,
} from "./dynamic_injection.ts";
import { normalizeHistory } from "./dynamic_injection.ts";
import { PlanModeInjectionProvider } from "./dynamic_injections/plan_mode.ts";
import { YoloModeInjectionProvider } from "./dynamic_injections/yolo_mode.ts";
import { wireSend, wireMsg, getWireOrNull } from "./index.ts";
import { MaxStepsReached, LLMNotSet, LLMNotSupported } from "./index.ts";
import { Reload } from "../cli/errors.ts";
import {
	handleNew,
	handleSessions,
	handleTitle,
	createSessionsPanel,
	createTitlePanel,
} from "../ui/shell/commands/session.ts";
import { handleModel, createModelPanel } from "../ui/shell/commands/model.ts";
import {
	handleLogin,
	handleLogout,
	createLoginPanel,
} from "../ui/shell/commands/login.ts";
import {
	handleHooks,
	handleMcp,
	handleDebug,
	handleChangelog,
	createHooksPanel,
	createMcpPanel,
	createDebugPanel,
	createChangelogPanel,
} from "../ui/shell/commands/info.ts";
import {
	handleExport,
	handleImport,
} from "../ui/shell/commands/export_import.ts";
import {
	handleWeb,
	handleVis,
	handleTask,
} from "../ui/shell/commands/misc.ts";
import { handleUsage } from "../ui/shell/commands/usage.ts";
import {
	handleFeedback,
	createFeedbackPanel,
} from "../ui/shell/commands/feedback.ts";
import {
	handleEditor,
	createEditorPanel,
} from "../ui/shell/commands/editor.ts";
import { handleInit } from "../ui/shell/commands/init.ts";
import { handleAddDir } from "../ui/shell/commands/add_dir.ts";
import { logger } from "../utils/logging.ts";
import { readSkillText, type Skill } from "../skill/index.ts";

// ── Errors (re-export from soul/index.ts) ───────────────────

export {
	LLMNotSet,
	LLMNotSupported,
	MaxStepsReached,
	RunCancelled,
} from "./index.ts";

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

// ── Retry helpers (aligned with Python kimisoul.py) ────────

/** Aligned with Python KimiSoul._is_retryable_error (kimisoul.py:1019-1031) */
function isRetryableError(err: unknown): boolean {
	// Structured error types (primary path)
	if (err instanceof APIConnectionError || err instanceof APITimeoutError) {
		return !(err as any)._kimiRecoveryExhausted;
	}
	if (err instanceof APIEmptyResponseError) return true;
	if (err instanceof APIStatusError) {
		return [429, 500, 502, 503, 504].includes(err.statusCode);
	}
	// Fallback: string matching for non-structured errors (e.g. from third-party code)
	if (err instanceof Error) {
		const msg = err.message.toLowerCase();
		if (/\b(429|500|502|503|504)\b/.test(msg)) return true;
		if (
			msg.includes("timeout") ||
			msg.includes("econnreset") ||
			msg.includes("econnrefused") ||
			msg.includes("fetch failed") ||
			msg.includes("socket hang up")
		)
			return true;
		if (msg.includes("empty response") || msg.includes("no body"))
			return true;
	}
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
			logger.warn(
				`${label}: retryable error (attempt ${attempt + 1}/${maxRetries}), retrying in ${Math.round(delay)}ms: ${err instanceof Error ? err.message : err}`,
			);
			await sleep(delay);
		}
	}
	throw lastError;
}

// ── KimiSoul ────────────────────────────────────────

export class KimiSoul {
	private agent: Agent;
	private context: Context;
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
	}) {
		this.agent = opts.agent;
		this.context = opts.context;

		// Restore plan mode from session state
		this._planMode = opts.agent.runtime.session.state.plan_mode ?? false;
		this._planSessionId =
			opts.agent.runtime.session.state.plan_session_id ?? null;
		if (this._planMode) {
			this._ensurePlanSessionId();
		}

		// Initialize dynamic injection providers
		this._injectionProviders = [
			new PlanModeInjectionProvider(),
			new YoloModeInjectionProvider(),
		];

		// Build and register skill slash commands
		this._buildSkillSlashCommands();
	}

	/**
	 * Build slash commands from discovered skills.
	 * Mirrors Python KimiSoul._build_slash_commands()
	 */
	private _buildSkillSlashCommands(): void {
		const commands = this.agent.slashCommands.list();
		const seenNames = new Set<string>(commands.map((c) => c.name));

		// Register skill commands (/skill:name)
		for (const skill of this.agent.runtime.skills.values()) {
			if (skill.type !== "standard" && skill.type !== "flow") {
				continue;
			}
			const name = `${SKILL_COMMAND_PREFIX}${skill.name}`;
			if (seenNames.has(name)) {
				logger.warn(
					`Skipping skill slash command /${name}: name already registered`,
				);
				continue;
			}

			const skillCommand: SlashCommand = {
				name,
				description: skill.description || "",
				handler: this._makeSkillRunner(skill),
				aliases: [],
			};
			this.agent.slashCommands.register(skillCommand);
			seenNames.add(name);
		}

		// Register flow commands (/flow:name)
		for (const skill of this.agent.runtime.skills.values()) {
			if (skill.type !== "flow") {
				continue;
			}
			if (!skill.flow) {
				logger.warn(`Flow skill ${skill.name} has no flow; skipping`);
				continue;
			}

			const commandName = `${FLOW_COMMAND_PREFIX}${skill.name}`;
			if (seenNames.has(commandName)) {
				logger.warn(
					`Skipping prompt flow slash command /${commandName}: name already registered`,
				);
				continue;
			}

			const runner = new FlowRunner(skill.flow, { name: skill.name });
			const flowCommand: SlashCommand = {
				name: commandName,
				description: skill.description || "",
				handler: (args: string) => runner.run(this, args),
				aliases: [],
			};
			this.agent.slashCommands.register(flowCommand);
			seenNames.add(commandName);
		}
	}

	/**
	 * Create a skill runner function for a given skill.
	 * Mirrors Python KimiSoul._make_skill_runner()
	 *
	 * Called from within run()'s TurnBegin/TurnEnd lifecycle.
	 * Simply calls _turn() directly, exactly as Python does:
	 *   await soul._turn(Message(role="user", content=skill_text))
	 */
	private _makeSkillRunner(skill: Skill) {
		return async (args: string): Promise<void> => {
			const skillText = readSkillText(skill);
			if (!skillText) {
				this.notify("Skill Error", `Failed to load skill "${skill.name}".`);
				return;
			}

			let finalText = skillText;
			const extra = args.trim();
			if (extra) {
				finalText = `${skillText}\n\nUser request:\n${extra}`;
			}

			await this._turn(finalText);
		};
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
			yoloEnabled: this.isYolo,
			mcpStatus: null,
		};
	}

	get hookEngine(): HookEngine {
		return this.agent.runtime.hookEngine;
	}

	/** Push a notification to the wire. */
	notify(title: string, body: string): void {
		try {
			wireSend(
				wireMsg("Notification", {
					id: crypto.randomUUID(),
					category: "system",
					type: "info",
					source_kind: "soul",
					source_id: this.name,
					title,
					body,
					severity: "info",
					created_at: Date.now() / 1000,
					payload: {},
				}),
			);
		} catch {
			// Wire may not be available (e.g. during construction)
			logger.warn(`Notification dropped (no wire): ${title}`);
		}
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
		// Persist to session state (matches Python — no wire_send here)
		this.agent.runtime.session.state.plan_mode = this._planMode;
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

	/** Send a full StatusUpdate over the wire. */
	private _sendStatusUpdate(): void {
		const snap = this.status;
		wireSend(
			wireMsg("StatusUpdate", {
				context_usage: snap.contextUsage ?? null,
				context_tokens: snap.contextTokens ?? null,
				max_context_tokens: snap.maxContextTokens ?? null,
				token_usage: snap.tokenUsage
					? {
							__wireType: "TokenUsage",
							input_other: snap.tokenUsage.inputTokens,
							output: snap.tokenUsage.outputTokens,
							input_cache_read: snap.tokenUsage.cacheReadTokens ?? 0,
							input_cache_creation: snap.tokenUsage.cacheWriteTokens ?? 0,
						}
					: null,
				message_id: null,
				plan_mode: snap.planMode ?? false,
				mcp_status: this.agent.toolset.mcpStatusSnapshot() ?? null,
			}),
		);
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

		this._isRunning = true;
		this.abortController = new AbortController();
		this._toolRejectedNoFeedback = false;

		let turnStarted = false;
		let turnFinished = false;
		try {
			wireSend(
				wireMsg("TurnBegin", {
					user_input: userInput,
				}),
			);
			turnStarted = true;

			// Slash command dispatch — inside turn lifecycle, matching Python soul/kimisoul.py:505-521.
			// TurnBegin has already been emitted with the original user input (e.g. "/skill:foo").
			const commandCall = this._parseSlashCommand(userInput);
			if (commandCall) {
				const command = this.agent.slashCommands.get(commandCall.name);
				if (command) {
					await command.handler(commandCall.args);
				} else {
					// Unknown command (shouldn't happen — Shell already filtered)
					this.notify(
						"Unknown command",
						`Unknown slash command "/${commandCall.name}".`,
					);
				}
			} else {
				await this._turn(userInput);
			}

			wireSend(wireMsg("TurnEnd"));
			turnFinished = true;
		} catch (err) {
			if (err instanceof Error && err.name === "AbortError") {
				logger.info("Turn aborted");
				wireSend(wireMsg("StepInterrupted"));
			} else if (err instanceof MaxStepsReached) {
				// Re-throw MaxStepsReached so the wire server can handle it
				// (matching Python behavior where this propagates to the caller)
				wireSend(wireMsg("TurnEnd"));
				turnFinished = true;
				throw err;
			} else if (err instanceof LLMNotSet || err instanceof LLMNotSupported) {
				// Re-throw LLM errors so the wire server can map them to JSON-RPC error codes
				// (matching Python behavior where these propagate to the caller)
				throw err;
			} else if (err instanceof ChatProviderError) {
				// Re-throw ChatProviderError (and subclasses: APITimeoutError,
				// APIConnectionError, etc.) for wire server error mapping
				throw err;
			} else if (err instanceof Error && err.name === "Reload") {
				// Re-throw Reload so cli/index.ts can catch it and trigger reload loop
				throw err;
			} else {
				logger.error(`Turn error: ${err}`);
			}
		} finally {
			if (turnStarted && !turnFinished) {
				wireSend(wireMsg("TurnEnd"));
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

	// ── Slash command parsing ──────────────────────────

	/**
	 * Parse a slash command from user input.
	 * Mirrors Python utils/slashcmd.py:parse_slash_command_call()
	 */
	private _parseSlashCommand(
		userInput: string | ContentPart[],
	): { name: string; args: string } | null {
		const text = typeof userInput === "string" ? userInput.trim() : "";
		if (!text || !text.startsWith("/")) return null;

		const match = text.match(/^\/([a-zA-Z0-9_-]+(?::[a-zA-Z0-9_-]+)*)/);
		if (!match || !match[1]) return null;

		const name = match[1];
		const rest = text.slice(match[0].length);
		// If there's a non-space character immediately after the command name, it's not a valid command
		if (rest.length > 0 && !/^\s/.test(rest)) return null;

		return { name, args: rest.trim() };
	}

	// ── Turn execution ──────────────────────────────

	private async _turn(userInput: string | ContentPart[]): Promise<void> {
		// Validate LLM is set and supports required capabilities (matches Python _turn)
		const llm = this.agent.runtime.llm;
		if (!llm) {
			throw new LLMNotSet();
		}

		// Create checkpoint before appending user message (mirrors Python: self._checkpoint())
		await this.context.checkpoint();

		// Append user message
		const userMsg: Message = {
			role: "user",
			content: typeof userInput === "string" ? userInput : userInput,
		};

		// Check message capabilities (matches Python: check_message())
		const missingCaps = checkMessage(userMsg, llm.capabilities);
		if (missingCaps.size > 0) {
			throw new LLMNotSupported(
				llm.modelName,
				Array.from(missingCaps),
			);
		}

		await this.context.appendMessage(userMsg);

		// Agent loop
		await this._agentLoop();
	}

	// ── Agent loop ──────────────────────────────────

	private async _agentLoop(): Promise<void> {
		const maxSteps = this.agent.runtime.config.loop_control.max_steps_per_turn;
		this._stepCount = 0;

		// ── MCP deferred loading (mirrors Python kimisoul.py lines 674-685) ──
		const toolset = this.agent.toolset;
		await toolset.startDeferredMcpToolLoading();
		const mcpLoading = toolset.hasPendingMcpTools();
		if (mcpLoading) {
			const snapshot = toolset.mcpStatusSnapshot();
			if (snapshot) {
				wireSend(wireMsg("StatusUpdate", { mcp_status: snapshot }));
			}
			wireSend(wireMsg("MCPLoadingBegin", {}));
			try {
				await toolset.waitForMcpTools();
			} finally {
				const finalSnapshot = toolset.mcpStatusSnapshot();
				if (finalSnapshot) {
					wireSend(wireMsg("StatusUpdate", { mcp_status: finalSnapshot }));
				}
				wireSend(wireMsg("MCPLoadingEnd", {}));
			}
		}

		while (true) {
			// Check max steps — raise exception like Python
			if (this._stepCount >= maxSteps) {
				throw new MaxStepsReached(maxSteps);
			}

			// Check abort
			if (this.abortController?.signal.aborted) {
				wireSend(wireMsg("StepInterrupted"));
				break;
			}

			// Consume pending steers
			const hadSteers = await this._consumePendingSteers();

			// Check if compaction needed
			await this._maybeCompact();

			// Execute one step
			this._stepCount++;
			wireSend(wireMsg("StepBegin", { n: this._stepCount }));

			const maxRetries =
				this.agent.runtime.config.loop_control.max_retries_per_step;
			const provider = this.agent.runtime.llm?.provider;
			const toolCalls = await withRetry(
				() =>
					this._runWithConnectionRecovery(
						"step",
						() => this._step(),
						provider,
					),
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
			if (
				this._toolRejectedNoFeedback &&
				this.agent.runtime.role !== "subagent"
			) {
				logger.info("Turn stopped: tool was rejected without feedback");
				break;
			}
		}
	}

	/**
	 * Execute tools and append results to context.
	 * This is "shielded" from abort to keep context consistent —
	 * once we start appending, we finish even if abort fires.
	 *
	 * Mirrors Python's concurrent tool execution pattern:
	 * - Tool calls are dispatched as concurrent promises (not awaited immediately)
	 * - All promises are collected, then awaited together
	 * - Results are appended sequentially to maintain context order
	 */
	private async _executeToolsShielded(toolCalls: ToolCall[]): Promise<void> {
		// Phase 1: Dispatch all tool calls as concurrent promises (non-blocking)
		// This mirrors Python's toolset.handle() which returns asyncio.Task immediately
		const toolPromises = toolCalls.map((tc) => ({
			tc,
			promise: this.agent.toolset.handle(tc),
		}));

		// Phase 2: Collect all results concurrently
		// All tool executions run in parallel, but we wait for all to complete
		const results = await Promise.all(
			toolPromises.map(async (item) => {
				// Check abort before waiting for result, but don't interrupt mid-execution
				if (this.abortController?.signal.aborted) return null;
				try {
					return { tc: item.tc, result: await item.promise };
				} catch (err) {
					// Tool execution failed — wrap as error result
					return {
						tc: item.tc,
						result: {
							isError: true,
							output: "",
							message: `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`,
						},
					};
				}
			}),
		);

		// Phase 3: Append results sequentially to maintain context order consistency
		// This is where sequential coordination happens even though execution was concurrent
		for (const entry of results) {
			if (!entry) continue;
			const { tc, result } = entry;

			// Detect tool rejection without feedback
			if (result.isError && result.message?.includes("rejected by the user")) {
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

			// Wire log the tool result (matching Python format)
			wireSend(
				wireMsg("ToolResult", {
					tool_call_id: tc.id,
					return_value: {
						is_error: result.isError,
						output: result.output,
						message: result.message ?? "",
						display: result.display ?? [],
						extras: result.extras ?? null,
					},
				}),
			);

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

	// ── Connection recovery (aligned with Python kimisoul.py:1033-1065) ──

	/**
	 * Run an operation with connection recovery. On APIConnectionError or
	 * APITimeoutError, attempt provider-level recovery (e.g. recreating the
	 * HTTP client) and retry the operation once before re-raising.
	 */
	private async _runWithConnectionRecovery<T>(
		name: string,
		operation: () => Promise<T>,
		chatProvider?: LLMProvider,
	): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			if (
				!(error instanceof APIConnectionError) &&
				!(error instanceof APITimeoutError)
			) {
				throw error;
			}
			if (!isRetryableChatProvider(chatProvider)) throw error;

			let recovered: boolean;
			try {
				recovered = chatProvider.onRetryableError(error);
			} catch {
				throw error;
			}
			if (!recovered) throw error;

			logger.info(
				`Recovered chat provider during ${name} after ${error.name}; retrying once.`,
			);
			try {
				return await operation();
			} catch (secondError) {
				if (
					secondError instanceof APIConnectionError ||
					secondError instanceof APITimeoutError
				) {
					(secondError as any)._kimiRecoveryExhausted = true;
				}
				throw secondError;
			}
		}
	}

	// ── Single step ─────────────────────────────────

	private async _step(): Promise<ToolCall[]> {
		const llm = this.agent.runtime.llm;
		if (!llm) {
			throw new LLMNotSet();
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
		let messageId: string | null = null;
		// Track in-progress tool call parts for streaming accumulation
		const pendingToolCallParts = new Map<string, { id: string; name: string; arguments: string }>();

		const stream = llm.chat(messages, chatOptions);

		for await (const chunk of stream) {
			switch (chunk.type) {
				case "text":
					assistantText += chunk.text;
					// Stream text as TextPart wire event (matches Python on_message_part=wire_send)
					wireSend(wireMsg("TextPart", { type: "text", text: chunk.text }));
					break;

				case "think":
					thinkText += chunk.text;
					wireSend(wireMsg("ThinkPart", { type: "think", think: chunk.text, encrypted: null }));
					break;

				case "tool_call":
					toolCalls.push({
						id: chunk.id,
						name: chunk.name,
						arguments: chunk.arguments,
					});
					// Send ToolCall wire event (nested function structure matching Python format)
					wireSend(
						wireMsg("ToolCall", {
							type: "function",
							id: chunk.id,
							function: { name: chunk.name, arguments: chunk.arguments },
							extras: null,
						}),
					);
					break;

				case "tool_call_part": {
					// Streaming tool call part — accumulate arguments
					const key = chunk.id || "__default__";
					if (chunk.argumentsPart === null) {
						// Final part — finalize tool call
						const pending = pendingToolCallParts.get(key);
						if (pending) {
							toolCalls.push({
								id: pending.id,
								name: pending.name,
								arguments: pending.arguments,
							});
							wireSend(
								wireMsg("ToolCall", {
									type: "function",
									id: pending.id,
									function: { name: pending.name, arguments: pending.arguments },
									extras: null,
								}),
							);
							pendingToolCallParts.delete(key);
						}
					} else {
						let pending = pendingToolCallParts.get(key);
						if (!pending) {
							pending = { id: chunk.id, name: chunk.name, arguments: "" };
							pendingToolCallParts.set(key, pending);
						}
						pending.arguments += chunk.argumentsPart;
						// Emit ToolCallPart wire event for streaming UI
						wireSend(
							wireMsg("ToolCallPart", {
								type: "tool_use",
								id: pending.id,
								name: pending.name,
								input: {},
							}),
						);
					}
					break;
				}

				case "usage":
					usage = chunk.usage;
					this._totalUsage = {
						inputTokens: this._totalUsage.inputTokens + chunk.usage.inputTokens,
						outputTokens:
							this._totalUsage.outputTokens + chunk.usage.outputTokens,
					};
					break;

				case "done":
					if (chunk.messageId) {
						messageId = chunk.messageId;
					}
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

		// Wire status update (matches Python: wire_send(StatusUpdate(...)))
		// Python only sets context_usage/context_tokens/max_context_tokens when usage is present
		const snap = this.status;
		const statusPayload: Record<string, unknown> = {
			context_usage: null,
			context_tokens: null,
			max_context_tokens: null,
			token_usage: usage
				? {
						__wireType: "TokenUsage",
						input_other: usage.inputTokens,
						output: usage.outputTokens,
						input_cache_read: usage.cacheReadTokens ?? 0,
						input_cache_creation: usage.cacheWriteTokens ?? 0,
					}
				: null,
			message_id: messageId,
			plan_mode: snap.planMode ?? false,
			mcp_status: this.agent.toolset.mcpStatusSnapshot() ?? null,
		};
		if (usage) {
			statusPayload.context_usage = snap.contextUsage ?? null;
			statusPayload.context_tokens = snap.contextTokens ?? null;
			statusPayload.max_context_tokens = snap.maxContextTokens ?? null;
		}
		wireSend(wireMsg("StatusUpdate", statusPayload));

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
			wireSend(wireMsg("CompactionBegin"));
			try {
				const provider = llm.provider;
				const maxRetries = lc.max_retries_per_step;
				await withRetry(
					() =>
						this._runWithConnectionRecovery(
							"compaction",
							() => compactContext(this.context, llm),
							provider,
						),
					maxRetries,
					"compaction",
				);
			} catch (err) {
				logger.error(`Compaction failed: ${err}`);
			}
			wireSend(wireMsg("CompactionEnd"));
		}
	}

	// ── Slash command wiring ────────────────────────

	wireSlashCommands(): void {
		const registry = this.agent.slashCommands;

		// Helper: wrap a handler that returns string → wireSend(TextPart).
		// Matches Python where soul slash handlers use wire_send(TextPart(text=...)).
		const wrapTextHandler = (
			fn: (args: string) => Promise<string | void> | string | void,
		): ((args: string) => Promise<void>) => {
			return async (args: string) => {
				const result = await fn(args);
				if (typeof result === "string" && result) {
					wireSend(wireMsg("TextPart", { type: "text", text: result }));
				}
			};
		};

		// Wire /clear — soul-level handler clears context + wire file.
		// The shell-level /clear handler orchestrates: clearMessages() + soulClear() + triggerReload().
		const clearCmd = registry.get("clear");
		if (clearCmd) {
			clearCmd.handler = async () => {
				await this.context.clear();
				await this.context.writeSystemPrompt(this.agent.systemPrompt);
				// Truncate wire.jsonl so replay doesn't re-show old messages after reload.
				const wireFile = this.agent.runtime.session.wireFile;
				if (wireFile) {
					try {
						const { writeFile } = await import("node:fs/promises");
						await writeFile(wireFile, "");
					} catch {
						/* best-effort */
					}
				}
				logger.info("Context cleared");
				wireSend(
					wireMsg("TextPart", {
						type: "text",
						text: "The context has been cleared.",
					}),
				);
				this._sendStatusUpdate();
				// NOTE: Reload is raised by the shell-level /clear handler, not here.
				// This matches Python: soul handler clears context, shell handler raises Reload().
			};
		}

		// Wire /compact
		const compactCmd = registry.get("compact");
		if (compactCmd) {
			compactCmd.handler = async (args: string) => {
				if (this.context.nCheckpoints === 0) {
					wireSend(
						wireMsg("TextPart", {
							type: "text",
							text: "The context is empty.",
						}),
					);
					return;
				}
				const llm = this.agent.runtime.llm;
				if (!llm) return;
				logger.info("Running `/compact`");
				wireSend(wireMsg("CompactionBegin"));
				try {
					await compactContext(this.context, llm, this.agent, {
						focus: args || undefined,
					});
				} finally {
					wireSend(wireMsg("CompactionEnd"));
				}
				this._sendStatusUpdate();
				logger.info("Context has been compacted.");
				wireSend(
					wireMsg("TextPart", {
						type: "text",
						text: "The context has been compacted.",
					}),
				);
			};
		}

		// Wire /yolo
		const yoloCmd = registry.get("yolo");
		if (yoloCmd) {
			yoloCmd.handler = async () => {
				if (this.agent.runtime.approval.isYolo()) {
					this.agent.runtime.approval.setYolo(false);
					logger.info("YOLO mode: OFF");
					this._sendStatusUpdate();
					wireSend(
						wireMsg("TextPart", {
							type: "text",
							text: "You only die once! Actions will require approval.",
						}),
					);
				} else {
					this.agent.runtime.approval.setYolo(true);
					logger.info("YOLO mode: ON");
					this._sendStatusUpdate();
					wireSend(
						wireMsg("TextPart", {
							type: "text",
							text: "You only live once! All actions will be auto-approved.",
						}),
					);
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
					wireSend(
						wireMsg("TextPart", {
							type: "text",
							text: `Plan mode ON. Plan file: ${planPath}`,
						}),
					);
					wireSend(wireMsg("StatusUpdate", { plan_mode: this._planMode }));
				} else if (subcmd === "off") {
					if (this._planMode) await this.togglePlanModeFromManual();
					wireSend(
						wireMsg("TextPart", {
							type: "text",
							text: "Plan mode OFF. All tools are now available.",
						}),
					);
					wireSend(wireMsg("StatusUpdate", { plan_mode: this._planMode }));
				} else if (subcmd === "view") {
					const content = this.readCurrentPlan();
					wireSend(
						wireMsg("TextPart", {
							type: "text",
							text: content ?? "No plan file found for this session.",
						}),
					);
				} else if (subcmd === "clear") {
					this.clearCurrentPlan();
					wireSend(
						wireMsg("TextPart", { type: "text", text: "Plan cleared." }),
					);
				} else {
					// Default: toggle
					const newState = await this.togglePlanModeFromManual();
					if (newState) {
						const planPath = this.getPlanFilePath();
						wireSend(
							wireMsg("TextPart", {
								type: "text",
								text: `Plan mode ON. Write your plan to: ${planPath}\nUse ExitPlanMode when done, or /plan off to exit manually.`,
							}),
						);
					} else {
						wireSend(
							wireMsg("TextPart", {
								type: "text",
								text: "Plan mode OFF. All tools are now available.",
							}),
						);
					}
					wireSend(wireMsg("StatusUpdate", { plan_mode: this._planMode }));
				}
			};
		}

		// Wire /model
		const modelCmd = registry.get("model");
		if (modelCmd) {
			const notify = (t: string, b: string) => this.notify(t, b);
			const onReload = (sessionId: string, prefillText?: string) => {
				throw new Reload(sessionId, prefillText);
			};
			const configMeta = { isFromDefaultLocation: true, sourceFile: null };
			modelCmd.handler = async () => {
				await handleModel(this.agent.runtime.config, configMeta, notify);
			};
			modelCmd.panel = () =>
				createModelPanel(
					this.agent.runtime.config,
					configMeta,
					notify,
					this.agent.runtime.session.id,
					onReload,
				);
		}

		// Wire /export
		const exportCmd = registry.get("export");
		if (exportCmd) {
			exportCmd.handler = wrapTextHandler((args) =>
				handleExport(this.context, this.agent.runtime.session, args),
			);
		}

		// Wire /import
		const importCmd = registry.get("import");
		if (importCmd) {
			importCmd.handler = wrapTextHandler((args) =>
				handleImport(this.context, this.agent.runtime.session, args),
			);
		}

		// Wire /web
		const webCmd = registry.get("web");
		if (webCmd) {
			webCmd.handler = wrapTextHandler(() =>
				handleWeb(this.agent.runtime.session.id),
			);
		}

		// Wire /vis
		const visCmd = registry.get("vis");
		if (visCmd) {
			visCmd.handler = wrapTextHandler(() =>
				handleVis(this.agent.runtime.session.id),
			);
		}

		// Wire /reload — throw Reload to trigger config reload loop in cli/index.ts.
		// Matches Python: raise Reload(session_id=soul.runtime.session.id)
		const reloadCmd = registry.get("reload");
		if (reloadCmd) {
			reloadCmd.handler = async () => {
				const { Reload } = await import("../cli/errors.ts");
				throw new Reload(this.agent.runtime.session.id);
			};
		}

		// Wire /task
		const taskCmd = registry.get("task");
		if (taskCmd) {
			taskCmd.handler = wrapTextHandler(() => handleTask());
			taskCmd.panel = () => ({ type: "task" as const });
		}

		// Wire /login
		const loginCmd = registry.get("login");
		if (loginCmd) {
			const notify = (t: string, b: string) => this.notify(t, b);
			loginCmd.handler = async () => {
				await handleLogin(this.agent.runtime.config, notify);
			};
			loginCmd.panel = () =>
				createLoginPanel(this.agent.runtime.config, notify);
		}

		// Wire /logout
		const logoutCmd = registry.get("logout");
		if (logoutCmd) {
			logoutCmd.handler = async () => {
				await handleLogout(this.agent.runtime.config, (t, b) =>
					this.notify(t, b),
				);
			};
		}

		// Wire /usage
		const usageCmd = registry.get("usage");
		if (usageCmd) {
			usageCmd.handler = wrapTextHandler(() =>
				handleUsage(
					this.agent.runtime.config,
					this.agent.runtime.config.default_model || undefined,
				),
			);
		}

		// Wire /feedback
		const feedbackCmd = registry.get("feedback");
		if (feedbackCmd) {
			feedbackCmd.handler = wrapTextHandler((args) =>
				handleFeedback(
					this.agent.runtime.config,
					args,
					this.agent.runtime.session.id,
					this.agent.runtime.config.default_model || undefined,
				),
			);
			feedbackCmd.panel = () =>
				createFeedbackPanel(
					this.agent.runtime.config,
					this.agent.runtime.session.id,
					this.agent.runtime.config.default_model || undefined,
					(t, b) => this.notify(t, b),
				);
		}

		// Wire /editor
		const editorCmd = registry.get("editor");
		if (editorCmd) {
			const editorNotify = (t: string, b: string) => this.notify(t, b);
			const editorConfigMeta = {
				isFromDefaultLocation: true,
				sourceFile: null,
			};
			editorCmd.handler = wrapTextHandler((args) =>
				handleEditor(this.agent.runtime.config, editorConfigMeta, args),
			);
			editorCmd.panel = () =>
				createEditorPanel(
					this.agent.runtime.config,
					editorConfigMeta,
					editorNotify,
				);
		}

		// Wire /hooks
		const hooksCmd = registry.get("hooks");
		if (hooksCmd) {
			hooksCmd.handler = wrapTextHandler(() =>
				handleHooks(this.agent.runtime.hookEngine),
			);
			hooksCmd.panel = () => createHooksPanel(this.agent.runtime.hookEngine);
		}

		// Wire /mcp
		const mcpCmd = registry.get("mcp");
		if (mcpCmd) {
			mcpCmd.handler = wrapTextHandler(() =>
				handleMcp(
					this.agent.runtime.config,
					this.agent.toolset.mcpStatusSnapshot(),
				),
			);
			mcpCmd.panel = () =>
				createMcpPanel(
					this.agent.runtime.config,
					this.agent.toolset.mcpStatusSnapshot(),
				);
		}

		// Wire /debug
		const debugCmd = registry.get("debug");
		if (debugCmd) {
			debugCmd.handler = wrapTextHandler(() => handleDebug(this.context));
			debugCmd.panel = () => createDebugPanel(this.context);
		}

		// Wire /changelog
		const changelogCmd = registry.get("changelog");
		if (changelogCmd) {
			changelogCmd.handler = wrapTextHandler(() => handleChangelog());
			changelogCmd.panel = () => createChangelogPanel();
		}

		// Wire /new
		const newCmd = registry.get("new");
		if (newCmd) {
			newCmd.handler = wrapTextHandler(() =>
				handleNew(this.agent.runtime.session),
			);
		}

		// Wire /sessions
		const sessionsCmd = registry.get("sessions");
		if (sessionsCmd) {
			sessionsCmd.handler = wrapTextHandler(() =>
				handleSessions(this.agent.runtime.session),
			);
			sessionsCmd.panel = () =>
				createSessionsPanel(
					this.agent.runtime.session,
					(t, b) => this.notify(t, b),
					(id, prefill) => {
						throw new Reload(id, prefill);
					},
				);
		}

		// Wire /title
		const titleCmd = registry.get("title");
		if (titleCmd) {
			titleCmd.handler = wrapTextHandler((args) =>
				handleTitle(this.agent.runtime.session, args),
			);
			titleCmd.panel = () =>
				createTitlePanel(this.agent.runtime.session, (t, b) =>
					this.notify(t, b),
				);
		}

		// Wire /init — matches Python: creates a temp soul to analyze codebase & generate AGENTS.md
		const initCmd = registry.get("init");
		if (initCmd) {
			initCmd.handler = async () => {
				await handleInit(this.agent, this.context);
			};
		}

		// Wire /add-dir
		const addDirCmd = registry.get("add-dir");
		if (addDirCmd) {
			addDirCmd.handler = wrapTextHandler((args) =>
				handleAddDir(
					this.agent.runtime.session,
					this.agent.runtime.session.workDir,
					args,
				),
			);
		}
	}

	/** Wire tool context callbacks (plan mode, ask user, etc.) to the soul. */
	wireToolContext(): void {
		const ctx = this.agent.toolset.context;
		ctx.setPlanMode = (on: boolean) => this.setPlanMode(on);
		ctx.getPlanMode = () => this._planMode;
		ctx.getPlanFilePath = () => this.getPlanFilePath() ?? undefined;
		ctx.togglePlanMode = () => this.togglePlanMode();

		// Wire ctx.askUser to use QuestionRequest through Wire (matches Python pattern).
		// This makes EnterPlanMode, ExitPlanMode, and any tool using ctx.askUser
		// show the QuestionPanel to the user.
		ctx.askUser = async (
			question: string,
			options?: string[],
		): Promise<string> => {
			const { randomUUID } = await import("node:crypto");
			const { PendingQuestionRequest } = await import("../wire/types.ts");
			const { registerPendingQuestion } = await import(
				"../tools/ask_user/index.ts"
			);
			const { getCurrentToolCallOrNull } = await import("./toolset.ts");

			const wire = getWireOrNull();
			if (!wire) throw new Error("Wire not available");

			const toolCall = getCurrentToolCallOrNull();
			const requestData = {
				id: randomUUID(),
				tool_call_id: toolCall?.id ?? "",
				questions: [
					{
						question,
						header: "",
						options: (options ?? []).map((label) => ({
							label,
							description: "",
						})),
						multi_select: false,
						body: "",
						other_label: "",
						other_description: "",
					},
				],
			};
			const pending = new PendingQuestionRequest(requestData);
			registerPendingQuestion(requestData.id, pending);

			wireSend(wireMsg("QuestionRequest", requestData));

			const answers = await pending.wait();
			return answers[question] ?? "";
		};
	}
}

// ── FlowRunner ─────────────────────────────────────

import type { Flow, FlowNode, FlowEdge } from "../skill/flow/index.ts";
import { parseChoice } from "../skill/flow/index.ts";

const DEFAULT_MAX_FLOW_MOVES = 1000;
const SKILL_COMMAND_PREFIX = "skill:";
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
	static ralphLoop(promptText: string, maxRalphIterations: number): FlowRunner {
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

	private static _buildFlowPrompt(node: FlowNode, edges: FlowEdge[]): string {
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
		// Send wire events for flow turn (matches Python FlowRunner._flow_turn)
		wireSend(
			wireMsg("TurnBegin", { user_input: prompt }),
		);
		const stepsBefore = soul["_stepCount"];
		await soul["_turn"](prompt);
		const stepsAfter = soul["_stepCount"];
		wireSend(wireMsg("TurnEnd"));

		// Extract final assistant text from context
		const history = soul["context"].history;
		const lastMsg =
			history.length > 0 ? history[history.length - 1] : undefined;
		let finalText: string | undefined;
		if (lastMsg?.role === "assistant") {
			finalText =
				typeof lastMsg.content === "string"
					? lastMsg.content
					: Array.isArray(lastMsg.content)
						? lastMsg.content
								.filter(
									(p: any): p is { type: "text"; text: string } =>
										"type" in p && p.type === "text",
								)
								.map((p: any) => p.text)
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
