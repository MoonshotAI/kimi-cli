/**
 * ACP Kaos adapter — corresponds to Python acp/kaos.py
 * Routes file operations through ACP client with fallback to local fs.
 * ACPProcess polls ACP terminal for output.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import { logger } from "../utils/logging.ts";
import type {
	ClientCapabilities,
	TerminalOutputResponse,
	WaitForTerminalExitResponse,
} from "./types.ts";

const _DEFAULT_TERMINAL_OUTPUT_LIMIT = 50_000;
const _DEFAULT_POLL_INTERVAL = 0.2;
const _TRUNCATION_NOTICE = "[acp output truncated]\n";

/**
 * Minimal ACP client interface used by ACPKaos and ACPProcess.
 * Matches the subset of methods needed from the Python acp.Client.
 */
export interface ACPClient {
	readTextFile(opts: {
		path: string;
		sessionId: string;
	}): Promise<{ content: string }>;
	writeTextFile(opts: {
		path: string;
		content: string;
		sessionId: string;
	}): Promise<void>;
	createTerminal(opts: {
		command: string;
		sessionId: string;
		outputByteLimit?: number;
	}): Promise<{ terminalId: string }>;
	terminalOutput(opts: {
		sessionId: string;
		terminalId: string;
	}): Promise<TerminalOutputResponse>;
	waitForTerminalExit(opts: {
		sessionId: string;
		terminalId: string;
	}): Promise<WaitForTerminalExitResponse>;
	killTerminal(opts: { sessionId: string; terminalId: string }): Promise<void>;
	releaseTerminal(opts: {
		sessionId: string;
		terminalId: string;
	}): Promise<void>;
	sessionUpdate(opts: { sessionId: string; update: unknown }): Promise<void>;
	requestPermission(
		options: unknown[],
		sessionId: string,
		toolCallUpdate: unknown,
	): Promise<{ outcome: unknown }>;
}

/**
 * KAOS process adapter for ACP terminal execution.
 * Corresponds to Python ACPProcess.
 */
export class ACPProcess {
	private _client: ACPClient;
	private _sessionId: string;
	private _terminalId: string;
	private _pollInterval: number;
	private _returncode: number | null = null;
	private _lastOutput = "";
	private _truncationNoted = false;
	private _exitPromise: Promise<number>;
	private _resolveExit!: (code: number) => void;
	private _stdoutChunks: string[] = [];
	private _pollAbort = new AbortController();

	readonly pid = -1;

	constructor(
		client: ACPClient,
		sessionId: string,
		terminalId: string,
		pollInterval = _DEFAULT_POLL_INTERVAL,
	) {
		this._client = client;
		this._sessionId = sessionId;
		this._terminalId = terminalId;
		this._pollInterval = pollInterval;

		this._exitPromise = new Promise<number>((resolve) => {
			this._resolveExit = resolve;
		});

		// Start polling in background
		this._pollOutput().catch(() => {});
	}

	get returncode(): number | null {
		return this._returncode;
	}

	get stdout(): string {
		return this._stdoutChunks.join("");
	}

	async wait(): Promise<number> {
		return this._exitPromise;
	}

	async kill(): Promise<void> {
		await this._client.killTerminal({
			sessionId: this._sessionId,
			terminalId: this._terminalId,
		});
	}

	private _feedOutput(outputResponse: TerminalOutputResponse): void {
		const output = outputResponse.output;
		const reset =
			outputResponse.truncated ||
			(this._lastOutput !== "" && !output.startsWith(this._lastOutput));

		if (reset && this._lastOutput && !this._truncationNoted) {
			this._stdoutChunks.push(_TRUNCATION_NOTICE);
			this._truncationNoted = true;
		}

		const delta = reset ? output : output.slice(this._lastOutput.length);
		if (delta) {
			this._stdoutChunks.push(delta);
		}
		this._lastOutput = output;
	}

	private static _normalizeExitCode(exitCode: number | null): number {
		return exitCode === null ? 1 : exitCode;
	}

