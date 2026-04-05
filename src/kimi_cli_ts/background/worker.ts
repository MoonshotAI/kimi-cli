/**
 * Background task worker — corresponds to Python background/worker.py
 * Runs a bash command in a subprocess with heartbeat and kill polling.
 */

import { join } from "node:path";
import { existsSync, openSync, closeSync } from "node:fs";
import { BackgroundTaskStore } from "./store.ts";
import { isTerminalStatus } from "./models.ts";

export async function runBackgroundTaskWorker(
	taskDir: string,
	opts?: {
		heartbeatIntervalMs?: number;
		controlPollIntervalMs?: number;
		killGracePeriodMs?: number;
	},
): Promise<void> {
	const heartbeatIntervalMs = opts?.heartbeatIntervalMs ?? 5000;
	const controlPollIntervalMs = opts?.controlPollIntervalMs ?? 500;
	const killGracePeriodMs = opts?.killGracePeriodMs ?? 2000;

	const taskId = taskDir.split("/").pop()!;
	const storeRoot = join(taskDir, "..");
	const store = new BackgroundTaskStore(storeRoot);
	const spec = store.readSpec(taskId);
	let runtime = store.readRuntime(taskId);

	const now = Date.now() / 1000;
	runtime.status = "starting";
	runtime.workerPid = process.pid;
	runtime.startedAt = now;
	runtime.heartbeatAt = now;
	runtime.updatedAt = now;
	store.writeRuntime(taskId, runtime);

	// Check if already killed before launch
	const control = store.readControl(taskId);
	if (control.killRequestedAt != null) {
		runtime.status = "killed";
		runtime.interrupted = true;
		runtime.finishedAt = Date.now() / 1000;
		runtime.updatedAt = runtime.finishedAt;
		runtime.failureReason = control.killReason ?? "Killed before command start";
		store.writeRuntime(taskId, runtime);
		return;
	}

	if (!spec.command || !spec.shellPath || !spec.cwd) {
		runtime.status = "failed";
		runtime.finishedAt = Date.now() / 1000;
		runtime.updatedAt = runtime.finishedAt;
		runtime.failureReason = "Task spec is incomplete for bash worker";
		store.writeRuntime(taskId, runtime);
		return;
	}

	let timedOut = false;
	let timeoutReason: string | undefined;
	let killSentAt: number | undefined;

	const outputPath = store.outputPath(taskId);
	const outputFd = openSync(outputPath, "a");

	let proc: ReturnType<typeof Bun.spawn> | undefined;
	let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	let controlTimer: ReturnType<typeof setInterval> | undefined;

	try {
		const args =
			spec.shellName === "Windows PowerShell"
				? [spec.shellPath, "-command", spec.command]
				: [spec.shellPath, "-c", spec.command];

		proc = Bun.spawn(args, {
			stdin: "ignore",
			stdout: outputFd,
			stderr: outputFd,
			cwd: spec.cwd,
		});

		runtime = store.readRuntime(taskId);
		runtime.status = "running";
		runtime.childPid = proc.pid;
		runtime.childPgid = proc.pid;
		runtime.updatedAt = Date.now() / 1000;
		runtime.heartbeatAt = runtime.updatedAt;
		store.writeRuntime(taskId, runtime);

		// Heartbeat loop
		heartbeatTimer = setInterval(() => {
			try {
				const current = store.readRuntime(taskId);
				if (current.finishedAt != null) return;
				current.heartbeatAt = Date.now() / 1000;
				current.updatedAt = current.heartbeatAt;
				store.writeRuntime(taskId, current);
			} catch {
				// Ignore
			}
		}, heartbeatIntervalMs);

		// Control poll loop
		controlTimer = setInterval(() => {
			try {
				const ctrl = store.readControl(taskId);
				if (ctrl.killRequestedAt != null && proc) {
					try {
						proc.kill();
					} catch {
						// Process may be gone
					}
					if (
						killSentAt != null &&
						proc.exitCode == null &&
						Date.now() / 1000 - killSentAt >= killGracePeriodMs / 1000
					) {
						try {
							proc.kill(9); // SIGKILL
						} catch {
							// Ignore
						}
					}
					if (killSentAt == null) {
						killSentAt = Date.now() / 1000;
					}
				}
			} catch {
				// Ignore
			}
		}, controlPollIntervalMs);

		// Wait for process with optional timeout
		let exitCode: number;
		if (spec.timeoutS != null) {
			const timeoutPromise = new Promise<"timeout">((resolve) =>
				setTimeout(() => resolve("timeout"), spec.timeoutS! * 1000),
			);
			const result = await Promise.race([proc.exited, timeoutPromise]);
			if (result === "timeout") {
				timedOut = true;
				timeoutReason = `Command timed out after ${spec.timeoutS}s`;
				proc.kill();
				try {
					exitCode = await proc.exited;
				} catch {
					exitCode = -1;
				}
			} else {
				exitCode = result;
			}
		} else {
			exitCode = await proc.exited;
		}

		// Write final runtime
		const finalControl = store.readControl(taskId);
		const finalRuntime = store.readRuntime(taskId);
		finalRuntime.finishedAt = Date.now() / 1000;
		finalRuntime.updatedAt = finalRuntime.finishedAt;
		finalRuntime.exitCode = exitCode;
		finalRuntime.heartbeatAt = finalRuntime.finishedAt;

		if (timedOut) {
			finalRuntime.status = "failed";
			finalRuntime.interrupted = true;
			finalRuntime.timedOut = true;
			finalRuntime.failureReason = timeoutReason;
		} else if (finalControl.killRequestedAt != null) {
			finalRuntime.status = "killed";
			finalRuntime.interrupted = true;
			finalRuntime.failureReason = finalControl.killReason ?? "Killed";
		} else if (exitCode === 0) {
			finalRuntime.status = "completed";
			finalRuntime.failureReason = undefined;
		} else {
			finalRuntime.status = "failed";
			finalRuntime.failureReason = `Command failed with exit code ${exitCode}`;
		}
		store.writeRuntime(taskId, finalRuntime);
	} catch (err) {
		runtime = store.readRuntime(taskId);
		runtime.status = "failed";
		runtime.finishedAt = Date.now() / 1000;
		runtime.updatedAt = runtime.finishedAt;
		runtime.failureReason = String(err);
		store.writeRuntime(taskId, runtime);
	} finally {
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		if (controlTimer) clearInterval(controlTimer);
		closeSync(outputFd);
	}
}
