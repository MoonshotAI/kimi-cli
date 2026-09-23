/**
 * Wire server — stdio JSON-RPC server.
 * Corresponds to Python's wire/server.py (~1030 lines)
 */

import { WIRE_PROTOCOL_VERSION } from "./protocol.ts";
import { NAME, VERSION } from "../constant.ts";
import { AsyncQueue, QueueShutDown } from "../utils/queue.ts";
import { Wire, WireUISide } from "./wire_core.ts";
import { WireFile } from "./file.ts";
import {
	type ApprovalRequest,
	type ApprovalResponse,
	type HookRequest,
	type HookResponse,
	type QuestionRequest,
	type QuestionResponse,
	type ToolCallRequest,
	type WireMessage,
	type Request,
	isEventTypeName,
	isRequestTypeName,
	ApprovalResponseKind,
	QuestionNotSupported,
	Deferred,
	PendingApprovalRequest,
	PendingQuestionRequest,
	PendingToolCallRequest,
	PendingHookRequest,
	type PendingRequest,
} from "./types.ts";
import {
	ErrorCodes,
	Statuses,
	JSONRPCMessage,
	JSONRPCErrorObject,
	type JSONRPCSuccessResponse,
	type JSONRPCErrorResponse,
	type JSONRPCErrorResponseNullableID,
	type JSONRPCEventMessage,
	type JSONRPCRequestMessage,
	type JSONRPCOutMessage,
	type JSONRPCInMessage,
	type JSONRPCInitializeMessage,
	type JSONRPCPromptMessage,
	type JSONRPCSteerMessage,
	type JSONRPCReplayMessage,
	type JSONRPCSetPlanModeMessage,
	type JSONRPCCancelMessage,
	type ClientInfo,
	methodIsInbound,
	isResponse,
	parseInboundMessage,
	createEventMessage,
	createRequestMessage,
	JSONRPC_IN_METHODS,
} from "./jsonrpc.ts";
import { serializeWireMessage, deserializeWireMessage } from "./serde.ts";
import { RootWireHub } from "./root_hub.ts";
import { MaxStepsReached, RunCancelled } from "../soul/index.ts";
import type { ApprovalRuntime } from "../approval_runtime/runtime.ts";
import {
	resolveQuestionRequest,
	rejectQuestionRequest,
} from "../tools/ask_user/index.ts";

// Maximum buffer size for stdio reader
const STDIO_BUFFER_LIMIT = 100 * 1024 * 1024;

export interface WireServerOptions {
	/** Buffer limit for stdin reader (bytes). Default: 100MB */
	stdioBufferLimit?: number;
}

/**
 * Wire server that communicates over stdio using JSON-RPC.
 * Full implementation corresponding to Python's WireServer.
 */
export class WireServer {
	private _options: Required<WireServerOptions>;

	// I/O
	private _writeQueue: AsyncQueue<JSONRPCOutMessage> = new AsyncQueue();
	private _writeLoopRunning = false;

	// State
	private _initialized = false;
	private _cancelEvent: Deferred<void> | null = null;
	private _pendingRequests = new Map<string, PendingRequest>();
	private _clientSupportsQuestion = false;
	private _clientSupportsPlanMode = false;
	private _dispatchPromises: Set<Promise<void>> = new Set();

	// Root hub
	private _rootHub: RootWireHub | null = null;
	private _rootHubQueue: AsyncQueue<WireMessage> | null = null;
	private _rootHubAbort: AbortController | null = null;

	// Approval runtime (for routing approval responses back)
	private _approvalRuntime: ApprovalRuntime | null = null;

	// Soul interface (abstracted for decoupling)
	private _soul: WireServerSoul | null = null;

	constructor(options: WireServerOptions = {}) {
		this._options = {
			stdioBufferLimit: options.stdioBufferLimit ?? STDIO_BUFFER_LIMIT,
		};
	}

	get protocolVersion(): string {
		return WIRE_PROTOCOL_VERSION;
	}

	get isStreaming(): boolean {
		return this._cancelEvent !== null;
	}

	/**
	 * Attach a soul interface for handling prompts, steers, etc.
	 */
	setSoul(soul: WireServerSoul): void {
		this._soul = soul;
	}

