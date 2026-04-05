/**
 * Context window management — corresponds to Python soul/context.py
 * Manages conversation message history with token tracking and persistence.
 */

import type { Message, TokenUsage } from "../types.ts";
import { estimateMessagesTokenCount } from "../llm.ts";
import { logger } from "../utils/logging.ts";

// ── Special JSONL record markers ────────────────────────

interface SystemPromptRecord {
	_system_prompt: string;
}

interface UsageRecord {
	_usage: { input_tokens: number; output_tokens: number };
}

interface CheckpointRecord {
	_checkpoint: { id: number; reminder?: string };
}

type ContextRecord =
	| Message
	| SystemPromptRecord
	| UsageRecord
	| CheckpointRecord;

// ── Context class ───────────────────────────────────────

export class Context {
	private _history: Message[] = [];
	private _tokenCount = 0;
	private _pendingTokenEstimate = 0;
	private _nextCheckpointId = 0;
	private _systemPrompt: string | null = null;
	private _filePath: string;

	constructor(filePath: string) {
		this._filePath = filePath;
	}

	// ── Properties ───────────────────────────────────

	get history(): readonly Message[] {
		return this._history;
	}

	get tokenCount(): number {
		return this._tokenCount;
	}

	get tokenCountWithPending(): number {
		return this._tokenCount + this._pendingTokenEstimate;
	}

	get systemPrompt(): string | null {
		return this._systemPrompt;
	}

	get nCheckpoints(): number {
		return this._nextCheckpointId;
	}

	get filePath(): string {
		return this._filePath;
	}

	// ── Restore from file ────────────────────────────

	async restore(): Promise<void> {
		const file = Bun.file(this._filePath);
		if (!(await file.exists())) return;

		const text = await file.text();
		const lines = text.split("\n");
		let lastUsageLineIdx = -1;

		this._history = [];
		this._systemPrompt = null;
		this._tokenCount = 0;
		this._nextCheckpointId = 0;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]!.trim();
			if (!line) continue;

