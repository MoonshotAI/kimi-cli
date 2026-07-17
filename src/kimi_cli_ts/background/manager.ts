/**
 * Background task manager — corresponds to Python background/manager.py
 * Manages task lifecycle: create, list, stop, recover.
 */

import { join } from "node:path";
import { logger } from "../utils/logging.ts";
import type { BackgroundConfig } from "../config.ts";
import type { Session } from "../session.ts";
import { generateTaskId } from "./ids.ts";
import {
	type TaskSpec,
	type TaskRuntime,
	type TaskView,
	type TaskOutputChunk,
	type TaskStatus,
	isTerminalStatus,
} from "./models.ts";
import { BackgroundTaskStore } from "./store.ts";

export class BackgroundTaskManager {
	private _session: Session;
	private _config: BackgroundConfig;
	private _ownerRole: string;
	private _store: BackgroundTaskStore;

	constructor(
		session: Session,
		config: BackgroundConfig,
		opts?: { ownerRole?: string },
	) {
		this._session = session;
		this._config = config;
		this._ownerRole = opts?.ownerRole ?? "root";
		// Store tasks dir next to context file
		const tasksDir = join(session.dir, "tasks");
		this._store = new BackgroundTaskStore(tasksDir);
	}

	get store(): BackgroundTaskStore {
		return this._store;
	}

	get role(): string {
		return this._ownerRole;
	}

	private ensureRoot(): void {
		if (this._ownerRole !== "root") {
			throw new Error(
				"Background tasks are only supported from the root agent.",
			);
		}
	}

	private activeTaskCount(): number {
		return this._store
			.listViews()
			.filter((v) => !isTerminalStatus(v.runtime.status)).length;
	}

	createBashTask(opts: {
		command: string;
		description: string;
		timeoutS: number;
		toolCallId: string;
		shellName: string;
		shellPath: string;
		cwd: string;
	}): TaskView {
		this.ensureRoot();

		if (this.activeTaskCount() >= this._config.max_running_tasks) {
			throw new Error("Too many background tasks are already running.");
		}

		const taskId = generateTaskId("bash");
		const now = Date.now() / 1000;
		const spec: TaskSpec = {
			version: 1,
			id: taskId,
			kind: "bash",
			sessionId: this._session.id,
			description: opts.description,
			toolCallId: opts.toolCallId,
			ownerRole: "root",
			createdAt: now,
			command: opts.command,
			shellName: opts.shellName,
			shellPath: opts.shellPath,
			cwd: opts.cwd,
			timeoutS: opts.timeoutS,
		};
		this._store.createTask(spec);

		// Launch worker subprocess
		const taskDir = this._store.taskDir(taskId);
		let runtime = this._store.readRuntime(taskId);
		try {
			const workerPid = this.launchWorker(taskDir);
			runtime = this._store.readRuntime(taskId);
			if (
				runtime.finishedAt == null &&
				(runtime.status === "created" ||
					(runtime.status === "starting" && runtime.workerPid == null))
			) {
				runtime.status = "starting";
				runtime.workerPid = workerPid;
				runtime.updatedAt = Date.now() / 1000;
				this._store.writeRuntime(taskId, runtime);
			}
		} catch (err) {
			runtime.status = "failed";
			runtime.failureReason = `Failed to launch worker: ${err}`;
			runtime.finishedAt = Date.now() / 1000;
			runtime.updatedAt = runtime.finishedAt;
			this._store.writeRuntime(taskId, runtime);
			throw err;
		}

		return this._store.mergedView(taskId);
	}

	private launchWorker(taskDir: string): number {
		const proc = Bun.spawn(
			[process.execPath, "--run", "background-worker", "--task-dir", taskDir],
			{
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
				cwd: taskDir,
			},
		);
		return proc.pid;
	}