	private async _pollOutput(): Promise<void> {
		let exitCode: number | null = null;

		// Start exit waiter
		const exitPromise = this._client
			.waitForTerminalExit({
				sessionId: this._sessionId,
				terminalId: this._terminalId,
			})
			.catch(() => null);

		try {
			while (!this._pollAbort.signal.aborted) {
				// Check if exit already resolved
				const raceResult = await Promise.race([
					exitPromise.then((r) => ({ type: "exit" as const, result: r })),
					new Promise<{ type: "timeout" }>((resolve) =>
						setTimeout(
							() => resolve({ type: "timeout" }),
							this._pollInterval * 1000,
						),
					),
				]);

				if (raceResult.type === "exit") {
					const exitResponse = raceResult.result;
					exitCode = exitResponse?.exit_code ?? null;
					break;
				}

				// Poll output
				const outputResponse = await this._client.terminalOutput({
					sessionId: this._sessionId,
					terminalId: this._terminalId,
				});
				this._feedOutput(outputResponse);

				if (outputResponse.exit_status) {
					exitCode = outputResponse.exit_status.exit_code;
					// Try to get exit response too
					try {
						const exitResponse = await Promise.race([
							exitPromise,
							new Promise<null>((resolve) =>
								setTimeout(() => resolve(null), 1000),
							),
						]);
						if (exitResponse?.exit_code != null) {
							exitCode = exitResponse.exit_code;
						}
					} catch {
						// ignore
					}
					break;
				}
			}

			// Final output poll
			try {
				const finalOutput = await this._client.terminalOutput({
					sessionId: this._sessionId,
					terminalId: this._terminalId,
				});
				this._feedOutput(finalOutput);
			} catch {
				// ignore
			}
		} catch (exc) {
			const errorNote = `[acp terminal error] ${exc}\n`;
			this._stdoutChunks.push(errorNote);
			if (exitCode === null) {
				exitCode = 1;
			}
		} finally {
			this._returncode = ACPProcess._normalizeExitCode(exitCode);
			this._resolveExit(this._returncode);

			try {
				await this._client.releaseTerminal({
					sessionId: this._sessionId,
					terminalId: this._terminalId,
				});
			} catch {
				// ignore
			}
		}
	}
}

/**
 * KAOS backend that routes supported operations through ACP.
 * Corresponds to Python ACPKaos.
 */
export class ACPKaos {
	readonly name = "acp";

	private _client: ACPClient;
	private _sessionId: string;
	private _supportsRead: boolean;
	private _supportsWrite: boolean;
	private _supportsTerminal: boolean;
	private _outputByteLimit: number | null;
	private _pollInterval: number;

	constructor(
		client: ACPClient,
		sessionId: string,
		clientCapabilities: ClientCapabilities | null,
		opts?: {
			outputByteLimit?: number | null;
			pollInterval?: number;
		},
	) {
		this._client = client;
		this._sessionId = sessionId;

		const fs = clientCapabilities?.fs;
		this._supportsRead = !!fs?.read_text_file;
		this._supportsWrite = !!fs?.write_text_file;
		this._supportsTerminal = !!clientCapabilities?.terminal;
		this._outputByteLimit =
			opts?.outputByteLimit ?? _DEFAULT_TERMINAL_OUTPUT_LIMIT;
		this._pollInterval = opts?.pollInterval ?? _DEFAULT_POLL_INTERVAL;
	}

	get supportsTerminal(): boolean {
		return this._supportsTerminal;
	}

	/**
	 * Read text from a file, routing through ACP if supported.
	 */
	async readText(filePath: string): Promise<string> {
		const absPath = path.resolve(filePath);
		if (!this._supportsRead) {
			return await fs.readFile(absPath, "utf-8");
		}
		const response = await this._client.readTextFile({
			path: absPath,
			sessionId: this._sessionId,
		});
		return response.content;
	}

	/**
	 * Write text to a file, routing through ACP if supported.
	 */
	async writeText(
		filePath: string,
		data: string,
		mode: "w" | "a" = "w",
	): Promise<number> {
		const absPath = path.resolve(filePath);

		if (mode === "a") {
			if (this._supportsRead && this._supportsWrite) {
				const existing = await this.readText(absPath);
				await this._client.writeTextFile({
					path: absPath,
					content: existing + data,
					sessionId: this._sessionId,
				});
				return data.length;
			}
			await fs.appendFile(absPath, data, "utf-8");
			return data.length;
		}

		if (!this._supportsWrite) {
			await fs.writeFile(absPath, data, "utf-8");
			return data.length;
		}

		await this._client.writeTextFile({
			path: absPath,
			content: data,
			sessionId: this._sessionId,
		});
		return data.length;
	}
}
