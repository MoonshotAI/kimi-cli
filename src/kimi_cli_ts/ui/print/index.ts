/**
 * Print mode — non-interactive output.
 * Corresponds to Python's ui/print/__init__.py + ui/print/visualize.py.
 *
 * Provides multiple printer strategies:
 * - TextPrinter: prints wire events as rich text
 * - JsonPrinter: outputs JSON messages with content merging
 * - FinalOnlyTextPrinter: only prints the final assistant text
 * - FinalOnlyJsonPrinter: only prints the final assistant message as JSON
 * - PrintMode: legacy event-based printer (wraps the above)
 */

import chalk from "chalk";
import type { WireUIEvent } from "../shell/events";

export type OutputFormat = "text" | "stream-json";

export interface PrintOptions {
	outputFormat: OutputFormat;
	finalOnly: boolean;
}

// ── Printer Protocol ────────────────────────────────────

export interface Printer {
	feed(event: WireUIEvent): void;
	flush(): void;
}

// ── Content Part Merging ────────────────────────────────

interface ContentBuffer {
	type: "text" | "think";
	text: string;
}

function mergeContent(buffer: ContentBuffer[], part: ContentBuffer): void {
	const last = buffer[buffer.length - 1];
	if (last && last.type === part.type) {
		last.text += part.text;
	} else {
		buffer.push({ ...part });
	}
}

// ── TextPrinter ─────────────────────────────────────────

export class TextPrinter implements Printer {
	feed(event: WireUIEvent): void {
		switch (event.type) {
			case "text_delta":
				process.stdout.write(event.text);
				break;
			case "think_delta":
				process.stdout.write(chalk.italic.grey(event.text));
				break;
			case "tool_call":
				process.stderr.write(
					chalk.dim(
						`[tool] ${event.name}(${truncateStr(event.arguments, 60)})\n`,
					),
				);
				break;
			case "tool_call_delta":
				// Streaming tool call args — ignore in text mode
				break;
			case "plan_display":
				process.stdout.write(
					chalk.blue.bold("📋 Plan") +
						chalk.grey(` (${(event as any).filePath})`) +
						"\n",
				);
				process.stdout.write((event as any).content + "\n");
				break;
			case "tool_result":
				if (event.result.return_value.isError) {
					process.stderr.write(
						chalk.red(
							`[error] ${truncateStr(event.result.return_value.output, 100)}\n`,
						),
					);
				}
				break;
			case "step_begin":
				break;
			case "step_interrupted":
				process.stderr.write(chalk.yellow("[interrupted]\n"));
				break;
			case "error":
				process.stderr.write(chalk.red(`Error: ${event.message}\n`));
				break;
			case "notification": {
				const sev = (event as any).severity;
				const prefix =
					sev === "error"
						? chalk.red("[error]")
						: sev === "warning"
							? chalk.yellow("[warn]")
							: chalk.dim(`[${event.title}]`);
				process.stderr.write(`${prefix} ${event.body}\n`);
				break;
			}
			case "turn_end":
				process.stdout.write("\n");
				break;
		}
	}

	flush(): void {}
}

// ── JsonPrinter ─────────────────────────────────────────

export class JsonPrinter implements Printer {
	private contentBuffer: ContentBuffer[] = [];
	private toolCalls: Array<{ id: string; name: string; arguments: string }> =
		[];
	private pendingNotifications: Array<{ title: string; body: string }> = [];

	feed(event: WireUIEvent): void {
		switch (event.type) {
			case "step_begin":
			case "step_interrupted":
				this.flush();
				break;
			case "notification":
				if (this.contentBuffer.length > 0 || this.toolCalls.length > 0) {
					this.pendingNotifications.push({
						title: event.title,
						body: event.body,
					});
				} else {
					this.flushAssistantMessage();
					this.flushNotifications();
					this.emitJson({
						type: "notification",
						title: event.title,
						body: event.body,
					});
				}
				break;
			case "text_delta":
				mergeContent(this.contentBuffer, { type: "text", text: event.text });
				break;
			case "think_delta":
				mergeContent(this.contentBuffer, { type: "think", text: event.text });
				break;
			case "tool_call":
				this.toolCalls.push({
					id: event.id,
					name: event.name,
					arguments: event.arguments,
				});
				break;
			case "tool_result":
				this.flushAssistantMessage();
				this.flushNotifications();
				this.emitJson({
					role: "tool",
					tool_call_id: event.toolCallId,
					content: event.result.return_value.output,
					is_error: event.result.return_value.isError,
				});
				break;
			case "plan_display":
				this.flushAssistantMessage();
				this.flushNotifications();
				this.emitJson({
					type: "plan_display",
					content: (event as any).content,
					file_path: (event as any).filePath,
				});
				break;
			case "error":
				process.stderr.write(chalk.red(`Error: ${event.message}\n`));
				break;
		}
	}

