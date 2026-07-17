/**
 * Export utilities — corresponds to Python utils/export.py
 * Session export to markdown format.
 */

import { join, resolve } from "node:path";
import {
	existsSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	statSync,
} from "node:fs";
import type { ContentPart, Message, ToolCallInfo } from "./message.ts";
import { messageStringify } from "./message.ts";

// ── Export helpers ──

const HINT_KEYS = [
	"path",
	"file_path",
	"command",
	"query",
	"url",
	"name",
	"pattern",
];

function extractToolCallHint(argsJson: string): string {
	try {
		const parsed = JSON.parse(argsJson);
		if (typeof parsed !== "object" || parsed === null) return "";
		const args = parsed as Record<string, unknown>;

		// Prefer well-known keys
		for (const key of HINT_KEYS) {
			const val = args[key];
			if (typeof val === "string" && val.trim()) {
				return val.length > 60 ? val.slice(0, 57) + "…" : val;
			}
		}

		// Fallback: first short string value
		for (const val of Object.values(args)) {
			if (typeof val === "string" && val.length > 0 && val.length <= 80) {
				return val.length > 60 ? val.slice(0, 57) + "…" : val;
			}
		}
	} catch {
		// ignore
	}
	return "";
}

function formatContentPartMd(part: ContentPart): string {
	if (part.type === "text" && part.text) return part.text;
	if (part.type === "think" && part.think) {
		if (!part.think.trim()) return "";
		return `<details><summary>Thinking</summary>\n\n${part.think}\n\n</details>`;
	}
	if (part.type === "image_url") return "[image]";
	if (part.type === "audio_url") return "[audio]";
	if (part.type === "video_url") return "[video]";
	return `[${part.type}]`;
}

function formatToolCallMd(tc: ToolCallInfo): string {
	const argsRaw = tc.function.arguments || "{}";
	const hint = extractToolCallHint(argsRaw);
	let title = `#### Tool Call: ${tc.function.name}`;
	if (hint) title += ` (\`${hint}\`)`;

	let argsFormatted: string;
	try {
		const parsed = JSON.parse(argsRaw);
		argsFormatted = JSON.stringify(parsed, null, 2);
	} catch {
		argsFormatted = argsRaw;
	}

	return `${title}\n<!-- call_id: ${tc.id} -->\n\`\`\`json\n${argsFormatted}\n\`\`\``;
}

function formatToolResultMd(
	msg: Message,
	toolName: string,
	hint: string,
): string {
	const callId = msg.tool_call_id || "unknown";
	const resultParts: string[] = [];
	for (const part of msg.content) {
		const text = formatContentPartMd(part);
		if (text.trim()) resultParts.push(text);
	}
	const resultText = resultParts.join("\n");

	let summary = `Tool Result: ${toolName}`;
	if (hint) summary += ` (\`${hint}\`)`;

	return (
		`<details><summary>${summary}</summary>\n\n` +
		`<!-- call_id: ${callId} -->\n` +
		`${resultText}\n\n` +
		`</details>`
	);
}

function isInternalUserMessage(msg: Message): boolean {
	if (msg.role !== "user" || msg.content.length !== 1) return false;
	const part = msg.content[0]!;
	return (
		part.type === "text" && (part.text ?? "").trim().startsWith("<system>")
	);
}

function groupIntoTurns(history: Message[]): Message[][] {
	const turns: Message[][] = [];
	let current: Message[] = [];

	for (const msg of history) {
		if (isInternalUserMessage(msg)) continue;
		if (msg.role === "user" && current.length > 0) {
			turns.push(current);
			current = [];
		}
		current.push(msg);
	}
	if (current.length > 0) turns.push(current);
	return turns;
}

function formatTurnMd(messages: Message[], turnNumber: number): string {
	const lines = [`## Turn ${turnNumber}`, ""];
	const toolCallInfo: Record<string, [string, string]> = {};
	let assistantHeaderWritten = false;

	for (const msg of messages) {
		if (isInternalUserMessage(msg)) continue;

		if (msg.role === "user") {
			lines.push("### User", "");
			for (const part of msg.content) {
				const text = formatContentPartMd(part);
				if (text.trim()) {
					lines.push(text, "");
				}
			}
		} else if (msg.role === "assistant") {
			if (!assistantHeaderWritten) {
				lines.push("### Assistant", "");
				assistantHeaderWritten = true;
			}
			for (const part of msg.content) {
				const text = formatContentPartMd(part);
				if (text.trim()) {
					lines.push(text, "");
				}
			}
			if (msg.tool_calls) {
				for (const tc of msg.tool_calls) {
					const hint = extractToolCallHint(tc.function.arguments || "{}");
					toolCallInfo[tc.id] = [tc.function.name, hint];
					lines.push(formatToolCallMd(tc), "");
				}
			}
		} else if (msg.role === "tool") {
			const tcId = msg.tool_call_id || "";
			const [name, hint] = toolCallInfo[tcId] ?? ["unknown", ""];
			lines.push(formatToolResultMd(msg, name, hint), "");
		} else if (msg.role === "system" || msg.role === "developer") {
			lines.push(
				`### ${msg.role.charAt(0).toUpperCase() + msg.role.slice(1)}`,
				"",
			);
			for (const part of msg.content) {
				const text = formatContentPartMd(part);
				if (text.trim()) {
					lines.push(text, "");
				}
			}
		}
	}
	return lines.join("\n");
}

