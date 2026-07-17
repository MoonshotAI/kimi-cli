/**
 * Background task models — corresponds to Python background/models.py
 */

export type TaskKind = "bash" | "agent";
export type TaskStatus =
	| "created"
	| "starting"
	| "running"
	| "awaiting_approval"
	| "completed"
	| "failed"
	| "killed"
	| "lost";
export type TaskOwnerRole = "root" | "subagent";

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
	"completed",
	"failed",
	"killed",
	"lost",
] as const;

export function isTerminalStatus(status: TaskStatus): boolean {
	return (TERMINAL_TASK_STATUSES as readonly string[]).includes(status);
}

export interface TaskSpec {
	version: number;
	id: string;
	kind: TaskKind;
	sessionId: string;
	description: string;
	toolCallId: string;
	ownerRole: TaskOwnerRole;
	createdAt: number;
	// Bash-specific
	command?: string;
	shellName?: string;
	shellPath?: string;
	cwd?: string;
	timeoutS?: number;
	// Generic payload for other task types
	kindPayload?: Record<string, unknown>;
}

export interface TaskRuntime {
	status: TaskStatus;
	workerPid?: number;
	childPid?: number;
	childPgid?: number;
	startedAt?: number;
	heartbeatAt?: number;
	updatedAt: number;
	finishedAt?: number;
	exitCode?: number;
	interrupted: boolean;
	timedOut: boolean;
	failureReason?: string;
}

export interface TaskControl {
	killRequestedAt?: number;
	killReason?: string;
	force: boolean;
}

export interface TaskConsumerState {
	lastSeenOutputSize: number;
	lastViewedAt?: number;
}

export interface TaskView {
	spec: TaskSpec;
	runtime: TaskRuntime;
	control: TaskControl;
	consumer: TaskConsumerState;
}

export interface TaskOutputChunk {
	taskId: string;
	offset: number;
	nextOffset: number;
	text: string;
	eof: boolean;
	status: TaskStatus;
}

// ── JSON serialization helpers (snake_case ↔ camelCase) ──

export function taskSpecToJson(spec: TaskSpec): Record<string, unknown> {
	return {
		version: spec.version,
		id: spec.id,
		kind: spec.kind,
		session_id: spec.sessionId,
		description: spec.description,
		tool_call_id: spec.toolCallId,
		owner_role: spec.ownerRole,
		created_at: spec.createdAt,
		command: spec.command,
		shell_name: spec.shellName,
		shell_path: spec.shellPath,
		cwd: spec.cwd,
		timeout_s: spec.timeoutS,
		kind_payload: spec.kindPayload,
	};
}

export function taskSpecFromJson(data: Record<string, unknown>): TaskSpec {
	let ownerRole = String(data.owner_role ?? "root");
	if (ownerRole === "fixed_subagent" || ownerRole === "dynamic_subagent") {
		ownerRole = "subagent";
	}
	return {
		version: Number(data.version ?? 1),
		id: String(data.id),
		kind: String(data.kind) as TaskKind,
		sessionId: String(data.session_id),
		description: String(data.description ?? ""),
		toolCallId: String(data.tool_call_id ?? ""),
		ownerRole: ownerRole as TaskOwnerRole,
		createdAt: Number(data.created_at ?? Date.now() / 1000),
		command: data.command != null ? String(data.command) : undefined,
		shellName: data.shell_name != null ? String(data.shell_name) : undefined,
		shellPath: data.shell_path != null ? String(data.shell_path) : undefined,
		cwd: data.cwd != null ? String(data.cwd) : undefined,
		timeoutS: data.timeout_s != null ? Number(data.timeout_s) : undefined,
		kindPayload: data.kind_payload as Record<string, unknown> | undefined,
	};
}

export function taskRuntimeToJson(rt: TaskRuntime): Record<string, unknown> {
	return {
		status: rt.status,
		worker_pid: rt.workerPid,
		child_pid: rt.childPid,
		child_pgid: rt.childPgid,
		started_at: rt.startedAt,
		heartbeat_at: rt.heartbeatAt,
		updated_at: rt.updatedAt,
		finished_at: rt.finishedAt,
		exit_code: rt.exitCode,
		interrupted: rt.interrupted,
		timed_out: rt.timedOut,
		failure_reason: rt.failureReason,
	};
}

export function taskRuntimeFromJson(
	data: Record<string, unknown>,
): TaskRuntime {
	return {
		status: String(data.status ?? "created") as TaskStatus,
		workerPid: data.worker_pid != null ? Number(data.worker_pid) : undefined,
		childPid: data.child_pid != null ? Number(data.child_pid) : undefined,
		childPgid: data.child_pgid != null ? Number(data.child_pgid) : undefined,
		startedAt: data.started_at != null ? Number(data.started_at) : undefined,
		heartbeatAt:
			data.heartbeat_at != null ? Number(data.heartbeat_at) : undefined,
		updatedAt: Number(data.updated_at ?? Date.now() / 1000),
		finishedAt: data.finished_at != null ? Number(data.finished_at) : undefined,
		exitCode: data.exit_code != null ? Number(data.exit_code) : undefined,
		interrupted: Boolean(data.interrupted ?? false),
		timedOut: Boolean(data.timed_out ?? false),
		failureReason:
			data.failure_reason != null ? String(data.failure_reason) : undefined,
	};
}

export function taskControlToJson(ctrl: TaskControl): Record<string, unknown> {
	return {
		kill_requested_at: ctrl.killRequestedAt,
		kill_reason: ctrl.killReason,
		force: ctrl.force,
	};
}

export function taskControlFromJson(
	data: Record<string, unknown>,
): TaskControl {
	return {
		killRequestedAt:
			data.kill_requested_at != null
				? Number(data.kill_requested_at)
				: undefined,
		killReason: data.kill_reason != null ? String(data.kill_reason) : undefined,
		force: Boolean(data.force ?? false),
	};
}

export function taskConsumerToJson(
	cs: TaskConsumerState,
): Record<string, unknown> {
	return {
		last_seen_output_size: cs.lastSeenOutputSize,
		last_viewed_at: cs.lastViewedAt,
	};
}

export function taskConsumerFromJson(
	data: Record<string, unknown>,
): TaskConsumerState {
	return {
		lastSeenOutputSize: Number(data.last_seen_output_size ?? 0),
		lastViewedAt:
			data.last_viewed_at != null ? Number(data.last_viewed_at) : undefined,
	};
}

export function newTaskRuntime(): TaskRuntime {
	return {
		status: "created",
		updatedAt: Date.now() / 1000,
		interrupted: false,
		timedOut: false,
	};
}

export function newTaskControl(): TaskControl {
	return { force: false };
}

export function newTaskConsumerState(): TaskConsumerState {
	return { lastSeenOutputSize: 0 };
}
