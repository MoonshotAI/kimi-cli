/**
 * Tool-related types — corresponds to Python tools/utils.py and kosong.tooling types.
 */

import type { ApprovalDecisionResult, JsonValue } from "../types.ts";
import type { Runtime } from "../soul/agent.ts";
import type { OAuthRef } from "../config.ts";

// ── ToolContext ──────────────────────────────────────────

/** Context injected into every tool execution. */
export interface ToolContext {
	/** Current working directory. */
	workingDir: string;
	/** AbortSignal for cooperative cancellation. */
	signal?: AbortSignal;
	/** Request user approval; returns the decision and optional feedback. */
	approval: (
		toolName: string,
		action: string,
		summary: string,
		opts?: { display?: unknown[] },
	) => Promise<ApprovalDecisionResult>;
	/** Emit a wire event (for UI communication). */
	wireEmit?: (event: unknown) => void;
	/** Toggle plan mode on/off. */
	setPlanMode?: (on: boolean) => void;
	/** Get current plan mode status. */
	getPlanMode?: () => boolean;
	/** Get plan file path. */
	getPlanFilePath?: () => string | undefined;
	/** Toggle plan mode (manual toggle from slash command). */
	togglePlanMode?: () => void;
	/** Ask the user a question and get the answer (for AskUserQuestion tool). */
	askUser?: (question: string, options?: string[]) => Promise<string>;
	/** Access to service config (for SearchWeb, FetchURL). */
	serviceConfig?: {
		moonshotSearch?: {
			baseUrl: string;
			apiKey: string;
			customHeaders?: Record<string, string>;
			oauth?: OAuthRef;
		};
		moonshotFetch?: {
			baseUrl: string;
			apiKey: string;
			customHeaders?: Record<string, string>;
			oauth?: OAuthRef;
		};
	};
	/** Runtime reference for tools that need full runtime access (e.g. Agent tool). */
	runtime?: Runtime;
}

// ── ToolResult ──────────────────────────────────────────

export interface ToolResult {
	isError: boolean;
	output: string;
	message?: string;
	display?: unknown[];
	extras?: Record<string, JsonValue>;
}

/** Create a successful ToolResult. */
export function ToolOk(
	output: string,
	message?: string,
	display?: unknown[],
	extras?: Record<string, JsonValue>,
): ToolResult {
	return { isError: false, output, message, display, extras };
}

/** Create an error ToolResult. */
export function ToolError(
	message: string,
	output = "",
	display?: unknown[],
	extras?: Record<string, JsonValue>,
): ToolResult {
	return { isError: true, output, message, display, extras };
}

// ── ToolDefinition ──────────────────────────────────────

export interface ToolDefinition {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

// ── ToolResultBuilder ───────────────────────────────────

const DEFAULT_MAX_CHARS = 50_000;
const DEFAULT_MAX_LINE_LENGTH = 2000;

function truncateLine(line: string, maxLength: number, marker = "..."): string {
	if (line.length <= maxLength) return line;

	// Find trailing line breaks
	const m = line.match(/[\r\n]+$/);
	const linebreak = m ? m[0] : "";
	const end = marker + linebreak;
	const effectiveMax = Math.max(maxLength, end.length);
	return line.slice(0, effectiveMax - end.length) + end;
}

export class ToolResultBuilder {
	private maxChars: number;
	private maxLineLength: number | null;
	private marker = "[...truncated]";
	private buffer: string[] = [];
	private _nChars = 0;
	private _nLines = 0;
	private _truncationHappened = false;
	private _display: unknown[] = [];
	private _extras: Record<string, JsonValue> | null = null;

	constructor(
		maxChars = DEFAULT_MAX_CHARS,
		maxLineLength: number | null = DEFAULT_MAX_LINE_LENGTH,
	) {
		this.maxChars = maxChars;
		this.maxLineLength = maxLineLength;
	}

	get isFull(): boolean {
		return this._nChars >= this.maxChars;
	}

	get nChars(): number {
		return this._nChars;
	}

	get nLines(): number {
		return this._nLines;
	}

	/** Write text to the output buffer. Returns number of characters written. */
	write(text: string): number {
		if (this.isFull) return 0;

		// Split keeping line endings
		const lines = text.split(/(?<=\n)/);
		if (lines.length === 0) return 0;

		let charsWritten = 0;

		for (const originalLine of lines) {
			if (this.isFull) break;
			if (!originalLine) continue;

			const remainingChars = this.maxChars - this._nChars;
			const limit =
				this.maxLineLength !== null
					? Math.min(remainingChars, this.maxLineLength)
					: remainingChars;
			const line = truncateLine(originalLine, limit, this.marker);
			if (line !== originalLine) {
				this._truncationHappened = true;
			}

			this.buffer.push(line);
			charsWritten += line.length;
			this._nChars += line.length;
			if (line.endsWith("\n")) {
				this._nLines += 1;
			}
		}

		return charsWritten;
	}