function buildOverview(
	history: Message[],
	turns: Message[][],
	tokenCount: number,
): string {
	let topic = "";
	for (const msg of history) {
		if (msg.role === "user" && !isInternalUserMessage(msg)) {
			const full = messageStringify(msg);
			topic = full.length > 80 ? full.slice(0, 77) + "…" : full;
			break;
		}
	}

	const nToolCalls = history.reduce(
		(sum, msg) => sum + (msg.tool_calls?.length ?? 0),
		0,
	);

	return [
		"## Overview",
		"",
		topic ? `- **Topic**: ${topic}` : "- **Topic**: (empty)",
		`- **Conversation**: ${turns.length} turns | ${nToolCalls} tool calls | ${tokenCount.toLocaleString()} tokens`,
		"",
		"---",
	].join("\n");
}

/**
 * Build the full export markdown string.
 */
export function buildExportMarkdown(opts: {
	sessionId: string;
	workDir: string;
	history: Message[];
	tokenCount: number;
	now: Date;
}): string {
	const { sessionId, workDir, history, tokenCount, now } = opts;
	const lines = [
		"---",
		`session_id: ${sessionId}`,
		`exported_at: ${now.toISOString()}`,
		`work_dir: ${workDir}`,
		`message_count: ${history.length}`,
		`token_count: ${tokenCount}`,
		"---",
		"",
		"# Kimi Session Export",
		"",
	];

	const turns = groupIntoTurns(history);
	lines.push(buildOverview(history, turns, tokenCount));
	lines.push("");

	for (let i = 0; i < turns.length; i++) {
		lines.push(formatTurnMd(turns[i]!, i + 1));
	}

	return lines.join("\n");
}

// ── Import helpers ──

const IMPORTABLE_EXTENSIONS = new Set([
	".md",
	".markdown",
	".txt",
	".text",
	".rst",
	".json",
	".jsonl",
	".yaml",
	".yml",
	".toml",
	".ini",
	".cfg",
	".conf",
	".csv",
	".tsv",
	".xml",
	".env",
	".properties",
	".py",
	".js",
	".ts",
	".jsx",
	".tsx",
	".java",
	".kt",
	".go",
	".rs",
	".c",
	".cpp",
	".h",
	".hpp",
	".cs",
	".rb",
	".php",
	".swift",
	".scala",
	".sh",
	".bash",
	".zsh",
	".fish",
	".ps1",
	".bat",
	".cmd",
	".r",
	".R",
	".lua",
	".pl",
	".pm",
	".ex",
	".exs",
	".erl",
	".hs",
	".ml",
	".sql",
	".graphql",
	".proto",
	".html",
	".htm",
	".css",
	".scss",
	".sass",
	".less",
	".svg",
	".log",
	".tex",
	".bib",
	".org",
	".adoc",
	".wiki",
]);

/**
 * Check if a file path has an importable extension.
 */
export function isImportableFile(pathStr: string): boolean {
	const lastDot = pathStr.lastIndexOf(".");
	if (lastDot === -1) return true; // No extension = ok
	const suffix = pathStr.slice(lastDot).toLowerCase();
	return IMPORTABLE_EXTENSIONS.has(suffix);
}

export const MAX_IMPORT_SIZE = 10 * 1024 * 1024; // 10 MB

const SENSITIVE_FILE_PATTERNS = [
	".env",
	"credentials",
	"secrets",
	".pem",
	".key",
	".p12",
	".pfx",
	".keystore",
];

/**
 * Check if a filename looks like it may contain secrets.
 */
export function isSensitiveFile(filename: string): boolean {
	const name = filename.toLowerCase();
	return SENSITIVE_FILE_PATTERNS.some((pat) => name.includes(pat));
}