	createAgentTask(opts: {
		agentId: string;
		subagentType: string;
		prompt: string;
		description: string;
		toolCallId: string;
		modelOverride?: string;
		timeoutS?: number;
		resumed?: boolean;
	}): TaskView {
		this.ensureRoot();

		if (this.activeTaskCount() >= this._config.max_running_tasks) {
			throw new Error("Too many background tasks are already running.");
		}

		const taskId = generateTaskId("agent");
		const now = Date.now() / 1000;
		const spec: TaskSpec = {
			version: 1,
			id: taskId,
			kind: "agent",
			sessionId: this._session.id,
			description: opts.description,
			toolCallId: opts.toolCallId,
			ownerRole: "root",
			createdAt: now,
			kindPayload: {
				agent_id: opts.agentId,
				subagent_type: opts.subagentType,
				prompt: opts.prompt,
				model_override: opts.modelOverride,
				launch_mode: "background",
			},
		};
		this._store.createTask(spec);

		const runtime = this._store.readRuntime(taskId);
		runtime.status = "starting";
		runtime.updatedAt = Date.now() / 1000;
		this._store.writeRuntime(taskId, runtime);

		return this._store.mergedView(taskId);
	}

	listTasks(opts?: { status?: TaskStatus; limit?: number }): TaskView[] {
		let tasks = this._store.listViews();
		if (opts?.status != null) {
			tasks = tasks.filter((t) => t.runtime.status === opts.status);
		}
		const limit = opts?.limit ?? 20;
		return tasks.slice(0, limit);
	}

	getTask(taskId: string): TaskView | undefined {
		try {
			return this._store.mergedView(taskId);
		} catch {
			return undefined;
		}
	}

	readOutput(
		taskId: string,
		opts?: { offset?: number; maxBytes?: number },
	): TaskOutputChunk {
		const view = this._store.mergedView(taskId);
		return this._store.readOutput(
			taskId,
			opts?.offset ?? 0,
			opts?.maxBytes ?? this._config.read_max_bytes,
			view.runtime.status,
		);
	}

	tailOutput(
		taskId: string,
		opts?: { maxBytes?: number; maxLines?: number },
	): string {
		this._store.mergedView(taskId); // validate existence
		return this._store.tailOutput(
			taskId,
			opts?.maxBytes ?? this._config.read_max_bytes,
			opts?.maxLines ?? this._config.notification_tail_lines,
		);
	}

	async wait(taskId: string, timeoutS = 30): Promise<TaskView> {
		const endTime = performance.now() + timeoutS * 1000;
		while (true) {
			const view = this._store.mergedView(taskId);
			if (isTerminalStatus(view.runtime.status)) return view;
			if (performance.now() >= endTime) return view;
			await Bun.sleep(this._config.wait_poll_interval_ms);
		}
	}

	kill(taskId: string, reason = "Killed by user"): TaskView {
		this.ensureRoot();
		const view = this._store.mergedView(taskId);
		if (isTerminalStatus(view.runtime.status)) return view;

		if (view.spec.kind === "agent") {
			this.markTaskKilled(taskId, reason);
			return this._store.mergedView(taskId);
		}

		// Bash: write control file, best-effort signal
		const control = { ...view.control };
		control.killRequestedAt = Date.now() / 1000;
		control.killReason = reason;
		control.force = false;
		this._store.writeControl(taskId, control);
		this.bestEffortKill(view.runtime);
		return this._store.mergedView(taskId);
	}

	killAllActive(reason = "CLI session ended"): string[] {
		const killed: string[] = [];
		for (const view of this._store.listViews()) {
			if (isTerminalStatus(view.runtime.status)) continue;
			try {
				this.kill(view.spec.id, reason);
				killed.push(view.spec.id);
			} catch {
				logger.error(`Failed to kill task ${view.spec.id} during shutdown`);
			}
		}
		return killed;
	}

