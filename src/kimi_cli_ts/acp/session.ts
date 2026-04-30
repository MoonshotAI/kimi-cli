/**
 * ACP session — corresponds to Python acp/session.py
 * Manages ACP session state, prompt execution, and wire message routing.
 */

import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

import {
	acpBlocksToContentParts,
	displayBlockToAcpContent,
	toolResultToAcpContent,
} from "./convert.ts";
import type { ACPClient } from "./kaos.ts";
import type { ACPKaos } from "./kaos.ts";
import type {
	ACPContentBlock,
	AgentMessageChunk,
	AgentThoughtChunk,
	ToolCallStart,
	ToolCallProgress,
	ContentToolCallContent,
	FileEditToolCallContent,
	TerminalToolCallContent,
	AgentPlanUpdate,
	PlanEntry,
	PermissionOption,
	ToolCallUpdate,
	PromptResponse,
	TextContentBlock,
} from "./types.ts";
import { ACPRequestError } from "./types.ts";
import type { KimiCLI } from "../app.ts";
import {
	LLMNotSet,
	LLMNotSupported,
	MaxStepsReached,
	RunCancelled,
	runSoul,
} from "../soul/index.ts";
import type { Wire } from "../wire/wire_core.ts";
import { QueueShutDown } from "../utils/queue.ts";
import { extractKeyArgument } from "../tools/types.ts";
import { getCurrentToolCallOrNull } from "../soul/toolset.ts";
import { logger } from "../utils/logging.ts";
import type {
	ToolResult,
	Notification,
	TodoDisplayBlock,
	TodoDisplayItem,
	DisplayBlock,
	DiffDisplayBlock,
} from "../wire/types.ts";
import type { ContentPart } from "../types.ts";

// ── Context variables ─────────────────────────────────────

const _currentTurnId = new AsyncLocalStorage<string | null>();
const _terminalToolCallIds = new AsyncLocalStorage<Set<string> | null>();

export function getCurrentAcpToolCallIdOrNull(): string | null {
	const turnId = _currentTurnId.getStore() ?? null;
	if (turnId === null) return null;
	const toolCall = getCurrentToolCallOrNull();
	if (toolCall === null) return null;
	return `${turnId}/${toolCall.id}`;
}

export function registerTerminalToolCallId(toolCallId: string): void {
	const calls = _terminalToolCallIds.getStore() ?? null;
	if (calls !== null) {
		calls.add(toolCallId);
	}
}

export function shouldHideTerminalOutput(toolCallId: string): boolean {
	const calls = _terminalToolCallIds.getStore() ?? null;
	return calls !== null && calls.has(toolCallId);
}

// ── _ToolCallState ────────────────────────────────────────

class _ToolCallState {
	readonly toolCall: {
		id: string;
		function: { name: string; arguments: string | null };
	};
	args: string;

	constructor(toolCall: {
		id: string;
		function: { name: string; arguments: string | null };
	}) {
		this.toolCall = toolCall;
		this.args = toolCall.function.arguments || "";
	}

	get acpToolCallId(): string {
		const turnId = _currentTurnId.getStore() ?? null;
		if (turnId === null) throw new Error("Turn ID not set");
		return `${turnId}/${this.toolCall.id}`;
	}

	appendArgsPart(argsPart: string): void {
		this.args += argsPart;
	}

	getTitle(): string {
		const toolName = this.toolCall.function.name;
		const subtitle = extractKeyArgument(this.args, toolName);
		if (subtitle) {
			return `${toolName}: ${subtitle}`;
		}
		return toolName;
	}
}

// ── _TurnState ────────────────────────────────────────────

class _TurnState {
	readonly id: string;
	readonly toolCalls = new Map<string, _ToolCallState>();
	lastToolCall: _ToolCallState | null = null;
	private _cancelController = new AbortController();

	constructor() {
		this.id = randomUUID();
	}

	get cancelSignal(): AbortSignal {
		return this._cancelController.signal;
	}

	cancel(): void {
		this._cancelController.abort();
	}
}

// ── ACPSession ────────────────────────────────────────────