			try {
				const record: ContextRecord = JSON.parse(line);

				if ("_system_prompt" in record) {
					this._systemPrompt = record._system_prompt;
				} else if ("_usage" in record) {
					// Only input tokens count toward context window (matches Python behavior)
					this._tokenCount = record._usage.input_tokens;
					lastUsageLineIdx = i;
				} else if ("_checkpoint" in record) {
					this._nextCheckpointId = record._checkpoint.id + 1;
					if (record._checkpoint.reminder) {
						// Checkpoint with system reminder → inject as user message
						this._history.push({
							role: "user",
							content: `<system-reminder>\n${record._checkpoint.reminder}\n</system-reminder>`,
						});
					}
				} else if ("role" in record) {
					this._history.push(record as Message);
				}
			} catch {
				logger.warn(`Skipping corrupt context line ${i}: ${line.slice(0, 80)}`);
			}
		}

		// Estimate tokens for messages after last usage record
		if (lastUsageLineIdx >= 0) {
			const postUsageMessages: Message[] = [];
			let postUsageCount = 0;
			for (let i = lastUsageLineIdx + 1; i < lines.length; i++) {
				const line = lines[i]!.trim();
				if (!line) continue;
				try {
					const record = JSON.parse(line);
					if ("role" in record) {
						postUsageMessages.push(record);
						postUsageCount++;
					}
				} catch {
					// skip
				}
			}
			if (postUsageCount > 0) {
				this._pendingTokenEstimate =
					estimateMessagesTokenCount(postUsageMessages);
			}
		} else {
			// No usage record at all → estimate everything
			this._pendingTokenEstimate = estimateMessagesTokenCount(this._history);
		}
	}

	// ── Append message ──────────────────────────────

	async appendMessage(message: Message): Promise<void> {
		this._history.push(message);
		const estimate = estimateMessagesTokenCount([message]);
		this._pendingTokenEstimate += estimate;
		await this._appendToFile(message);
	}

	// ── Write system prompt ─────────────────────────

	async writeSystemPrompt(systemPrompt: string): Promise<void> {
		this._systemPrompt = systemPrompt;
		const record: SystemPromptRecord = { _system_prompt: systemPrompt };
		// Prepend to file (rewrite)
		const file = Bun.file(this._filePath);
		let existing = "";
		if (await file.exists()) {
			existing = await file.text();
		}
		const line = JSON.stringify(record) + "\n";
		await Bun.write(this._filePath, line + existing);
	}

	// ── Update token count ──────────────────────────

	async updateTokenCount(usage: TokenUsage): Promise<void> {
		// Only input tokens count toward context window size (output doesn't consume context)
		this._tokenCount = usage.inputTokens + (usage.cacheReadTokens ?? 0);
		this._pendingTokenEstimate = 0;
		const record: UsageRecord = {
			_usage: {
				input_tokens: usage.inputTokens,
				output_tokens: usage.outputTokens,
			},
		};
		await this._appendToFile(record);
	}

	// ── Checkpoint ──────────────────────────────────

	async checkpoint(reminder?: string): Promise<number> {
		const id = this._nextCheckpointId++;
		const record: CheckpointRecord = {
			_checkpoint: { id, ...(reminder ? { reminder } : {}) },
		};
		if (reminder) {
			this._history.push({
				role: "user",
				content: `<system-reminder>\n${reminder}\n</system-reminder>`,
			});
		}
		await this._appendToFile(record);
		return id;
	}

	// ── Clear context ──────────────────────────────

	async clear(): Promise<void> {
		// Clear all state, keep system prompt
		this._history = [];
		this._tokenCount = 0;
		this._pendingTokenEstimate = 0;
		this._nextCheckpointId = 0;

		// Write empty file (with system prompt if present)
		if (this._systemPrompt) {
			const record: SystemPromptRecord = {
				_system_prompt: this._systemPrompt,
			};
			await Bun.write(this._filePath, JSON.stringify(record) + "\n");
		} else {
			await Bun.write(this._filePath, "");
		}
	}

	// ── Compact (clear and rotate) ─────────────────

	async compact(): Promise<void> {
		// Rotate old file
		const backupPath = this._filePath + ".bak";
		const file = Bun.file(this._filePath);
		if (await file.exists()) {
			const content = await file.text();
			await Bun.write(backupPath, content);
		}

		// Clear state
		this._history = [];
		this._tokenCount = 0;
		this._pendingTokenEstimate = 0;
		this._nextCheckpointId = 0;

		// Write empty file (with system prompt if present)
		if (this._systemPrompt) {
			const record: SystemPromptRecord = {
				_system_prompt: this._systemPrompt,
			};
			await Bun.write(this._filePath, JSON.stringify(record) + "\n");
		} else {
			await Bun.write(this._filePath, "");
		}
	}

	// ── Revert to checkpoint ───────────────────────

	async revertTo(checkpointId: number): Promise<void> {
		const file = Bun.file(this._filePath);
		if (!(await file.exists())) return;

		const text = await file.text();
		const lines = text.split("\n");
		const kept: string[] = [];
		let found = false;

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			kept.push(trimmed);
			try {
				const record = JSON.parse(trimmed);
				if ("_checkpoint" in record && record._checkpoint.id === checkpointId) {
					found = true;
					break;
				}
			} catch {
				// keep the line
			}
		}

		if (!found) {
			logger.warn(`Checkpoint ${checkpointId} not found, no revert`);
			return;
		}

		// Backup and rewrite
		await Bun.write(this._filePath + ".bak", text);
		await Bun.write(this._filePath, kept.join("\n") + "\n");

		// Reload
		await this.restore();
	}

	// ── Private helpers ────────────────────────────

	private async _appendToFile(record: ContextRecord): Promise<void> {
		const line = JSON.stringify(record) + "\n";
		const { appendFile } = await import("node:fs/promises");
		await appendFile(this._filePath, line, "utf-8");
	}
}