	private flushAssistantMessage(): void {
		if (this.contentBuffer.length === 0 && this.toolCalls.length === 0) return;
		const content = this.contentBuffer.map((part) => ({
			type: part.type,
			[part.type === "think" ? "think" : "text"]: part.text,
		}));
		const msg: Record<string, unknown> = { role: "assistant", content };
		if (this.toolCalls.length > 0) {
			msg.tool_calls = this.toolCalls.map((tc) => ({
				id: tc.id,
				type: "function",
				function: { name: tc.name, arguments: tc.arguments },
			}));
		}
		this.emitJson(msg);
		this.contentBuffer = [];
		this.toolCalls = [];
	}

	private flushNotifications(): void {
		for (const n of this.pendingNotifications) {
			this.emitJson({ type: "notification", ...n });
		}
		this.pendingNotifications = [];
	}

	private emitJson(data: Record<string, unknown>): void {
		process.stdout.write(JSON.stringify(data) + "\n");
	}

	flush(): void {
		this.flushAssistantMessage();
		this.flushNotifications();
	}
}

// ── FinalOnlyTextPrinter ────────────────────────────────

export class FinalOnlyTextPrinter implements Printer {
	private contentBuffer: ContentBuffer[] = [];

	feed(event: WireUIEvent): void {
		switch (event.type) {
			case "step_begin":
			case "step_interrupted":
				this.contentBuffer = [];
				break;
			case "text_delta":
				mergeContent(this.contentBuffer, { type: "text", text: event.text });
				break;
			case "error":
				process.stderr.write(chalk.red(`Error: ${event.message}\n`));
				break;
		}
	}

	flush(): void {
		const text = this.contentBuffer
			.filter((p) => p.type === "text")
			.map((p) => p.text)
			.join("");
		if (text) {
			process.stdout.write(text + "\n");
		}
		this.contentBuffer = [];
	}
}

// ── FinalOnlyJsonPrinter ────────────────────────────────

export class FinalOnlyJsonPrinter implements Printer {
	private contentBuffer: ContentBuffer[] = [];

	feed(event: WireUIEvent): void {
		switch (event.type) {
			case "step_begin":
			case "step_interrupted":
				this.contentBuffer = [];
				break;
			case "text_delta":
				mergeContent(this.contentBuffer, { type: "text", text: event.text });
				break;
			case "error":
				process.stderr.write(chalk.red(`Error: ${event.message}\n`));
				break;
		}
	}

	flush(): void {
		const text = this.contentBuffer
			.filter((p) => p.type === "text")
			.map((p) => p.text)
			.join("");
		if (text) {
			process.stdout.write(
				JSON.stringify({
					role: "assistant",
					content: [{ type: "text", text }],
				}) + "\n",
			);
		}
		this.contentBuffer = [];
	}
}

// ── StreamJsonPrinter ──────────────────────────────────

export class StreamJsonPrinter implements Printer {
	feed(event: WireUIEvent): void {
		switch (event.type) {
			case "text_delta":
			case "think_delta":
			case "tool_call":
			case "tool_result":
			case "notification":
			case "step_begin":
			case "step_interrupted":
			case "turn_end":
				this.emitJson(event as unknown as Record<string, unknown>);
				break;
			case "error":
				process.stderr.write(chalk.red(`Error: ${(event as any).message}\n`));
				break;
		}
	}

	private emitJson(data: Record<string, unknown>): void {
		process.stdout.write(JSON.stringify(data) + "\n");
	}

	flush(): void {}
}

