/**
 * Session fork utilities — corresponds to Python session_fork.py.
 *
 * Provides turn enumeration, wire/context truncation, and session forking
 * for CLI slash commands (/undo, /fork).
 */

import { join } from "node:path";
import {
	existsSync,
	readFileSync,
	mkdirSync,
	writeFileSync,
	copyFileSync,
	readdirSync,
	statSync,
} from "node:fs";
import { Session, loadSessionState, saveSessionState } from "./session.ts";

const CHECKPOINT_USER_PATTERN = /^<system>CHECKPOINT \d+<\/system>$/;

// ── Turn info ───────────────────────────────────────

export interface TurnInfo {
	/** 0-based turn index. */
	index: number;
	/** First-line text of the user message. */
	userText: string;
}

// ── Turn enumeration ────────────────────────────────

/**
 * Scan wire.jsonl and return a list of all turns with user message text.
 */
export function enumerateTurns(wirePath: string): TurnInfo[] {
	if (!existsSync(wirePath)) return [];

	const content = readFileSync(wirePath, "utf-8");
	const turns: TurnInfo[] = [];
	let currentTurn = -1;

	for (const line of content.split("\n")) {
		const stripped = line.trim();
		if (!stripped) continue;

		let record: any;
		try {
			record = JSON.parse(stripped);
		} catch {
			continue;
		}

		if (record.type === "metadata") continue;

		const message = record.message ?? {};
		const msgType: string | undefined = message.type;

		if (msgType === "TurnBegin") {
			currentTurn++;
			const userInput = message.payload?.user_input ?? "";
			const text = extractUserText(userInput);
			turns.push({ index: currentTurn, userText: text });
		}
	}

	return turns;
}

function extractUserText(userInput: string | any[]): string {
	if (typeof userInput === "string") return userInput;

	const parts: string[] = [];
	for (const part of userInput) {
		if (
			typeof part === "object" &&
			part !== null &&
			typeof part.text === "string"
		) {
			parts.push(part.text);
		} else if (typeof part === "string") {
			parts.push(part);
		}
	}
	return parts.join(" ");
}

// ── Wire / context truncation ───────────────────────

/**
 * Read wire.jsonl and return all lines up to and including the given turn.
 */
export function truncateWireAtTurn(
	wirePath: string,
	turnIndex: number,
): string[] {
	if (!existsSync(wirePath)) {
		throw new Error("wire.jsonl not found");
	}

	const content = readFileSync(wirePath, "utf-8");
	const lines: string[] = [];
	let currentTurn = -1;

	for (const line of content.split("\n")) {
		const stripped = line.trim();
		if (!stripped) continue;

		let record: any;
		try {
			record = JSON.parse(stripped);
		} catch {
			continue;
		}

		// Always keep metadata header
		if (record.type === "metadata") {
			lines.push(stripped);
			continue;
		}

		const message = record.message ?? {};
		const msgType: string | undefined = message.type;

		if (msgType === "TurnBegin") {
			currentTurn++;
			if (currentTurn > turnIndex) break;
		}

		if (currentTurn <= turnIndex) {
			lines.push(stripped);
		}

		// Stop after the TurnEnd of the target turn
		if (msgType === "TurnEnd" && currentTurn === turnIndex) {
			break;
		}
	}

	if (currentTurn < turnIndex) {
		throw new Error(
			`turn_index ${turnIndex} out of range (max turn: ${currentTurn})`,
		);
	}

	return lines;
}

function isCheckpointUserMessage(record: any): boolean {
	if (record.role !== "user") return false;

	const content = record.content;
	if (typeof content === "string") {
		return CHECKPOINT_USER_PATTERN.test(content.trim());
	}

	if (
		Array.isArray(content) &&
		content.length === 1 &&
		typeof content[0] === "object"
	) {
		const text = content[0].text;
		if (typeof text === "string") {
			return CHECKPOINT_USER_PATTERN.test(text.trim());
		}
	}

	return false;
}

/**
 * Read context.jsonl and return all lines up to and including the given turn.
 * Best-effort: if context has fewer user turns, returns all available lines.
 */
export function truncateContextAtTurn(
	contextPath: string,
	turnIndex: number,
): string[] {
	if (!existsSync(contextPath)) return [];

	const content = readFileSync(contextPath, "utf-8");
	const lines: string[] = [];
	let currentTurn = -1;

	for (const line of content.split("\n")) {
		const stripped = line.trim();
		if (!stripped) continue;

		let record: any;
		try {
			record = JSON.parse(stripped);
		} catch {
			continue;
		}

		if (record.role === "user" && !isCheckpointUserMessage(record)) {
			currentTurn++;
			if (currentTurn > turnIndex) break;
		}

		if (currentTurn <= turnIndex) {
			lines.push(stripped);
		}
	}

	return lines;
}

