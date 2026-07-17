/**
 * Foreground subagent runner — corresponds to Python subagents/runner.py
 * Manages the lifecycle of foreground subagent executions.
 */

import { randomUUID } from "node:crypto";

import type { Runtime } from "../soul/agent.ts";
import type { Message, ContentPart } from "../types.ts";
import { KimiSoul } from "../soul/kimisoul.ts";
import {
	MaxStepsReached,
	RunCancelled,
	getWireOrNull,
	runSoul,
	type UILoopFn,
} from "../soul/index.ts";
import { getCurrentToolCallOrNull } from "../soul/toolset.ts";
import { ToolOk, ToolError, type ToolResult } from "../tools/types.ts";
import { SubagentOutputWriter } from "./output.ts";
import { SubagentStore } from "./store.ts";
import { SubagentBuilder } from "./builder.ts";
import type { AgentInstanceRecord } from "./models.ts";
import { type SubagentRunSpec, prepareSoul } from "./core.ts";
import type { ApprovalSource } from "../approval_runtime/index.ts";
import { runWithApprovalSourceAsync } from "../approval_runtime/index.ts";
import type { Wire } from "../wire/wire_core.ts";
import type { WireMessage } from "../wire/types.ts";
import {
	ApprovalRequest,
	ToolCallRequest,
	QuestionRequest,
	SubagentEvent,
} from "../wire/types.ts";
import { QueueShutDown } from "../utils/queue.ts";
import { WireFile } from "../wire/file.ts";
import * as hookEvents from "../hooks/events.ts";
import { logger } from "../utils/logging.ts";

// ── Constants ─────────────────────────────────────────────

export const SUMMARY_MIN_LENGTH = 200;
export const SUMMARY_CONTINUATION_ATTEMPTS = 1;
export const SUMMARY_CONTINUATION_PROMPT = `Your previous response was too brief. Please provide a more comprehensive summary that includes:

1. Specific technical details and implementations
2. Detailed findings and analysis
3. All important information that the parent agent should know`;

// ── Shared result types ──────────────────────────────────

export interface SoulRunFailure {
	readonly message: string;
	readonly brief: string;
}

export interface ForegroundRunRequest {
	readonly description: string;
	readonly prompt: string;
	readonly requestedType: string;
	readonly model?: string;
	readonly resume?: string;
}

export interface PreparedInstance {
	readonly record: AgentInstanceRecord;
	readonly actualType: string;
	readonly resumed: boolean;
}

// ── Execution helpers ────────────────────────────────────

/**
 * Extract text content from the last assistant message in history.
 */
function extractAssistantText(history: readonly Message[]): string {
	if (history.length === 0) return "";
	const last = history[history.length - 1]!;
	if (last.role !== "assistant") return "";
	if (typeof last.content === "string") return last.content;
	if (Array.isArray(last.content)) {
		return (last.content as ContentPart[])
			.filter((p): p is { type: "text"; text: string } => p.type === "text")
			.map((p) => p.text)
			.join("\n");
	}
	return "";
}

/**
 * Run a single soul turn using runSoul() and validate the result.
 * Returns a SoulRunFailure if the run failed, or null on success.
 * Corresponds to Python run_soul_checked().
 */
export async function runSoulChecked(
	soul: KimiSoul,
	prompt: string,
	uiLoopFn: UILoopFn,
	wirePath: string,
	phase: string,
): Promise<SoulRunFailure | null> {
	try {
		await runSoul(soul, prompt, uiLoopFn, new AbortController(), {
			wireFile: new WireFile(wirePath),
			runtime: soul.runtime,
		});
	} catch (err) {
		// RunCancelled must propagate — the caller marks the instance as killed.
		if (err instanceof RunCancelled) {
			throw err;
		}
		if (err instanceof MaxStepsReached) {
			return {
				message:
					`Max steps ${err.nSteps} reached when ${phase}. ` +
					"Please try splitting the task into smaller subtasks.",
				brief: "Max steps reached",
			};
		}
		// Convert any other error into a structured failure so the caller can
		// report it without crashing the parent agent.
		const errMsg = err instanceof Error ? err.message : String(err);
		logger.error(`Soul run error during ${phase}: ${errMsg}`);
		return {
			message: `Error when ${phase}: ${errMsg}`,
			brief: "Soul run error",
		};
	}

	const history = soul.ctx.history;
	if (
		history.length === 0 ||
		history[history.length - 1]!.role !== "assistant"
	) {
		return {
			message: "The agent did not produce a valid assistant response.",
			brief: "Invalid agent result",
		};
	}
	return null;
}

/**
 * Run soul, then optionally extend the summary if it is too short.
 * Returns [finalResponse, failure]. On success failure is null.
 * Corresponds to Python run_with_summary_continuation().
 */