// ── FinalOnlyStreamJsonPrinter ────────────────────────

export class FinalOnlyStreamJsonPrinter implements Printer {
	private textBuffer = "";

	feed(event: WireUIEvent): void {
		switch (event.type) {
			case "text_delta":
				this.textBuffer += event.text;
				break;
			case "step_begin":
			case "step_interrupted":
				this.textBuffer = "";
				break;
			case "error":
				process.stderr.write(chalk.red(`Error: ${(event as any).message}\n`));
				break;
		}
	}

	flush(): void {
		if (this.textBuffer) {
			process.stdout.write(
				JSON.stringify({ type: "final_text", text: this.textBuffer }) + "\n",
			);
		}
		this.textBuffer = "";
	}
}

// ── Factory ─────────────────────────────────────────────

export function createPrinter(options: PrintOptions): Printer {
	if (options.finalOnly) {
		return options.outputFormat === "text"
			? new FinalOnlyTextPrinter()
			: new FinalOnlyStreamJsonPrinter();
	}
	return options.outputFormat === "text"
		? new TextPrinter()
		: new StreamJsonPrinter();
}

// ── Legacy PrintMode (wraps Printer) ────────────────────

export class PrintMode {
	private printer: Printer;

	constructor(options: PrintOptions) {
		this.printer = createPrinter(options);
	}

	handleEvent(event: WireUIEvent): void {
		this.printer.feed(event);
		if (event.type === "turn_end") {
			this.printer.flush();
		}
	}

	flush(): void {
		this.printer.flush();
	}
}

/**
 * Classify error for exit codes.
 */
export function classifyError(
	error: unknown,
): "retryable" | "permanent" | "unknown" {
	if (error instanceof Error) {
		const msg = error.message.toLowerCase();
		if (
			msg.includes("429") ||
			msg.includes("500") ||
			msg.includes("502") ||
			msg.includes("503") ||
			msg.includes("504") ||
			msg.includes("timeout") ||
			msg.includes("connection")
		) {
			return "retryable";
		}
		return "permanent";
	}
	return "unknown";
}

// ── Stream-JSON Input Parser ─────────────────────────────

/**
 * Parse a stream-json input line into a user command.
 * Returns null if the line is invalid or non-user role.
 * Corresponds to Python Print._read_next_command().
 */
export function parseStreamJsonInput(jsonLine: string): string | null {
	const trimmed = jsonLine.trim();
	if (!trimmed) return null;

	try {
		const data = JSON.parse(trimmed);
		if (!data || typeof data !== "object") return null;

		// Expect { role: "user", content: "..." } or { role: "user", content: [...] }
		if (data.role !== "user") return null;

		if (typeof data.content === "string") {
			return data.content;
		}

		if (Array.isArray(data.content)) {
			// Extract text parts and join
			const texts: string[] = [];
			for (const part of data.content) {
				if (
					part &&
					typeof part === "object" &&
					part.type === "text" &&
					typeof part.text === "string"
				) {
					texts.push(part.text);
				}
			}
			return texts.length > 0 ? texts.join("\n") : null;
		}

		return null;
	} catch {
		return null;
	}
}

/**
 * Read stream-json lines from a ReadableStream, yielding user commands.
 * Corresponds to the Python Print._read_next_command loop.
 */
export async function* readStreamJsonInput(
	input: ReadableStream<Uint8Array> | AsyncIterable<string>,
): AsyncGenerator<string> {
	let buffer = "";

	if ("getReader" in input) {
		const reader = (input as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					const command = parseStreamJsonInput(line);
					if (command) yield command;
				}
			}
			// Process remaining buffer
			if (buffer.trim()) {
				const command = parseStreamJsonInput(buffer);
				if (command) yield command;
			}
		} finally {
			reader.releaseLock();
		}
	} else {
		for await (const line of input as AsyncIterable<string>) {
			const command = parseStreamJsonInput(line);
			if (command) yield command;
		}
	}
}

// ── Exit Codes ──────────────────────────────────────────────

export const ExitCode = {
	SUCCESS: 0,
	FAILURE: 1,
	RETRYABLE: 2,
} as const;

function truncateStr(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return text.slice(0, maxLen) + "…";
}