	display(...blocks: unknown[]): void {
		this._display.push(...blocks);
	}

	extras(extra: Record<string, JsonValue>): void {
		if (this._extras === null) {
			this._extras = {};
		}
		Object.assign(this._extras, extra);
	}

	ok(message = ""): ToolResult {
		const output = this.buffer.join("");

		let finalMessage = message;
		if (finalMessage && !finalMessage.endsWith(".")) {
			finalMessage += ".";
		}
		const truncationMsg = "Output is truncated to fit in the message.";
		if (this._truncationHappened) {
			finalMessage = finalMessage
				? `${finalMessage} ${truncationMsg}`
				: truncationMsg;
		}
		return {
			isError: false,
			output,
			message: finalMessage || undefined,
			display: this._display.length > 0 ? this._display : undefined,
			extras: this._extras ?? undefined,
		};
	}

	error(message: string): ToolResult {
		const output = this.buffer.join("");

		let finalMessage = message;
		if (this._truncationHappened) {
			const truncationMsg = "Output is truncated to fit in the message.";
			finalMessage = finalMessage
				? `${finalMessage} ${truncationMsg}`
				: truncationMsg;
		}

		return {
			isError: true,
			output,
			message: finalMessage,
			display: this._display.length > 0 ? this._display : undefined,
			extras: this._extras ?? undefined,
		};
	}
}

// ── ToolRejectedError ───────────────────────────────

/**
 * Thrown / returned when a tool call is rejected by the user.
 * Corresponds to Python utils.ToolRejectedError.
 */
export class ToolRejectedError extends Error {
	readonly isError = true as const;
	readonly hasFeedback: boolean;
	readonly brief: string;

	constructor(opts?: {
		message?: string;
		brief?: string;
		hasFeedback?: boolean;
	}) {
		super(
			opts?.message ??
				"The tool call is rejected by the user. " +
					"Stop what you are doing and wait for the user to tell you how to proceed.",
		);
		this.name = "ToolRejectedError";
		this.brief = opts?.brief ?? "Rejected by user";
		this.hasFeedback = opts?.hasFeedback ?? false;
	}

	/** Convert to a ToolResult for returning from a tool handler. */
	toToolResult(): ToolResult {
		return {
			isError: true,
			output: "",
			message: this.message,
			display: [{ type: "brief" as const, brief: this.brief }],
			extras: this.hasFeedback ? { userFeedback: true } : undefined,
		};
	}
}

// ── SkipThisTool ────────────────────────────────────

/**
 * Thrown when a tool decides to skip itself from the loading process.
 * Corresponds to Python __init__.SkipThisTool.
 */
export class SkipThisTool extends Error {
	constructor(reason?: string) {
		super(reason ?? "Tool skipped");
		this.name = "SkipThisTool";
	}
}

// ── extractKeyArgument ──────────────────────────────

/**
 * Extract a key argument string from tool call JSON arguments.
 * Used for logging / display summaries.
 * Corresponds to Python __init__.extract_key_argument.
 */
export function extractKeyArgument(
	jsonContent: string,
	toolName: string,
): string | null {
	let args: Record<string, unknown>;
	try {
		args = JSON.parse(jsonContent);
	} catch {
		return null;
	}
	if (!args || typeof args !== "object") return null;

	let keyArg = "";

	switch (toolName) {
		case "Agent":
			if (!args.description) return null;
			keyArg = String(args.description);
			break;
		case "SendDMail":
		case "SetTodoList":
			return null;
		case "Think":
			if (!args.thought) return null;
			keyArg = String(args.thought);
			break;
		case "Shell":
			if (!args.command) return null;
			keyArg = String(args.command);
			break;
		case "TaskOutput":
		case "TaskStop":
			if (!args.task_id) return null;
			keyArg = String(args.task_id);
			break;
		case "TaskList":
			keyArg = args.active_only !== false ? "active" : "all";
			break;
		case "ReadFile":
		case "ReadMediaFile":
		case "WriteFile":
		case "StrReplaceFile":
			if (!args.path) return null;
			keyArg = _normalizePath(String(args.path));
			break;
		case "Glob":
		case "Grep":
			if (!args.pattern) return null;
			keyArg = String(args.pattern);
			break;
		case "SearchWeb":
			if (!args.query) return null;
			keyArg = String(args.query);
			break;
		case "FetchURL":
			if (!args.url) return null;
			keyArg = String(args.url);
			break;
		default:
			keyArg = jsonContent;
	}

	return _shortenMiddle(keyArg, 50);
}

function _normalizePath(path: string): string {
	const cwd = process.cwd();
	if (path.startsWith(cwd)) {
		path = path.slice(cwd.length).replace(/^[/\\]/, "");
	}
	return path;
}

function _shortenMiddle(s: string, width: number): string {
	if (s.length <= width) return s;
	const half = Math.floor((width - 3) / 2);
	return s.slice(0, half) + "..." + s.slice(s.length - half);
}