export async function runWithSummaryContinuation(
	soul: KimiSoul,
	prompt: string,
	uiLoopFn: UILoopFn,
	wirePath: string,
): Promise<[string | null, SoulRunFailure | null]> {
	const failure = await runSoulChecked(
		soul,
		prompt,
		uiLoopFn,
		wirePath,
		"running agent",
	);
	if (failure !== null) return [null, failure];

	let finalResponse = extractAssistantText(soul.ctx.history);
	let remaining = SUMMARY_CONTINUATION_ATTEMPTS;

	while (remaining > 0 && finalResponse.length < SUMMARY_MIN_LENGTH) {
		remaining--;
		const contFailure = await runSoulChecked(
			soul,
			SUMMARY_CONTINUATION_PROMPT,
			uiLoopFn,
			wirePath,
			"continuing the agent summary",
		);
		if (contFailure !== null) return [null, contFailure];
		finalResponse = extractAssistantText(soul.ctx.history);
	}

	return [finalResponse, null];
}

// ── ForegroundSubagentRunner ─────────────────────────────

export class ForegroundSubagentRunner {
	private _runtime: Runtime;
	private _store: SubagentStore;
	private _builder: SubagentBuilder;

	constructor(runtime: Runtime) {
		if (!runtime.subagentStore) {
			throw new Error("Runtime must have a subagentStore to run subagents.");
		}
		this._runtime = runtime;
		this._store = runtime.subagentStore;
		this._builder = new SubagentBuilder(runtime);
	}

	async run(req: ForegroundRunRequest): Promise<ToolResult> {
		const prepared = await this._prepareInstance(req);
		const agentId = prepared.record.agentId;
		const actualType = prepared.actualType;
		const resumed = prepared.resumed;

		const laborMarket = this._runtime.laborMarket;
		if (!laborMarket) {
			return ToolError("LaborMarket not available on runtime.");
		}
		const typeDef = laborMarket.requireBuiltinType(actualType);

		let launchSpec = prepared.record.launchSpec;
		if (req.model) {
			launchSpec = {
				...launchSpec,
				modelOverride: req.model,
				effectiveModel: req.model,
			};
		}

		const outputWriter = new SubagentOutputWriter(
			this._store.outputPath(agentId),
		);
		outputWriter.stage("runner_started");

		const spec: SubagentRunSpec = {
			agentId,
			typeDef,
			launchSpec,
			prompt: req.prompt,
			resumed,
		};

		const [soul, prompt] = await prepareSoul(
			spec,
			this._runtime,
			this._builder,
			this._store,
			(name) => outputWriter.stage(name),
		);

		this._store.updateInstance(agentId, {
			status: "running_foreground",
			description: req.description.trim(),
		});

		const toolCall = getCurrentToolCallOrNull();
		const parentToolCallId = toolCall?.id ?? null;

		// Capture parent wire (via AsyncLocalStorage) for event forwarding.
		// Matches Python: super_wire = get_wire_or_none() in _make_ui_loop_fn.
		const superWire = getWireOrNull();
		const uiLoopFn = ForegroundSubagentRunner._makeUiLoopFn({
			parentToolCallId,
			agentId,
			subagentType: actualType,
			outputWriter,
			superWireSoulSide: superWire?.soulSide ?? null,
		});
		const wirePath = this._store.wirePath(agentId);

		// approvalSource is created inside the try block so the finally
		// clause can safely skip cancellation if we never got that far.
		let approvalSource: ApprovalSource | null = null;

		try {
			// Create a stable ApprovalSource for the entire run (including
			// summary continuation). This ensures cancelBySource can reliably
			// cancel all pending approval requests belonging to this execution.
			approvalSource = {
				kind: "foreground_turn",
				id: randomUUID().replace(/-/g, ""),
				agentId,
				subagentType: actualType,
			};

			// --- SubagentStart hook ---
			const hookEngine = this._runtime.hookEngine;
			await hookEngine.trigger("SubagentStart", {
				matcherValue: actualType,
				inputData: hookEvents.subagentStart({
					sessionId: this._runtime.session.id,
					cwd: process.cwd(),
					agentName: actualType,
					prompt: req.prompt.slice(0, 500),
				}),
			});

			outputWriter.stage("run_soul_start");
			const [finalResponse, failure] = await runWithApprovalSourceAsync(
				approvalSource,
				() => runWithSummaryContinuation(soul, prompt, uiLoopFn, wirePath),
			);

			if (failure !== null) {
				this._store.updateInstance(agentId, { status: "failed" });
				outputWriter.stage(`failed: ${failure.brief}`);
				return ToolError(failure.message);
			}

			// Defensive check — finalResponse should never be null when failure is null,
			// but guard against unexpected edge cases instead of crashing.
			if (finalResponse == null) {
				this._store.updateInstance(agentId, { status: "failed" });
				outputWriter.stage("failed: empty response");
				return ToolError("The agent did not produce a response.");
			}
			outputWriter.stage("run_soul_finished");

			// --- SubagentStop hook (fire-and-forget) ---
			hookEngine
				.trigger("SubagentStop", {
					matcherValue: actualType,
					inputData: hookEvents.subagentStop({
						sessionId: this._runtime.session.id,
						cwd: process.cwd(),
						agentName: actualType,
						response: finalResponse.slice(0, 500),
					}),
				})
				.catch(() => {});

			// Success
			this._store.updateInstance(agentId, { status: "idle" });
			outputWriter.summary(finalResponse);

			const lines = [
				`agent_id: ${agentId}`,
				resumed ? "resumed: true" : "resumed: false",
			];
			if (resumed && req.requestedType && req.requestedType !== actualType) {
				lines.push(`requested_subagent_type: ${req.requestedType}`);
			}
			lines.push(
				`actual_subagent_type: ${actualType}`,
				"status: completed",
				"",
				"[summary]",
				finalResponse,
			);
			return ToolOk(lines.join("\n"));
		} catch (err) {
			if (err instanceof RunCancelled) {
				this._store.updateInstance(agentId, { status: "killed" });
				outputWriter.stage("cancelled");
				throw err;
			}
			if (err instanceof Error && err.name === "AbortError") {
				this._store.updateInstance(agentId, { status: "killed" });
				outputWriter.stage("cancelled");
				throw err;
			}
			this._store.updateInstance(agentId, { status: "failed" });
			outputWriter.stage("failed_exception");
			throw err;
		} finally {
			// Cancel any pending approval requests from this subagent execution
			if (approvalSource && this._runtime.approvalRuntime) {
				this._runtime.approvalRuntime.cancelBySource(
					approvalSource.kind,
					approvalSource.id,
				);
			}
		}
	}