export class ACPSession {
	private _id: string;
	private _cli: KimiCLI;
	private _conn: ACPClient;
	private _kaos: ACPKaos | null;
	private _turnState: _TurnState | null = null;

	constructor(
		id: string,
		cli: KimiCLI,
		acpConn: ACPClient,
		kaos: ACPKaos | null = null,
	) {
		this._id = id;
		this._cli = cli;
		this._conn = acpConn;
		this._kaos = kaos;
	}

	get id(): string {
		return this._id;
	}

	get cli(): KimiCLI {
		return this._cli;
	}

	private _isOAuthSession(): boolean {
		try {
			const llm = this._cli.soul.runtime?.llm;
			return llm !== null && llm !== undefined && (llm as any).oauth != null;
		} catch {
			return false;
		}
	}

	async prompt(prompt: ACPContentBlock[]): Promise<PromptResponse> {
		const userInput = acpBlocksToContentParts(prompt);
		this._turnState = new _TurnState();

		return await _currentTurnId.run(this._turnState.id, async () => {
			return await _terminalToolCallIds.run(new Set(), async () => {
				try {
					const cancelController = new AbortController();
					const turnState = this._turnState!;

					// Connect cancel
					const onCancel = () => cancelController.abort();
					turnState.cancelSignal.addEventListener("abort", onCancel, {
						once: true,
					});

					await runSoul(
						this._cli.soul,
						userInput as string | ContentPart[],
						async (wire: Wire) => {
							// Process wire messages from the soul's actual Wire
							const uiSide = wire.uiSide(true); // merged messages
							while (true) {
								let msg: any;
								try {
									msg = await uiSide.receive();
								} catch (e) {
									if (e instanceof QueueShutDown) break;
									throw e;
								}
								await this._handleWireMessage(msg);
							}
						},
						cancelController,
					);

					return { stop_reason: "end_turn" as const };
				} catch (e) {
					if (e instanceof LLMNotSet) {
						logger.error(`LLM not set: ${e}`);
						throw ACPRequestError.authRequired();
					}
					if (e instanceof LLMNotSupported) {
						logger.error(`LLM not supported: ${e}`);
						throw ACPRequestError.internalError({ error: String(e) });
					}
					if (e instanceof MaxStepsReached) {
						logger.warn(`Max steps reached: ${(e as MaxStepsReached).nSteps}`);
						return { stop_reason: "max_turn_requests" as const };
					}
					if (e instanceof RunCancelled) {
						logger.info("Prompt cancelled by user");
						return { stop_reason: "cancelled" as const };
					}
					// Check for API status errors (401 for OAuth sessions)
					if ((e as any)?.status === 401 && this._isOAuthSession()) {
						logger.warn("Authentication failed (401), prompting re-login");
						throw ACPRequestError.authRequired();
					}
					logger.error(`Unexpected error during prompt: ${e}`);
					throw ACPRequestError.internalError({ error: String(e) });
				} finally {
					this._turnState = null;
				}
			});
		});
	}

	async cancel(): Promise<void> {
		if (this._turnState === null) {
			logger.warn("Cancel requested but no prompt is running");
			return;
		}
		this._turnState.cancel();
	}

	// ── Wire message handler ──────────────────────────────

	private async _handleWireMessage(msg: any): Promise<void> {
		// Determine message type from __wireType tag or by shape
		const wireType = msg.__wireType as string | undefined;

		switch (wireType) {
			case "ThinkPart":
				await this._sendThinking(msg.text);
				break;
			case "TextPart":
				await this._sendText(msg.text);
				break;
			case "ToolCall":
				await this._sendToolCall(msg);
				break;
			case "ToolCallPart":
				await this._sendToolCallPart(msg);
				break;
			case "ToolResult":
				await this._sendToolResult(msg);
				break;
			case "Notification":
				await this._sendNotification(msg);
				break;
			case "ApprovalRequest":
				await this._handleApprovalRequest(msg);
				break;
			case "StepInterrupted":
				// Stop processing
				break;
			case "QuestionRequest":
				logger.warn(
					"QuestionRequest is unsupported in ACP session; resolving empty answer.",
				);
				if (msg.resolve) msg.resolve({});
				break;
			case "TurnBegin":
			case "TurnEnd":
			case "SteerInput":
			case "StepBegin":
			case "CompactionBegin":
			case "CompactionEnd":
			case "MCPLoadingBegin":
			case "MCPLoadingEnd":
			case "StatusUpdate":
			case "ApprovalResponse":
			case "SubagentEvent":
			case "PlanDisplay":
			case "ToolCallRequest":
				// Ignored in ACP session
				break;
			default:
				// Try to detect message type by shape
				if (msg.text !== undefined && msg.type === "think") {
					await this._sendThinking(msg.text);
				} else if (msg.text !== undefined && msg.type === "text") {
					await this._sendText(msg.text);
				}
				break;
		}
	}

