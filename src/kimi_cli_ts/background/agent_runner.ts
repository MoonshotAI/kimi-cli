/**
 * Background agent runner — corresponds to Python background/agent_runner.py
 * Runs a subagent as a background task, handling approval events and lifecycle.
 */

import { logger } from "../utils/logging.ts";
import {
	type ApprovalSource,
	type ApprovalRuntimeEvent,
	ApprovalCancelledError,
	runWithApprovalSourceAsync,
} from "../approval_runtime/index.ts";
import { RunCancelled } from "../soul/index.ts";
import { SubagentBuilder } from "../subagents/builder.ts";
import { type SubagentRunSpec, prepareSoul } from "../subagents/core.ts";
import { SubagentOutputWriter } from "../subagents/output.ts";
import { runWithSummaryContinuation } from "../subagents/runner.ts";
import type { Wire } from "../wire/wire_core.ts";
import type { BackgroundTaskManager } from "./manager.ts";
import type { Runtime } from "../soul/agent.ts";

export class BackgroundAgentRunner {
	private _runtime: Runtime;
	private _manager: BackgroundTaskManager;
	private _taskId: string;
	private _agentId: string;
	private _subagentType: string;
	private _prompt: string;
	private _modelOverride: string | null;
	private _timeoutMs: number | null;
	private _resumed: boolean;
	private _builder: SubagentBuilder;
	private _approvalAbortControllers = new Set<AbortController>();

	constructor(opts: {
		runtime: Runtime;
		manager: BackgroundTaskManager;
		taskId: string;
		agentId: string;
		subagentType: string;
		prompt: string;
		modelOverride?: string | null;
		timeoutS?: number | null;
		resumed?: boolean;
	}) {
		this._runtime = opts.runtime;
		this._manager = opts.manager;
		this._taskId = opts.taskId;
		this._agentId = opts.agentId;
		this._subagentType = opts.subagentType;
		this._prompt = opts.prompt;
		this._modelOverride = opts.modelOverride ?? null;
		this._timeoutMs = opts.timeoutS != null ? opts.timeoutS * 1000 : null;
		this._resumed = opts.resumed ?? false;
		this._builder = new SubagentBuilder(opts.runtime);
	}

	async run(): Promise<void> {
		const approvalRuntime = this._runtime.approvalRuntime;
		const subagentStore = this._runtime.subagentStore;
		if (!approvalRuntime || !subagentStore) {
			throw new Error("approvalRuntime and subagentStore must be set");
		}

		const source: ApprovalSource = {
			kind: "background_agent",
			id: this._taskId,
			agentId: this._agentId,
			subagentType: this._subagentType,
		};

		const approvalSubscription = approvalRuntime.subscribe((event) =>
			this._onApprovalRuntimeEvent(event),
		);

		const taskOutputPath = this._manager.store.outputPath(this._taskId);
		const output = new SubagentOutputWriter(
			subagentStore.outputPath(this._agentId),
			[taskOutputPath],
		);

		try {
			await runWithApprovalSourceAsync(source, async () => {
				if (this._timeoutMs != null) {
					await this._runWithTimeout(output, this._timeoutMs);
				} else {
					await this._runCore(output);
				}
			});
		} catch (err) {
			if (err instanceof RunCancelled) {
				subagentStore.updateInstance(this._agentId, { status: "killed" });
				this._manager.markTaskKilled(this._taskId, "Run was cancelled");
				output.stage("cancelled");
			} else if (err instanceof Error && err.name === "AbortError") {
				// Task was stopped externally
				subagentStore.updateInstance(this._agentId, { status: "killed" });
				this._manager.markTaskKilled(this._taskId, "Stopped by TaskStop");
				output.stage("cancelled");
			} else if (err instanceof Error) {
				logger.error("Background agent runner failed", err.message);
				subagentStore.updateInstance(this._agentId, { status: "failed" });
				this._manager.markTaskFailed(this._taskId, err.message);
				output.error(err.message);
			}
		} finally {
			for (const ac of this._approvalAbortControllers) {
				ac.abort();
			}
			this._approvalAbortControllers.clear();
			approvalRuntime.unsubscribe(approvalSubscription);
			approvalRuntime.cancelBySource("background_agent", this._taskId);
		}
	}

