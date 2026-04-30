/**
 * Web runner process — corresponds to Python web/runner/process.py
 * SessionProcess manages a single session's worker subprocess + WebSocket fanout.
 * KimiCLIRunner manages multiple SessionProcess instances.
 */

import { join } from "node:path";
import type { Subprocess } from "bun";
import type { ServerWebSocket } from "bun";
import type {
	SessionRunState,
	SessionStatus,
	SessionNoticeEvent,
} from "../models.ts";
import { newSessionStatusMessage, sendHistoryComplete } from "./messages.ts";
import { logger } from "../../utils/logging.ts";

// ── SessionProcess ───────────────────────────────────────

export class SessionProcess {
	readonly sessionId: string;
	readonly sessionDir: string;
	private worker: Subprocess | null = null;
	private workerId: string | null = null;
	private _state: SessionRunState = "stopped";
	private _seq = 0;
	private _reason: string | null = null;
	private _detail: string | null = null;
	private websockets = new Set<ServerWebSocket<unknown>>();
	private replayMode = new Set<ServerWebSocket<unknown>>();
	private replayBuffer: string[] = [];
	private inFlightPrompts = new Set<string>();
	private _readLoopPromise: Promise<void> | null = null;

	constructor(sessionId: string, sessionDir: string) {
		this.sessionId = sessionId;
		this.sessionDir = sessionDir;
	}

	get isAlive(): boolean {
		return this.worker !== null;
	}

	get isRunning(): boolean {
		return this._state === "idle" || this._state === "busy";
	}

	get isBusy(): boolean {
		return this._state === "busy";
	}

	get status(): SessionStatus {
		return this._buildStatus();
	}

	get websocketCount(): number {
		return this.websockets.size;
	}

	private _buildStatus(): SessionStatus {
		return {
			session_id: this.sessionId,
			state: this._state,
			seq: this._seq,
			worker_id: this.workerId,
			reason: this._reason,
			detail: this._detail,
			updated_at: new Date().toISOString(),
		};
	}

	private _emitStatus(
		state: SessionRunState,
		reason: string | null = null,
		detail: string | null = null,
	): void {
		this._state = state;
		this._reason = reason;
		this._detail = detail;
		this._seq++;
		const msg = JSON.stringify(newSessionStatusMessage(this._buildStatus()));
		this._broadcast(msg);
	}

	// ── Worker lifecycle ───────────────────────────────────

	async start(): Promise<void> {
		if (this.worker) return;

		const workerId = crypto.randomUUID();
		this.workerId = workerId;

		// Spawn worker subprocess
		// The worker command should be the same binary with a worker subcommand
		const workerScript = join(import.meta.dir, "worker.ts");
		const proc = Bun.spawn(
			["bun", "run", workerScript, "--session-id", this.sessionId],
			{
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					KIMI_WORKER_ID: workerId,
					KIMI_SESSION_DIR: this.sessionDir,
				},
			},
		);

		this.worker = proc;
		this._emitStatus("idle", "started");

		// Start read loop
		this._readLoopPromise = this._readLoop();

