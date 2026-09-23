/**
 * useInputHistory hook — manages input history and slash command parsing.
 * Corresponds to history logic in Python's prompt.py.
 *
 * History is persisted per-working-directory to ~/.kimi/user-history/{md5(cwd)}.jsonl
 * matching the Python implementation's behaviour.
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { getShareDir } from "../../config.ts";
import type { SlashCommand } from "../../types";

// ── Persistent history helpers ─────────────────────────────

interface HistoryEntry {
	content: string;
}

function getHistoryDir(): string {
	return join(getShareDir(), "user-history");
}

function getHistoryFile(): string {
	const cwd = process.cwd();
	const hash = createHash("md5").update(cwd, "utf-8").digest("hex");
	return join(getHistoryDir(), `${hash}.jsonl`);
}

/** Load history entries from the JSONL file (sync, called once on mount). */
function loadHistoryEntries(filePath: string): string[] {
	try {
		const file = Bun.file(filePath);
		// Bun.file doesn't have a sync exists check, use node:fs
		const fs = require("node:fs");
		if (!fs.existsSync(filePath)) return [];
		const text = fs.readFileSync(filePath, "utf-8") as string;
		const entries: string[] = [];
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const parsed = JSON.parse(trimmed) as HistoryEntry;
				if (parsed.content) {
					entries.push(parsed.content);
				}
			} catch {
				// Skip malformed lines
			}
		}
		return entries;
	} catch {
		return [];
	}
}

/** Append a single history entry to the JSONL file. */
function appendHistoryEntry(filePath: string, content: string): void {
	try {
		const fs = require("node:fs");
		const dir = getHistoryDir();
		fs.mkdirSync(dir, { recursive: true });
		const entry: HistoryEntry = { content };
		fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
	} catch {
		// Silently ignore write failures (matches Python behaviour)
	}
}

// ── Hook ───────────────────────────────────────────────────

export interface InputHistoryState {
	/** Current input value */
	value: string;
	/** Set input value */
	setValue: (v: string) => void;
	/** Navigate to previous history entry */
	historyPrev: () => void;
	/** Navigate to next history entry */
	historyNext: () => void;
	/** Add current value to history */
	addToHistory: (entry: string) => void;
	/** True when navigating history (arrow up/down) */
	isBrowsingHistory: boolean;
	/** Exit history browsing mode (call on any edit) */
	exitHistory: () => void;
	/** Check if current input is a slash command */
	isSlashCommand: boolean;
	/** Parse slash command name and args */
	parseSlashCommand: () => { name: string; args: string } | null;
}

/**
 * Hook for input history management and slash command parsing.
 */
export function useInputHistory(maxHistory = 100): InputHistoryState {
	const [value, setValue] = useState("");
	const history = useRef<string[]>([]);
	const historyIndex = useRef(-1);
	const savedInput = useRef("");
	const historyFile = useRef(getHistoryFile());
	const lastHistoryContent = useRef("");
	const initialized = useRef(false);

	// Load persisted history on first mount
	useEffect(() => {
		if (initialized.current) return;
		initialized.current = true;
		const entries = loadHistoryEntries(historyFile.current);
		history.current = entries;
		if (entries.length > 0) {
			lastHistoryContent.current = entries[entries.length - 1]!;
		}
	}, []);

	const addToHistory = useCallback(
		(entry: string) => {
			const trimmed = entry.trim();
			if (!trimmed) return;
			// Deduplicate consecutive entries
			if (
				history.current.length > 0 &&
				history.current[history.current.length - 1] === trimmed
			) {
				// Already the last entry — skip
			} else {
				history.current.push(trimmed);
				if (history.current.length > maxHistory) {
					history.current.shift();
				}
				// Persist to disk (only if different from last persisted)
				if (trimmed !== lastHistoryContent.current) {
					appendHistoryEntry(historyFile.current, trimmed);
					lastHistoryContent.current = trimmed;
				}
			}
			historyIndex.current = -1;
			savedInput.current = "";
		},
		[maxHistory],
	);

	const historyPrev = useCallback(() => {
		if (history.current.length === 0) return;
		if (historyIndex.current === -1) {
			savedInput.current = value;
			historyIndex.current = history.current.length - 1;
		} else if (historyIndex.current > 0) {
			historyIndex.current -= 1;
		}
		setValue(history.current[historyIndex.current] ?? "");
	}, [value]);

	const historyNext = useCallback(() => {
		if (historyIndex.current === -1) return;
		if (historyIndex.current < history.current.length - 1) {
			historyIndex.current += 1;
			setValue(history.current[historyIndex.current] ?? "");
		} else {
			historyIndex.current = -1;
			setValue(savedInput.current);
		}
	}, []);

	const exitHistory = useCallback(() => {
		if (historyIndex.current !== -1) {
			historyIndex.current = -1;
			savedInput.current = "";
		}
	}, []);

	const isSlashCommand = value.startsWith("/");

	const parseSlashCommand = useCallback(() => {
		if (!value.startsWith("/")) return null;
		const trimmed = value.slice(1).trim();
		const spaceIdx = trimmed.indexOf(" ");
		if (spaceIdx === -1) {
			return { name: trimmed, args: "" };
		}
		return {
			name: trimmed.slice(0, spaceIdx),
			args: trimmed.slice(spaceIdx + 1).trim(),
		};
	}, [value]);

	return {
		value,
		setValue,
		historyPrev,
		historyNext,
		addToHistory,
		isBrowsingHistory: historyIndex.current !== -1,
		exitHistory,
		isSlashCommand,
		parseSlashCommand,
	};
}