	/**
	 * Attach a root wire hub for out-of-turn messages.
	 */
	setRootHub(hub: RootWireHub): void {
		this._rootHub = hub;
	}

	/**
	 * Attach an approval runtime for routing approval responses back.
	 */
	setApprovalRuntime(runtime: ApprovalRuntime): void {
		this._approvalRuntime = runtime;
	}

	/**
	 * Start the Wire server. Reads from stdin, writes to stdout.
	 */
	async serve(): Promise<void> {
		console.error("[Wire] Starting Wire server on stdio");

		// Start write loop
		const writePromise = this._writeLoop();
		this._writeLoopRunning = true;

		// Subscribe to root hub if available
		if (this._rootHub) {
			this._rootHubQueue = this._rootHub.subscribe();
			this._rootHubAbort = new AbortController();
			this._rootHubLoop();
		}

		try {
			await this._readLoop();
		} catch (err) {
			if (err instanceof Error && err.message.includes("interrupted")) {
				console.error("[Wire] Wire server interrupted, shutting down");
				if (this._cancelEvent) {
					this._cancelEvent.resolve();
				}
			} else {
				throw err;
			}
		} finally {
			await this._shutdown();
			this._writeLoopRunning = false;
		}
	}

	// ── Root Hub Loop ──────────────────────────────────────────

	private async _rootHubLoop(): Promise<void> {
		if (!this._rootHubQueue) return;

		while (true) {
			try {
				const msg = await this._rootHubQueue.get();
				if (!this._initialized) continue;

				const msgObj = msg as Record<string, unknown>;
				const wireType = msgObj.__wireType as string | undefined;

				if (wireType === "ApprovalResponse" || ("request_id" in msgObj && "response" in msgObj)) {
					// ApprovalResponse event
					const requestId = msgObj.request_id as string;
					this._pendingRequests.delete(requestId);
					await this._sendMsg(createEventMessage(msg));
				} else if (wireType === "ApprovalRequest" || ("id" in msgObj && "tool_call_id" in msgObj && "sender" in msgObj)) {
					// ApprovalRequest — register pending request and forward to client
					const pending = new PendingApprovalRequest(msg as ApprovalRequest);
					this._pendingRequests.set(msgObj.id as string, pending);
					await this._sendMsg(
						createRequestMessage(msgObj.id as string, msg as Request),
					);
				} else {
					// Generic event
					await this._sendMsg(createEventMessage(msg));
				}
			} catch (e) {
				if (e instanceof QueueShutDown) return;
				console.error("[Wire] Root hub message handling failed:", e);
			}
		}
	}

	// ── Write Loop ─────────────────────────────────────────────

	private async _writeLoop(): Promise<void> {
		try {
			while (true) {
				let msg: JSONRPCOutMessage;
				try {
					msg = await this._writeQueue.get();
				} catch (e) {
					if (e instanceof QueueShutDown) break;
					throw e;
				}

				const json = JSON.stringify(msg) + "\n";
				const bytes = new TextEncoder().encode(json);
				await Bun.write(Bun.stdout, bytes);
			}
		} catch (err) {
			if (err instanceof QueueShutDown) return;
			console.error("[Wire] Write loop error:", err);
			throw err;
		}
	}

	// ── Read Loop ──────────────────────────────────────────────