// ── Full fork operation ─────────────────────────────

/**
 * Fork a session, creating a new session with history up to the given turn.
 *
 * @param sourceSessionDir - Path to the source session directory.
 * @param workDir - The work directory.
 * @param turnIndex - 0-based turn index (inclusive). If undefined, copy all turns.
 * @param titlePrefix - Prefix for the forked session title.
 * @param sourceTitle - Title of the source session.
 * @returns The new session ID.
 */
export async function forkSession(opts: {
	sourceSessionDir: string;
	workDir: string;
	turnIndex?: number;
	titlePrefix?: string;
	sourceTitle?: string;
}): Promise<string> {
	const { sourceSessionDir, workDir, turnIndex, titlePrefix = "Fork" } = opts;

	const wirePath = join(sourceSessionDir, "wire.jsonl");
	const contextPath = join(sourceSessionDir, "context.jsonl");

	let truncatedWireLines: string[];
	let truncatedContextLines: string[];

	if (turnIndex !== undefined) {
		truncatedWireLines = truncateWireAtTurn(wirePath, turnIndex);
		truncatedContextLines = truncateContextAtTurn(contextPath, turnIndex);
	} else {
		truncatedWireLines = readAllLines(wirePath);
		truncatedContextLines = readAllLines(contextPath);
	}

	const newSession = await Session.create(workDir);
	const newSessionDir = newSession.dir;

	// Copy referenced video files
	copyReferencedVideos(sourceSessionDir, newSessionDir, truncatedWireLines);

	// Write truncated wire.jsonl
	const newWirePath = join(newSessionDir, "wire.jsonl");
	writeFileSync(newWirePath, truncatedWireLines.join("\n") + "\n", "utf-8");

	// Write truncated context.jsonl (overwrites the empty file from create())
	const newContextPath = join(newSessionDir, "context.jsonl");
	writeFileSync(
		newContextPath,
		truncatedContextLines.join("\n") + "\n",
		"utf-8",
	);

	// Set title
	let sourceTitle = opts.sourceTitle;
	if (sourceTitle === undefined) {
		const srcState = await loadSessionState(sourceSessionDir);
		sourceTitle = srcState.custom_title ?? "Untitled";
	}

	const forkTitle = `${titlePrefix}: ${sourceTitle}`;
	const newState = await loadSessionState(newSessionDir);
	newState.custom_title = forkTitle;
	newState.title_generated = true;

	try {
		const stat = statSync(newWirePath);
		newState.wire_mtime = stat.mtimeMs / 1000;
	} catch {
		// ignore
	}

	await saveSessionState(newState, newSessionDir);
	return newSession.id;
}

function readAllLines(path: string): string[] {
	if (!existsSync(path)) return [];
	const content = readFileSync(path, "utf-8");
	return content
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
}

function copyReferencedVideos(
	sourceDir: string,
	newSessionDir: string,
	wireLines: string[],
): void {
	const sourceUploads = join(sourceDir, "uploads");
	if (!existsSync(sourceUploads)) return;

	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(sourceUploads);
		if (!stat.isDirectory()) return;
	} catch {
		return;
	}

	const videoPattern = /uploads\/([^"\\<>\s]+)/g;
	const referencedVideos = new Set<string>();

	for (const line of wireLines) {
		let match: RegExpExecArray | null;
		while ((match = videoPattern.exec(line)) !== null) {
			const fname = match[1]!;
			const ext = fname.split(".").pop()?.toLowerCase() ?? "";
			if (["mp4", "webm", "mkv", "mov", "avi"].includes(ext)) {
				referencedVideos.add(fname);
			}
		}
	}

	const filesToCopy = [...referencedVideos].filter((name) => {
		try {
			return statSync(join(sourceUploads, name)).isFile();
		} catch {
			return false;
		}
	});

	if (filesToCopy.length > 0) {
		const newUploads = join(newSessionDir, "uploads");
		mkdirSync(newUploads, { recursive: true });
		const copiedNames: string[] = [];
		for (const vf of filesToCopy) {
			copyFileSync(join(sourceUploads, vf), join(newUploads, vf));
			copiedNames.push(vf);
		}
		writeFileSync(
			join(newUploads, ".sent"),
			JSON.stringify(copiedNames),
			"utf-8",
		);
	}
}