	/**
	 * Create a UI loop function that forwards subagent wire events to the parent wire.
	 * Corresponds to Python ForegroundSubagentRunner._make_ui_loop_fn().
	 *
	 * The returned function reads from the subagent's Wire and:
	 * - Writes all messages to the output file
	 * - Forwards ApprovalRequest/ToolCallRequest/QuestionRequest directly to parent wire
	 * - Wraps other events as SubagentEvent before forwarding
	 * - Skips HookRequest (handled internally)
	 */
	static _makeUiLoopFn(opts: {
		parentToolCallId: string | null;
		agentId: string;
		subagentType: string;
		outputWriter: SubagentOutputWriter;
		superWireSoulSide?: { send(msg: WireMessage): void } | null;
	}): UILoopFn {
		const {
			parentToolCallId,
			agentId,
			subagentType,
			outputWriter,
			superWireSoulSide,
		} = opts;

		return async (wire: Wire): Promise<void> => {
			const wireUi = wire.uiSide(true);
			while (true) {
				let msg: WireMessage;
				try {
					msg = await wireUi.receive();
				} catch (err) {
					if (err instanceof QueueShutDown) break;
					throw err;
				}

				// Always write to output file regardless of wire availability
				outputWriter.writeWireMessage(msg as Record<string, unknown>);

				if (superWireSoulSide == null || parentToolCallId == null) {
					continue;
				}

				// Use __wireType tag for efficient type detection (set by wireSend/wireMsg)
				const msgType = (msg as Record<string, unknown>).__wireType as
					| string
					| undefined;

				// Forward approval/tool call/question requests directly to parent
				if (
					msgType === "ApprovalRequest" ||
					msgType === "ApprovalResponse" ||
					msgType === "ToolCallRequest" ||
					msgType === "QuestionRequest"
				) {
					superWireSoulSide.send(msg);
					continue;
				}

				// Skip hook requests — handled internally
				if (msgType === "HookRequest") {
					continue;
				}

				// Wrap all other events as SubagentEvent
				superWireSoulSide.send({
					__wireType: "SubagentEvent",
					parent_tool_call_id: parentToolCallId,
					agent_id: agentId,
					subagent_type: subagentType,
					event: msg,
				} as unknown as WireMessage);
			}
		};
	}

	private async _prepareInstance(
		req: ForegroundRunRequest,
	): Promise<PreparedInstance> {
		if (req.resume) {
			const record = this._store.requireInstance(req.resume);
			if (
				record.status === "running_foreground" ||
				record.status === "running_background"
			) {
				throw new Error(
					`Agent instance ${record.agentId} is still ${record.status} and cannot be ` +
						"resumed concurrently.",
				);
			}
			return {
				record,
				actualType: record.subagentType,
				resumed: true,
			};
		}

		const actualType = req.requestedType || "coder";
		const laborMarket = this._runtime.laborMarket;
		if (!laborMarket) {
			throw new Error("LaborMarket not available on runtime.");
		}
		const typeDef = laborMarket.requireBuiltinType(actualType);
		const agentId = `a${randomUUID().replace(/-/g, "").slice(0, 8)}`;
		const record = this._store.createInstance({
			agentId,
			description: req.description.trim(),
			launchSpec: {
				agentId,
				subagentType: actualType,
				modelOverride: req.model,
				effectiveModel: req.model ?? typeDef.defaultModel,
				createdAt: Date.now() / 1000,
			},
		});
		return {
			record,
			actualType,
			resumed: false,
		};
	}
}