	private async _runWithTimeout(
		output: SubagentOutputWriter,
		timeoutMs: number,
	): Promise<void> {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), timeoutMs);
		if (typeof timer === "object" && "unref" in timer) {
			(timer as NodeJS.Timeout).unref();
		}
		try {
			await Promise.race([
				this._runCore(output),
				new Promise<never>((_, reject) => {
					ac.signal.addEventListener("abort", () => {
						reject(
							new Error(`Agent task timed out after ${timeoutMs / 1000}s`),
						);
					});
				}),
			]);
		} catch (err) {
			if (
				err instanceof Error &&
				err.message.startsWith("Agent task timed out")
			) {
				logger.warn(
					`Background agent task ${this._taskId} timed out after ${timeoutMs / 1000}s`,
				);
				const subagentStore = this._runtime.subagentStore!;
				subagentStore.updateInstance(this._agentId, { status: "failed" });
				this._manager.markTaskFailed(this._taskId, err.message);
				output.error(err.message);
				return;
			}
			throw err;
		} finally {
			clearTimeout(timer);
		}
	}

	private async _runCore(output: SubagentOutputWriter): Promise<void> {
		const subagentStore = this._runtime.subagentStore!;
		this._manager.markTaskRunning(this._taskId);
		output.stage("runner_started");

		const typeDef = this._runtime.laborMarket!.requireBuiltinType(
			this._subagentType,
		);
		const record = subagentStore.requireInstance(this._agentId);
		let launchSpec = record.launchSpec;
		if (this._modelOverride != null) {
			launchSpec = {
				...launchSpec,
				modelOverride: this._modelOverride,
				effectiveModel: this._modelOverride,
			};
		}

		const spec: SubagentRunSpec = {
			agentId: this._agentId,
			typeDef,
			launchSpec,
			prompt: this._prompt,
			resumed: this._resumed,
		};
		const [soul, prompt] = await prepareSoul(
			spec,
			this._runtime,
			this._builder,
			subagentStore,
			(name) => output.stage(name),
		);

		const uiLoopFn = async (wire: Wire): Promise<void> => {
			const wireUi = wire.uiSide(true);
			while (true) {
				const msg = await wireUi.receive();
				output.writeWireMessage(msg);
			}
		};

		output.stage("run_soul_start");
		const [finalResponse, failure] = await runWithSummaryContinuation(
			soul,
			prompt,
			uiLoopFn,
			subagentStore.wirePath(this._agentId),
		);

		if (failure != null) {
			this._manager.markTaskFailed(this._taskId, failure.message);
			subagentStore.updateInstance(this._agentId, { status: "failed" });
			output.stage(`failed: ${failure.brief}`);
			return;
		}
		output.stage("run_soul_finished");

		if (finalResponse == null) {
			this._manager.markTaskFailed(
				this._taskId,
				"Agent completed but produced no output.",
			);
			subagentStore.updateInstance(this._agentId, { status: "failed" });
			output.stage("failed: empty output");
			return;
		}
		output.summary(finalResponse);
		subagentStore.updateInstance(this._agentId, { status: "idle" });
		this._manager.markTaskCompleted(this._taskId);
	}

	private _onApprovalRuntimeEvent(event: ApprovalRuntimeEvent): void {
		const request = event.request;
		if (
			request.source.kind !== "background_agent" ||
			request.source.id !== this._taskId
		) {
			return;
		}
		const ac = new AbortController();
		this._approvalAbortControllers.add(ac);
		this._applyApprovalRuntimeEvent(event)
			.catch((err) => {
				if (!(err instanceof Error && err.name === "AbortError")) {
					logger.error("Failed to apply background approval state update", err);
				}
			})
			.finally(() => {
				this._approvalAbortControllers.delete(ac);
			});
	}

	private async _applyApprovalRuntimeEvent(
		event: ApprovalRuntimeEvent,
	): Promise<void> {
		const approvalRuntime = this._runtime.approvalRuntime!;
		if (event.kind === "request_created") {
			this._manager.markTaskAwaitingApproval(
				this._taskId,
				event.request.description,
			);
		} else if (event.kind === "request_resolved") {
			const pendingForTask = approvalRuntime
				.listPending()
				.filter(
					(p) =>
						p.source.kind === "background_agent" &&
						p.source.id === this._taskId,
				);
			if (pendingForTask.length > 0) return;
			this._manager.markTaskRunning(this._taskId);
		}
	}
}