	// ── Send methods ──────────────────────────────────────

	private async _sendThinking(think: string): Promise<void> {
		if (!this._id || !this._conn) return;

		const update: AgentThoughtChunk = {
			session_update: "agent_thought_chunk",
			content: { type: "text", text: think },
		};
		await this._conn.sessionUpdate({
			sessionId: this._id,
			update,
		});
	}

	private async _sendText(text: string): Promise<void> {
		if (!this._id || !this._conn) return;

		const update: AgentMessageChunk = {
			session_update: "agent_message_chunk",
			content: { type: "text", text },
		};
		await this._conn.sessionUpdate({
			sessionId: this._id,
			update,
		});
	}

	private async _sendNotification(notification: {
		title: string;
		body: string;
	}): Promise<void> {
		const body = notification.body.trim();
		let text = `[Notification] ${notification.title}`;
		if (body) {
			text = `${text}\n${body}`;
		}
		await this._sendText(text);
	}

	private async _sendToolCall(toolCall: {
		id: string;
		function: { name: string; arguments: string | null };
	}): Promise<void> {
		if (!this._turnState || !this._id || !this._conn) return;

		const state = new _ToolCallState(toolCall);
		this._turnState.toolCalls.set(toolCall.id, state);
		this._turnState.lastToolCall = state;

		const update: ToolCallStart = {
			session_update: "tool_call",
			tool_call_id: state.acpToolCallId,
			title: state.getTitle(),
			status: "in_progress",
			content: [
				{
					type: "content",
					content: { type: "text", text: state.args },
				} as ContentToolCallContent,
			],
		};
		await this._conn.sessionUpdate({
			sessionId: this._id,
			update,
		});
		logger.debug(`Sent tool call: ${toolCall.function.name}`);
	}

	private async _sendToolCallPart(part: {
		arguments_part?: string;
	}): Promise<void> {
		if (
			!this._turnState ||
			!this._id ||
			!this._conn ||
			!part.arguments_part ||
			!this._turnState.lastToolCall
		) {
			return;
		}

		this._turnState.lastToolCall.appendArgsPart(part.arguments_part);

		const update: ToolCallProgress = {
			session_update: "tool_call_update",
			tool_call_id: this._turnState.lastToolCall.acpToolCallId,
			title: this._turnState.lastToolCall.getTitle(),
			status: "in_progress",
			content: [
				{
					type: "content",
					content: { type: "text", text: this._turnState.lastToolCall.args },
				} as ContentToolCallContent,
			],
		};
		await this._conn.sessionUpdate({
			sessionId: this._id,
			update,
		});
		logger.debug(`Sent tool call update: ${part.arguments_part?.slice(0, 50)}`);
	}

	private async _sendToolResult(result: {
		tool_call_id: string;
		return_value: {
			is_error?: boolean;
			output?: string;
			message?: string;
			display?: unknown[];
		};
	}): Promise<void> {
		if (!this._turnState || !this._id || !this._conn) return;

		const toolRet = result.return_value;
		const state = this._turnState.toolCalls.get(result.tool_call_id);
		if (!state) {
			logger.warn(`Tool call not found: ${result.tool_call_id}`);
			return;
		}
		this._turnState.toolCalls.delete(result.tool_call_id);

		const hide = shouldHideTerminalOutput(state.acpToolCallId);
		const contents = toolResultToAcpContent(toolRet as any, hide);

		const update: ToolCallProgress = {
			session_update: "tool_call_update",
			tool_call_id: state.acpToolCallId,
			status: toolRet.is_error ? "failed" : "completed",
		};
		if (contents.length > 0) {
			update.content = contents;
		}

		await this._conn.sessionUpdate({
			sessionId: this._id,
			update,
		});
		logger.debug(`Sent tool result: ${result.tool_call_id}`);

		// Send plan updates for todo display blocks
		if (toolRet.display) {
			for (const block of toolRet.display) {
				if ((block as any)?.type === "todo") {
					await this._sendPlanUpdate(block as TodoDisplayBlock);
				}
			}
		}
	}