	recover(): void {
		const now = Date.now() / 1000;
		const staleAfter = this._config.worker_stale_after_ms / 1000;

		for (const view of this._store.listViews()) {
			if (isTerminalStatus(view.runtime.status)) continue;

			if (view.spec.kind === "agent") {
				// Agent tasks without live runner are lost
				const runtime = { ...view.runtime };
				runtime.finishedAt = now;
				runtime.updatedAt = now;
				runtime.status = "lost";
				runtime.failureReason =
					"In-process background agent is no longer running";
				this._store.writeRuntime(view.spec.id, runtime);
				continue;
			}

			const lastProgressAt =
				view.runtime.heartbeatAt ??
				view.runtime.startedAt ??
				view.runtime.updatedAt ??
				view.spec.createdAt;
			if (now - lastProgressAt <= staleAfter) continue;

			// Re-read to narrow race window
			const freshRuntime = this._store.readRuntime(view.spec.id);
			if (isTerminalStatus(freshRuntime.status)) continue;
			const freshProgress =
				freshRuntime.heartbeatAt ??
				freshRuntime.startedAt ??
				freshRuntime.updatedAt ??
				view.spec.createdAt;
			if (now - freshProgress <= staleAfter) continue;

			const runtime = { ...freshRuntime };
			runtime.finishedAt = now;
			runtime.updatedAt = now;
			if (view.control.killRequestedAt != null) {
				runtime.status = "killed";
				runtime.interrupted = true;
				runtime.failureReason =
					view.control.killReason ?? "Killed during recovery";
			} else {
				runtime.status = "lost";
				runtime.failureReason =
					freshRuntime.heartbeatAt == null
						? "Background worker never heartbeat after startup"
						: "Background worker heartbeat expired";
			}
			this._store.writeRuntime(view.spec.id, runtime);
		}
	}

	reconcile(): void {
		this.recover();
	}

	// ── Internal status helpers ──

	markTaskRunning(taskId: string): void {
		const runtime = this._store.readRuntime(taskId);
		if (isTerminalStatus(runtime.status)) return;
		runtime.status = "running";
		runtime.updatedAt = Date.now() / 1000;
		runtime.heartbeatAt = runtime.updatedAt;
		runtime.failureReason = undefined;
		this._store.writeRuntime(taskId, runtime);
	}

	markTaskCompleted(taskId: string): void {
		const runtime = this._store.readRuntime(taskId);
		if (isTerminalStatus(runtime.status)) return;
		runtime.status = "completed";
		runtime.updatedAt = Date.now() / 1000;
		runtime.finishedAt = runtime.updatedAt;
		runtime.failureReason = undefined;
		this._store.writeRuntime(taskId, runtime);
	}

	markTaskFailed(taskId: string, reason: string): void {
		const runtime = this._store.readRuntime(taskId);
		if (isTerminalStatus(runtime.status)) return;
		runtime.status = "failed";
		runtime.updatedAt = Date.now() / 1000;
		runtime.finishedAt = runtime.updatedAt;
		runtime.failureReason = reason;
		this._store.writeRuntime(taskId, runtime);
	}

	markTaskKilled(taskId: string, reason: string): void {
		const runtime = this._store.readRuntime(taskId);
		if (isTerminalStatus(runtime.status)) return;
		runtime.status = "killed";
		runtime.updatedAt = Date.now() / 1000;
		runtime.finishedAt = runtime.updatedAt;
		runtime.interrupted = true;
		runtime.failureReason = reason;
		this._store.writeRuntime(taskId, runtime);
	}

	markTaskAwaitingApproval(taskId: string, reason: string): void {
		const runtime = this._store.readRuntime(taskId);
		if (isTerminalStatus(runtime.status)) return;
		runtime.status = "awaiting_approval";
		runtime.updatedAt = Date.now() / 1000;
		runtime.failureReason = reason;
		this._store.writeRuntime(taskId, runtime);
	}

	markTaskTimedOut(taskId: string, reason: string): void {
		const runtime = this._store.readRuntime(taskId);
		if (isTerminalStatus(runtime.status)) return;
		runtime.status = "failed";
		runtime.updatedAt = Date.now() / 1000;
		runtime.finishedAt = runtime.updatedAt;
		runtime.interrupted = true;
		runtime.timedOut = true;
		runtime.failureReason = reason;
		this._store.writeRuntime(taskId, runtime);
	}

	private bestEffortKill(runtime: TaskRuntime): void {
		try {
			const pid = runtime.childPgid ?? runtime.childPid ?? runtime.workerPid;
			if (pid == null) return;
			process.kill(pid, "SIGTERM");
		} catch {
			// Process may already be gone
		}
	}
}