	private async _readLoop(): Promise<void> {
		const decoder = new TextDecoder();
		let buffer = "";

		for await (const chunk of Bun.stdin.stream()) {
			buffer += decoder.decode(chunk, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop()!; // Keep incomplete line in buffer

			for (const rawLine of lines) {
				const line = rawLine.trim();
				if (!line) continue;

				// Parse JSON
				let msgJson: unknown;
				try {
					msgJson = JSON.parse(line);
				} catch {
					console.error("[Wire] Invalid JSON line:", line);
					await this._sendMsg({
						jsonrpc: "2.0",
						id: null,
						error: {
							code: ErrorCodes.PARSE_ERROR,
							message: "Invalid JSON format",
						},
					} as JSONRPCErrorResponseNullableID);
					continue;
				}

				// Validate generic JSON-RPC structure
				const genericResult = JSONRPCMessage.safeParse(msgJson);
				if (!genericResult.success) {
					console.error(
						"[Wire] Invalid JSON-RPC message:",
						genericResult.error,
					);
					await this._sendMsg({
						jsonrpc: "2.0",
						id: null,
						error: {
							code: ErrorCodes.INVALID_REQUEST,
							message: "Invalid request",
						},
					} as JSONRPCErrorResponseNullableID);
					continue;
				}

				const genericMsg = genericResult.data;

				// Handle responses
				if (isResponse(genericMsg)) {
					try {
						const msg = parseInboundMessage(msgJson);
						const p = this._dispatchMsg(msg);
						this._dispatchPromises.add(p);
						p.finally(() => this._dispatchPromises.delete(p));
					} catch (err) {
						console.error("[Wire] Invalid JSON-RPC response:", err);
					}
					continue;
				}

				// Check method
				if (!methodIsInbound(genericMsg)) {
					console.error(
						"[Wire] Unexpected JSON-RPC method received:",
						genericMsg.method,
					);
					if (genericMsg.id != null) {
						await this._sendMsg({
							jsonrpc: "2.0",
							id: genericMsg.id,
							error: {
								code: ErrorCodes.METHOD_NOT_FOUND,
								message: `Unexpected method received: ${genericMsg.method}`,
							},
						} as JSONRPCErrorResponse);
					}
					continue;
				}

				// Parse typed inbound message
				try {
					const msg = parseInboundMessage(msgJson);
					const p = this._dispatchMsg(msg);
					this._dispatchPromises.add(p);
					p.finally(() => this._dispatchPromises.delete(p));
				} catch (err) {
					console.error("[Wire] Invalid JSON-RPC inbound message:", err);
					if (genericMsg.id != null) {
						await this._sendMsg({
							jsonrpc: "2.0",
							id: genericMsg.id,
							error: {
								code: ErrorCodes.INVALID_PARAMS,
								message: `Invalid parameters for method \`${genericMsg.method}\``,
							},
						} as JSONRPCErrorResponse);
					}
				}
			}
		}

		console.error("[Wire] stdin closed, Wire server exiting");
	}

	// ── Shutdown ───────────────────────────────────────────────

	private async _shutdown(): Promise<void> {
		// Resolve pending requests
		for (const [, request] of this._pendingRequests) {
			if (request.resolved) continue;
			if (request instanceof PendingApprovalRequest) {
				if (request.data.source_kind === "foreground_turn") {
					request.resolve("reject");
				}
			} else if (request instanceof PendingToolCallRequest) {
				request.resolve({
					isError: true,
					output: "Wire connection closed before tool result was received.",
					message: "Wire closed",
				});
			} else if (request instanceof PendingQuestionRequest) {
				request.resolve({});
			} else if (request instanceof PendingHookRequest) {
				request.resolve("allow");
			}
		}
		this._pendingRequests.clear();

		if (this._cancelEvent) {
			this._cancelEvent.resolve();
			this._cancelEvent = null;
		}

		this._writeQueue.shutdown();

		// Unsubscribe from root hub
		if (this._rootHubAbort) {
			this._rootHubAbort.abort();
			this._rootHubAbort = null;
		}
		if (this._rootHub && this._rootHubQueue) {
			this._rootHub.unsubscribe(this._rootHubQueue);
			this._rootHubQueue = null;
		}

		// Wait for dispatch tasks
		await Promise.allSettled([...this._dispatchPromises]);
		this._dispatchPromises.clear();

		this._initialized = false;
	}

	// ── Dispatch ───────────────────────────────────────────────

	private async _dispatchMsg(msg: JSONRPCInMessage): Promise<void> {
		let resp: JSONRPCSuccessResponse | JSONRPCErrorResponse | null = null;

		try {
			const obj = msg as Record<string, unknown>;

			// Discriminate by method
			if ("method" in obj) {
				switch (obj.method) {
					case "initialize":
						resp = await this._handleInitialize(
							msg as JSONRPCInitializeMessage,
						);
						break;
					case "prompt":
						resp = await this._handlePrompt(msg as JSONRPCPromptMessage);
						break;
					case "replay":
						resp = await this._handleReplay(msg as JSONRPCReplayMessage);
						break;
					case "steer":
						resp = await this._handleSteer(msg as JSONRPCSteerMessage);
						break;
					case "set_plan_mode":
						resp = await this._handleSetPlanMode(
							msg as JSONRPCSetPlanModeMessage,
						);
						break;
					case "cancel":
						resp = await this._handleCancel(msg as JSONRPCCancelMessage);
						break;
					default:
						break;
				}
			} else {
				// Response message (success or error)
				await this._handleResponse(
					msg as JSONRPCSuccessResponse | JSONRPCErrorResponse,
				);
			}

			if (resp) {
				await this._sendMsg(resp);
			}
		} catch (err) {
			console.error(
				"[Wire] Unexpected error dispatching JSONRPC message:",
				err,
			);
			throw err;
		}
	}

	// ── Send ───────────────────────────────────────────────────

	private async _sendMsg(msg: JSONRPCOutMessage): Promise<void> {
		try {
			this._writeQueue.put(msg);
		} catch (e) {
			if (e instanceof QueueShutDown) {
				console.error("[Wire] Send queue shut down; dropping message");
			} else {
				throw e;
			}
		}
	}

	// ── Handle Initialize ──────────────────────────────────────

	private async _handleInitialize(
		msg: JSONRPCInitializeMessage,
	): Promise<JSONRPCSuccessResponse | JSONRPCErrorResponse> {
		if (this.isStreaming) {
			return {
				jsonrpc: "2.0",
				id: msg.id,
				error: {
					code: ErrorCodes.INVALID_STATE,
					message: "An agent turn is already in progress",
				},
			};
		}

		const result: Record<string, unknown> = {
			protocol_version: WIRE_PROTOCOL_VERSION,
			server: { name: NAME, version: VERSION },
			slash_commands: [],
		};

		// Process capabilities
		if (msg.params.capabilities) {
			this._clientSupportsQuestion =
				msg.params.capabilities.supports_question ?? false;
			this._clientSupportsPlanMode =
				msg.params.capabilities.supports_plan_mode ?? false;
		}

		// Notify soul of initialization if available
		if (this._soul) {
			const soulResult = await this._soul.onInitialize(msg.params);
			Object.assign(result, soulResult);
		}

		result.capabilities = { supports_question: true };

		this._initialized = true;

		return {
			jsonrpc: "2.0",
			id: msg.id,
			result,
		};
	}

	// ── Handle Prompt ──────────────────────────────────────────

	private async _handlePrompt(
		msg: JSONRPCPromptMessage,
	): Promise<JSONRPCSuccessResponse | JSONRPCErrorResponse> {
		if (this.isStreaming) {
			return {
				jsonrpc: "2.0",
				id: msg.id,
				error: {
					code: ErrorCodes.INVALID_STATE,
					message: "An agent turn is already in progress",
				},
			};
		}

		this._cancelEvent = new Deferred<void>();

		try {
			if (!this._soul) {
				return {
					jsonrpc: "2.0",
					id: msg.id,
					error: {
						code: ErrorCodes.LLM_NOT_SET,
						message: "Soul is not configured",
					},
				};
			}

			const status = await this._soul.onPrompt(
				msg.params.user_input,
				(wire: Wire) => this._streamWireMessages(wire),
				this._cancelEvent,
			);

			return {
				jsonrpc: "2.0",
				id: msg.id,
				result: { status },
			};
		} catch (err: unknown) {
			if (err instanceof MaxStepsReached) {
				return {
					jsonrpc: "2.0",
					id: msg.id,
					result: { status: Statuses.MAX_STEPS_REACHED, steps: err.nSteps },
				};
			}
			if (err instanceof RunCancelled) {
				return {
					jsonrpc: "2.0",
					id: msg.id,
					result: { status: Statuses.CANCELLED },
				};
			}
			const error = err as Error & { code?: string };
			const errCode = this._mapErrorCode(error);
			return {
				jsonrpc: "2.0",
				id: msg.id,
				error: {
					code: errCode,
					message: error.message || "Unknown error",
				},
			};
		} finally {
			// Clean up stale pending requests
			for (const [msgId, request] of this._pendingRequests) {
				if (request.resolved) continue;
				if (request instanceof PendingApprovalRequest) {
					if (request.data.source_kind === "foreground_turn") {
						this._pendingRequests.delete(msgId);
						request.resolve("reject");
					}
				} else if (request instanceof PendingToolCallRequest) {
					this._pendingRequests.delete(msgId);
					request.resolve({
						isError: true,
						output: "Agent turn ended before tool result was received.",
						message: "Turn ended",
					});
				} else if (request instanceof PendingQuestionRequest) {
					this._pendingRequests.delete(msgId);
					request.resolve({});
				} else if (request instanceof PendingHookRequest) {
					this._pendingRequests.delete(msgId);
					request.resolve("allow");
				}
			}
			this._cancelEvent = null;
		}
	}

	private _mapErrorCode(err: Error & { code?: string }): number {
		// Match by class name — use both name and name-includes to catch
		// subclasses (APITimeoutError, APIConnectionError, etc.)
		switch (err.name) {
			case "LLMNotSet":
				return ErrorCodes.LLM_NOT_SET;
			case "LLMNotSupported":
				return ErrorCodes.LLM_NOT_SUPPORTED;
			case "ChatProviderError":
			case "APITimeoutError":
			case "APIConnectionError":
			case "APIStatusError":
			case "APIEmptyResponseError":
				return ErrorCodes.CHAT_PROVIDER_ERROR;
			case "AuthExpiredError":
				return ErrorCodes.AUTH_EXPIRED;
			default:
				break;
		}
		// Fallback: match by code string
		switch (err.code) {
			case "LLM_NOT_SET":
				return ErrorCodes.LLM_NOT_SET;
			case "LLM_NOT_SUPPORTED":
				return ErrorCodes.LLM_NOT_SUPPORTED;
			case "CHAT_PROVIDER_ERROR":
				return ErrorCodes.CHAT_PROVIDER_ERROR;
			case "AUTH_EXPIRED":
				return ErrorCodes.AUTH_EXPIRED;
			default:
				return ErrorCodes.INTERNAL_ERROR;
		}
	}

	// ── Handle Steer ───────────────────────────────────────────

	private async _handleSteer(
		msg: JSONRPCSteerMessage,
	): Promise<JSONRPCSuccessResponse | JSONRPCErrorResponse> {
		if (!this.isStreaming || !this._soul) {
			return {
				jsonrpc: "2.0",
				id: msg.id,
				error: {
					code: ErrorCodes.INVALID_STATE,
					message: "No agent turn is in progress",
				},
			};
		}

		this._soul.onSteer(msg.params.user_input);
		return {
			jsonrpc: "2.0",
			id: msg.id,
			result: { status: Statuses.STEERED },
		};
	}

	// ── Handle Set Plan Mode ───────────────────────────────────

	private async _handleSetPlanMode(
		msg: JSONRPCSetPlanModeMessage,
	): Promise<JSONRPCSuccessResponse | JSONRPCErrorResponse> {
		if (!this._soul) {
			return {
				jsonrpc: "2.0",
				id: msg.id,
				error: {
					code: ErrorCodes.INVALID_STATE,
					message: "Plan mode is not supported",
				},
			};
		}

		const newState = await this._soul.onSetPlanMode(msg.params.enabled);

		// Send status update event
		const statusUpdate = { plan_mode: newState };
		await this._sendMsg(createEventMessage(statusUpdate as any));

		return {
			jsonrpc: "2.0",
			id: msg.id,
			result: { status: "ok", plan_mode: newState },
		};
	}

	// ── Handle Replay ──────────────────────────────────────────

	private async _handleReplay(
		msg: JSONRPCReplayMessage,
	): Promise<JSONRPCSuccessResponse | JSONRPCErrorResponse> {
		if (this.isStreaming) {
			return {
				jsonrpc: "2.0",
				id: msg.id,
				error: {
					code: ErrorCodes.INVALID_STATE,
					message: "An agent turn is already in progress",
				},
			};
		}

		const wireFile = this._soul?.wireFile;
		this._cancelEvent = new Deferred<void>();

		let events = 0;
		let requests = 0;

		try {
			if (!wireFile) {
				return {
					jsonrpc: "2.0",
					id: msg.id,
					result: { status: Statuses.FINISHED, events: 0, requests: 0 },
				};
			}

			for await (const record of wireFile.iterRecords()) {
				if (this._cancelEvent.settled) {
					return {
						jsonrpc: "2.0",
						id: msg.id,
						result: { status: Statuses.CANCELLED, events, requests },
					};
				}

				try {
					const { typeName, message } = deserializeWireMessage({
						type: record.message.type,
						payload: record.message.payload,
					});

					if (isRequestTypeName(typeName)) {
						const reqMsg = message as Request;
						const reqObj = reqMsg as Record<string, unknown>;
						await this._sendMsg(
							createRequestMessage(reqObj.id as string, reqMsg),
						);
						requests++;
					} else if (isEventTypeName(typeName)) {
						await this._sendMsg({
							jsonrpc: "2.0",
							method: "event",
							params: serializeWireMessage(typeName, record.message.payload),
						} as JSONRPCEventMessage);
						events++;
					}
				} catch (err) {
					console.error(
						"[Wire] Failed to deserialize wire record for replay:",
						err,
					);
					continue;
				}

				// Yield control
				await new Promise((r) => setTimeout(r, 0));
			}

			if (this._cancelEvent.settled) {
				return {
					jsonrpc: "2.0",
					id: msg.id,
					result: { status: Statuses.CANCELLED, events, requests },
				};
			}

			return {
				jsonrpc: "2.0",
				id: msg.id,
				result: { status: Statuses.FINISHED, events, requests },
			};
		} catch (err) {
			console.error("[Wire] Replay failed:", err);
			return {
				jsonrpc: "2.0",
				id: msg.id,
				error: {
					code: ErrorCodes.INTERNAL_ERROR,
					message: "Replay failed",
				},
			};
		} finally {
			this._cancelEvent = null;
		}
	}

	// ── Handle Cancel ──────────────────────────────────────────

	private async _handleCancel(
		msg: JSONRPCCancelMessage,
	): Promise<JSONRPCSuccessResponse | JSONRPCErrorResponse> {
		if (!this.isStreaming) {
			return {
				jsonrpc: "2.0",
				id: msg.id,
				error: {
					code: ErrorCodes.INVALID_STATE,
					message: "No agent turn is in progress",
				},
			};
		}

		this._cancelEvent!.resolve();
		return {
			jsonrpc: "2.0",
			id: msg.id,
			result: {},
		};
	}

	// ── Handle Response ────────────────────────────────────────

	private async _handleResponse(
		msg: JSONRPCSuccessResponse | JSONRPCErrorResponse,
	): Promise<void> {
		const id = msg.id;
		const request = this._pendingRequests.get(id);
		if (!request) {
			console.error(`[Wire] No pending request for response id=${id}`);
			return;
		}
		this._pendingRequests.delete(id);

		const isError = "error" in msg;

		if (request instanceof PendingApprovalRequest) {
			if (isError) {
				request.resolve("reject");
				// Also route back to ApprovalRuntime if available
				if (this._approvalRuntime) {
					this._approvalRuntime.resolve(id, "reject");
				}
				return;
			}
			try {
				const result = ApprovalResponseKind.safeParse(
					(msg as JSONRPCSuccessResponse).result,
				);
				// Parse as ApprovalResponse object
				const resultObj = (msg as JSONRPCSuccessResponse).result as Record<
					string,
					unknown
				>;
				const response = (resultObj.response ?? "reject") as
					| "approve"
					| "approve_for_session"
					| "reject";
				const feedback = (resultObj.feedback ?? "") as string;
				request.resolve(response, feedback);
				// Also route back to ApprovalRuntime if available
				if (this._approvalRuntime) {
					this._approvalRuntime.resolve(id, response, feedback);
				}
			} catch {
				request.resolve("reject");
				if (this._approvalRuntime) {
					this._approvalRuntime.resolve(id, "reject");
				}
			}
		} else if (request instanceof PendingToolCallRequest) {
			if (isError) {
				request.resolve({
					isError: true,
					output: (msg as JSONRPCErrorResponse).error.message,
					message: "External tool error",
				});
				return;
			}
			request.resolve((msg as JSONRPCSuccessResponse).result);
		} else if (request instanceof PendingQuestionRequest) {
			if (isError) {
				request.resolve({});
				resolveQuestionRequest(id, {});
				return;
			}
			try {
				const resultObj = (msg as JSONRPCSuccessResponse).result as Record<
					string,
					unknown
				>;
				const answers = (resultObj.answers ?? {}) as Record<string, string>;
				request.resolve(answers);
				// Also resolve the tool's pending question
				resolveQuestionRequest(id, answers);
			} catch {
				request.resolve({});
				resolveQuestionRequest(id, {});
			}
		} else if (request instanceof PendingHookRequest) {
			if (isError) {
				request.resolve("allow");
				return;
			}
			try {
				const resultObj = (msg as JSONRPCSuccessResponse).result as Record<
					string,
					unknown
				>;
				const action = (resultObj.action ?? "allow") as "allow" | "block";
				const reason = (resultObj.reason ?? "") as string;
				request.resolve(action, reason);
			} catch {
				request.resolve("allow");
			}
		}
	}

	// ── Stream Wire Messages ───────────────────────────────────

	private async _streamWireMessages(wire: Wire): Promise<void> {
		const wireUi = wire.uiSide(false);

		while (true) {
			let msg: WireMessage;
			try {
				msg = await wireUi.receive();
			} catch (e) {
				if (e instanceof QueueShutDown) break;
				throw e;
			}

			const msgObj = msg as Record<string, unknown>;

			// Check if it's an ApprovalRequest
			if (
				"id" in msgObj &&
				"tool_call_id" in msgObj &&
				"sender" in msgObj &&
				"action" in msgObj
			) {
				await this._requestApproval(msg as ApprovalRequest);
			}
			// Check if it's a ToolCallRequest
			else if (
				"id" in msgObj &&
				"name" in msgObj &&
				"arguments" in msgObj &&
				!("tool_call_id" in msgObj && "sender" in msgObj)
			) {
				await this._requestExternalTool(msg as ToolCallRequest);
			}
			// Check if it's a QuestionRequest
			else if (
				"id" in msgObj &&
				"tool_call_id" in msgObj &&
				"questions" in msgObj
			) {
				await this._requestQuestion(msg as QuestionRequest);
			}
			// Check if it's a HookRequest
			else if (
				"id" in msgObj &&
				"subscription_id" in msgObj &&
				"event" in msgObj
			) {
				// HookRequest — handled via hook engine callbacks
			}
			// Generic event
			else {
				await this._sendMsg(createEventMessage(msg));
			}
		}
	}

	private async _requestApproval(request: ApprovalRequest): Promise<void> {
		const msgId = request.id;
		const pending = new PendingApprovalRequest(request);
		this._pendingRequests.set(msgId, pending);
		await this._sendMsg(createRequestMessage(msgId, request as Request));
		// Do NOT await — same rationale as Python: avoid deadlocking the UI loop
	}

	private async _requestExternalTool(request: ToolCallRequest): Promise<void> {
		const msgId = request.id;
		const pending = new PendingToolCallRequest(request);
		this._pendingRequests.set(msgId, pending);
		await this._sendMsg(createRequestMessage(msgId, request as Request));
	}

	private async _requestQuestion(request: QuestionRequest): Promise<void> {
		if (!this._clientSupportsQuestion) {
			// Client does not support interactive questions;
			// signal the tool so it can tell the LLM to use an alternative approach.
			rejectQuestionRequest(request.id);
			return;
		}
		const msgId = request.id;
		const pending = new PendingQuestionRequest(request);
		this._pendingRequests.set(msgId, pending);
		await this._sendMsg(createRequestMessage(msgId, request as Request));
	}
}

// ── Soul Interface ─────────────────────────────────────────

/**
 * Interface that the Soul layer implements to integrate with WireServer.
 * This decouples the Wire server from the Soul implementation.
 */
export interface WireServerSoul {
	/**
	 * Called on initialize. Returns additional result fields.
	 */
	onInitialize(
		params: Record<string, unknown>,
	): Promise<Record<string, unknown>>;

	/**
	 * Called on prompt. Should run the soul and return a status string.
	 */
	onPrompt(
		userInput: string | unknown[],
		streamCallback: (wire: Wire) => Promise<void>,
		cancelEvent: Deferred<void>,
	): Promise<string>;

	/**
	 * Called on steer.
	 */
	onSteer(userInput: string | unknown[]): void;

	/**
	 * Called on set_plan_mode. Returns new plan mode state.
	 */
	onSetPlanMode(enabled: boolean): Promise<boolean>;

	/**
	 * Wire file for replay.
	 */
	wireFile?: WireFile;
}