		// Handle process exit
		proc.exited.then((code) => {
			this.worker = null;
			this._readLoopPromise = null;
			if (this._state !== "stopped") {
				this._emitStatus("stopped", "exited", `exit code: ${code}`);
			}
		});
	}

	async stop(): Promise<void> {
		await this.stopWorker();

		// Close all WebSockets
		for (const ws of this.websockets) {
			try {
				ws.close(1000, "Server shutting down");
			} catch {
				// ignore
			}
		}
		this.websockets.clear();
		this.replayMode.clear();
		this.replayBuffer = [];
		this.inFlightPrompts.clear();
	}

	async stopWorker(): Promise<void> {
		if (!this.worker) return;

		const proc = this.worker;
		this.worker = null;
		this._emitStatus("stopped", "stopped");

		try {
			proc.kill("SIGTERM");
			// Give it 5 seconds before SIGKILL
			const timeout = setTimeout(() => {
				try {
					proc.kill("SIGKILL");
				} catch {
					// ignore
				}
			}, 5000);
			await proc.exited;
			clearTimeout(timeout);
		} catch {
			// ignore
		}
	}

	async restartWorker(reason = "restart"): Promise<void> {
		const restartMs = 1000;

		// Emit restart notice
		const notice: SessionNoticeEvent = {
			type: "SessionNotice",
			payload: {
				text: `Restarting worker: ${reason}`,
				kind: "restart",
				reason,
				restart_ms: restartMs,
			},
		};

		this._emitStatus("restarting", reason);
		this._broadcast(
			JSON.stringify({ jsonrpc: "2.0", method: "event", params: notice }),
		);

		await this.stopWorker();
		await new Promise((r) => setTimeout(r, restartMs));
		await this.start();
	}

	// ── Read loop (stdout from worker) ─────────────────────

	private async _readLoop(): Promise<void> {
		if (!this.worker?.stdout) return;

		const stdout = this.worker.stdout as ReadableStream<Uint8Array>;
		const reader = stdout.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });

				let newlineIdx: number;
				while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
					const line = buffer.slice(0, newlineIdx).trim();
					buffer = buffer.slice(newlineIdx + 1);

					if (!line) continue;

					try {
						this._handleOutLine(line);
					} catch (err) {
						logger.warn(`Error handling worker output: ${err}`);
					}
				}
			}
		} catch (err) {
			logger.warn(`Read loop error for session ${this.sessionId}: ${err}`);
		}
	}

	private _handleOutLine(line: string): void {
		// Try to parse as JSON-RPC
		let msg: any;
		try {
			msg = JSON.parse(line);
		} catch {
			// Not JSON, ignore
			return;
		}

		// Check if it's a response (success or error)
		if (msg.id && !msg.method) {
			// It's a response — remove from in-flight
			this.inFlightPrompts.delete(msg.id);
			if (this.inFlightPrompts.size === 0 && this._state === "busy") {
				this._emitStatus("idle", "response_complete");
			}
		}

		// Broadcast to all WebSockets
		this._broadcast(line);
	}

	// ── WebSocket management ───────────────────────────────

	addWebsocketAndBeginReplay(ws: ServerWebSocket<unknown>): void {
		this.websockets.add(ws);
		this.replayMode.add(ws);

		// Send buffered messages
		for (const msg of this.replayBuffer) {
			try {
				ws.send(msg);
			} catch {
				break;
			}
		}
	}

	endReplay(ws: ServerWebSocket<unknown>): void {
		this.replayMode.delete(ws);
		sendHistoryComplete(ws);

		// Send current status
		const statusMsg = JSON.stringify(
			newSessionStatusMessage(this._buildStatus()),
		);
		try {
			ws.send(statusMsg);
		} catch {
			// ignore
		}
	}

	removeWebsocket(ws: ServerWebSocket<unknown>): void {
		this.websockets.delete(ws);
		this.replayMode.delete(ws);
	}

	// ── Message sending (from WebSocket client to worker) ──

	async sendMessage(data: string): Promise<void> {
		if (!this.worker) {
			await this.start();
		}

		// Parse to check if it's a prompt request
		try {
			const msg = JSON.parse(data);
			if (msg.method === "prompt" && msg.id) {
				this.inFlightPrompts.add(msg.id);
				this._emitStatus("busy", "prompt");
			}
		} catch {
			// ignore parse errors
		}

		// Write to worker stdin
		if (this.worker?.stdin) {
			const stdin = this.worker.stdin as import("bun").FileSink;
			stdin.write(new TextEncoder().encode(data + "\n"));
			stdin.flush();
		}
	}

	// ── Broadcast ──────────────────────────────────────────

	private _broadcast(data: string): void {
		// Buffer for replay
		this.replayBuffer.push(data);
		// Limit buffer size
		if (this.replayBuffer.length > 10000) {
			this.replayBuffer = this.replayBuffer.slice(-5000);
		}

		const dead = new Set<ServerWebSocket<unknown>>();
		for (const ws of this.websockets) {
			// Skip WebSockets still in replay mode
			if (this.replayMode.has(ws)) continue;
			try {
				ws.send(data);
			} catch {
				dead.add(ws);
			}
		}

		for (const ws of dead) {
			this.websockets.delete(ws);
			this.replayMode.delete(ws);
		}
	}
}

// ── KimiCLIRunner ────────────────────────────────────────

export interface RestartWorkersSummary {
	restartedSessionIds: string[];
	skippedBusySessionIds: string[];
}

export class KimiCLIRunner {
	private sessions = new Map<string, SessionProcess>();

	async start(): Promise<void> {
		// Nothing to do on start — sessions are lazy-created
	}

	async stop(): Promise<void> {
		const promises: Promise<void>[] = [];
		for (const sp of this.sessions.values()) {
			promises.push(sp.stop());
		}
		await Promise.all(promises);
		this.sessions.clear();
	}

	getOrCreateSession(sessionId: string, sessionDir: string): SessionProcess {
		let sp = this.sessions.get(sessionId);
		if (!sp) {
			sp = new SessionProcess(sessionId, sessionDir);
			this.sessions.set(sessionId, sp);
		}
		return sp;
	}

	getSession(sessionId: string): SessionProcess | undefined {
		return this.sessions.get(sessionId);
	}

	detachWebsocket(ws: ServerWebSocket<unknown>): void {
		for (const sp of this.sessions.values()) {
			sp.removeWebsocket(ws);
		}
	}

	async restartRunningWorkers(
		reason = "config_change",
		force = false,
	): Promise<RestartWorkersSummary> {
		const restarted: string[] = [];
		const skipped: string[] = [];

		for (const [id, sp] of this.sessions) {
			if (!sp.isRunning) continue;

			if (sp.isBusy && !force) {
				skipped.push(id);
				continue;
			}

			try {
				await sp.restartWorker(reason);
				restarted.push(id);
			} catch (err) {
				logger.warn(`Failed to restart worker ${id}: ${err}`);
			}
		}

		return {
			restartedSessionIds: restarted,
			skippedBusySessionIds: skipped,
		};
	}
}
