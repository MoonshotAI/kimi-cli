/**
 * Context window management — corresponds to Python soul/context.py
 * Manages conversation message history with token tracking and persistence.
 */

import { readdirSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { Message, TokenUsage } from "../types.ts";
import { estimateMessagesTokenCount } from "../llm.ts";
import { logger } from "../utils/logging.ts";

// ── Special JSONL record markers (Python-compatible format) ──
// Python uses: {"role": "_system_prompt", "content": "..."}
//              {"role": "_usage", "token_count": N}
//              {"role": "_checkpoint", "id": N}
// All special records use the "role" field with underscore-prefixed values.

interface SystemPromptRecord {
	role: "_system_prompt";
	content: string;
}

interface UsageRecord {
	role: "_usage";
	token_count: number;
}

interface CheckpointRecord {
	role: "_checkpoint";
	id: number;
	reminder?: string;
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
				const record = JSON.parse(line) as Record<string, unknown>;
				const role = record.role as string | undefined;

				if (role === "_system_prompt") {
					this._systemPrompt = record.content as string;
				} else if (role === "_usage") {
					this._tokenCount = record.token_count as number;
					lastUsageLineIdx = i;
				} else if (role === "_checkpoint") {
					this._nextCheckpointId = (record.id as number) + 1;
					if (record.reminder) {
						// Checkpoint with system reminder → inject as user message
						this._history.push({
							role: "user",
							content: `<system-reminder>\n${record.reminder}\n</system-reminder>`,
						});
					}
				} else if (
					// Legacy TS format support (can be removed once all sessions migrated)
					"_system_prompt" in record
				) {
					this._systemPrompt = record._system_prompt as string;
				} else if ("_usage" in record) {
					const usage = record._usage as {
						input_tokens: number;
						output_tokens: number;
					};
					this._tokenCount = usage.input_tokens;
					lastUsageLineIdx = i;
				} else if ("_checkpoint" in record) {
					const cp = record._checkpoint as {
						id: number;
						reminder?: string;
					};
					this._nextCheckpointId = cp.id + 1;
					if (cp.reminder) {
						this._history.push({
							role: "user",
							content: `<system-reminder>\n${cp.reminder}\n</system-reminder>`,
						});
					}
				} else if (role && !role.startsWith("_")) {
					this._history.push(record as unknown as Message);
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
					const r = record.role as string | undefined;
					if (r && !r.startsWith("_")) {
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
		const record: SystemPromptRecord = { role: "_system_prompt", content: systemPrompt };
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
		const tokenCount = usage.inputTokens + (usage.cacheReadTokens ?? 0);
		this._tokenCount = tokenCount;
		this._pendingTokenEstimate = 0;
		const record: UsageRecord = {
			role: "_usage",
			token_count: tokenCount,
		};
		await this._appendToFile(record);
	}

	// ── Checkpoint ──────────────────────────────────

	async checkpoint(reminder?: string): Promise<number> {
		const id = this._nextCheckpointId++;
		const record: CheckpointRecord = {
			role: "_checkpoint",
			id,
			...(reminder ? { reminder } : {}),
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
		// Rotate the context file (matches Python behavior: context.jsonl → context_1.jsonl)
		const file = Bun.file(this._filePath);
		if (await file.exists()) {
			const rotatedPath = nextAvailableRotation(this._filePath);
			if (rotatedPath) {
				const { rename } = await import("node:fs/promises");
				await rename(this._filePath, rotatedPath);
			}
		}

		// Clear all state (matches Python: system_prompt is set to None)
		this._history = [];
		this._tokenCount = 0;
		this._pendingTokenEstimate = 0;
		this._nextCheckpointId = 0;
		this._systemPrompt = null;

		// Create empty file
		await Bun.write(this._filePath, "");
	}

	// ── Compact (clear and rotate) ─────────────────

	async compact(): Promise<void> {
		// Rotate old file (matches Python behavior: context.jsonl → context_1.jsonl)
		const file = Bun.file(this._filePath);
		if (await file.exists()) {
			const rotatedPath = nextAvailableRotation(this._filePath);
			if (rotatedPath) {
				const { rename } = await import("node:fs/promises");
				await rename(this._filePath, rotatedPath);
			}
		}

		// Clear state (matches Python: system_prompt is set to None)
		this._history = [];
		this._tokenCount = 0;
		this._pendingTokenEstimate = 0;
		this._nextCheckpointId = 0;
		this._systemPrompt = null;

		// Create empty file
		await Bun.write(this._filePath, "");
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
				// Support both Python format and legacy TS format
				if (
					(record.role === "_checkpoint" && record.id === checkpointId) ||
					("_checkpoint" in record && record._checkpoint?.id === checkpointId)
				) {
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

// ── Rotation helper (matches Python next_available_rotation) ──

/**
 * Given a file path like `/a/b/context.jsonl`, find the next available
 * rotation path: `context_1.jsonl`, `context_2.jsonl`, etc.
 */
function nextAvailableRotation(filePath: string): string | null {
	const dir = dirname(filePath);
	const ext = extname(filePath); // e.g. ".jsonl"
	const base = basename(filePath, ext); // e.g. "context"

	// Scan existing rotated files to find max N
	const pattern = new RegExp(
		`^${escapeRegExp(base)}_(\\d+)${escapeRegExp(ext)}$`,
	);
	let maxNum = 0;
	try {
		for (const entry of readdirSync(dir)) {
			const match = pattern.exec(entry);
			if (match) {
				maxNum = Math.max(maxNum, parseInt(match[1]!, 10));
			}
		}
	} catch {
		return null;
	}

	return join(dir, `${base}_${maxNum + 1}${ext}`);
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