	private async _handleApprovalRequest(request: any): Promise<void> {
		if (!this._turnState || !this._id || !this._conn) {
			logger.warn("No session ID, auto-rejecting approval request");
			if (request.resolve) request.resolve("reject");
			return;
		}

		const state = this._turnState.toolCalls.get(
			request.data?.tool_call_id ?? request.tool_call_id,
		);
		if (!state) {
			logger.warn(
				`Tool call not found for approval: ${request.data?.tool_call_id ?? request.tool_call_id}`,
			);
			if (request.resolve) request.resolve("reject");
			return;
		}

		try {
			let content: (
				| ContentToolCallContent
				| FileEditToolCallContent
				| TerminalToolCallContent
			)[] = [];
			const display = request.data?.display ?? request.display ?? [];
			if (display.length > 0) {
				for (const block of display) {
					const diffContent = displayBlockToAcpContent(block);
					if (diffContent !== null) {
						content.push(diffContent);
					}
				}
			}
			if (content.length === 0) {
				const description =
					request.data?.description ?? request.description ?? "unknown action";
				content.push({
					type: "content",
					content: {
						type: "text",
						text: `Requesting approval to perform: ${description}`,
					},
				} as ContentToolCallContent);
			}

			const action = request.data?.action ?? request.action ?? "unknown";
			logger.debug(`Requesting permission for action: ${action}`);

			const options: PermissionOption[] = [
				{ option_id: "approve", name: "Approve once", kind: "allow_once" },
				{
					option_id: "approve_for_session",
					name: "Approve for this session",
					kind: "allow_always",
				},
				{ option_id: "reject", name: "Reject", kind: "reject_once" },
			];

			const toolCallUpdate: ToolCallUpdate = {
				tool_call_id: state.acpToolCallId,
				title: state.getTitle(),
				content,
			};

			const response = await this._conn.requestPermission(
				options,
				this._id,
				toolCallUpdate,
			);

			const outcome = (response as any)?.outcome;
			if (outcome?.type === "allowed") {
				const optionId = outcome.option_id;
				if (optionId === "approve") {
					logger.debug(`Permission granted for: ${action}`);
					request.resolve("approve");
				} else if (optionId === "approve_for_session") {
					logger.debug(`Permission granted for session: ${action}`);
					request.resolve("approve_for_session");
				} else {
					logger.debug(`Permission denied for: ${action}`);
					request.resolve("reject");
				}
			} else {
				logger.debug(`Permission request cancelled for: ${action}`);
				request.resolve("reject");
			}
		} catch (e) {
			logger.error(`Error handling approval request: ${e}`);
			request.resolve("reject");
		}
	}

	private async _sendPlanUpdate(block: TodoDisplayBlock): Promise<void> {
		const statusMap: Record<string, "pending" | "in_progress" | "completed"> = {
			pending: "pending",
			"in progress": "in_progress",
			in_progress: "in_progress",
			done: "completed",
			completed: "completed",
		};

		const entries: PlanEntry[] = [];
		for (const todo of block.items) {
			if (todo.title) {
				entries.push({
					content: todo.title,
					priority: "medium",
					status: statusMap[todo.status.toLowerCase()] ?? "pending",
				});
			}
		}

		if (entries.length === 0) {
			logger.warn("No valid todo items to send in plan update");
			return;
		}

		const update: AgentPlanUpdate = {
			session_update: "plan",
			entries,
		};
		await this._conn.sessionUpdate({
			sessionId: this._id,
			update,
		});
	}
}
