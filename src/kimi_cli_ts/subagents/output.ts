/**
 * Subagent output writer — corresponds to Python subagents/output.py
 * Appends human-readable transcript lines to output files.
 */

import { appendFileSync } from "node:fs";

export class SubagentOutputWriter {
	private _path: string;
	private _extraPaths: string[];

	constructor(path: string, extraPaths: string[] = []) {
		this._path = path;
		this._extraPaths = extraPaths;
	}

	stage(name: string): void {
		this.append(`[stage] ${name}\n`);
	}

	toolCall(name: string): void {
		this.append(`[tool] ${name}\n`);
	}

	toolResult(status: "success" | "error", brief?: string): void {
		if (brief) {
			this.append(`[tool_result] ${status}: ${brief}\n`);
		} else {
			this.append(`[tool_result] ${status}\n`);
		}
	}

	text(text: string): void {
		if (text) this.append(text);
	}

	summary(text: string): void {
		if (text) this.append(`\n[summary]\n${text}\n`);
	}

	error(message: string): void {
		this.append(`[error] ${message}\n`);
	}

	/**
	 * Dispatch a wire message to the appropriate output method.
	 * Corresponds to Python SubagentOutputWriter.write_wire_message().
	 */
	writeWireMessage(msg: Record<string, unknown>): void {
		const type = msg?.type as string | undefined;
		const payload = (msg?.payload ?? msg) as Record<string, unknown>;
		switch (type) {
			case "ToolCall": {
				const fn = payload?.function as Record<string, unknown> | undefined;
				this.toolCall((fn?.name as string) ?? "unknown");
				break;
			}
			case "ToolResult": {
				const rv = payload?.return_value as Record<string, unknown> | undefined;
				const isError = (rv?.isError ?? rv?.is_error ?? false) as boolean;
				const brief = (rv?.brief as string) ?? undefined;
				this.toolResult(isError ? "error" : "success", brief);
				break;
			}
			case "ContentPart":
			case "TextPart": {
				if (payload?.type === "text") {
					this.text((payload.text as string) ?? "");
				}
				break;
			}
			// Ignore other wire message types (think, hooks, etc.)
		}
	}

	private append(text: string): void {
		try {
			appendFileSync(this._path, text, "utf-8");
		} catch {
			// Ignore write errors
		}
		for (const p of this._extraPaths) {
			try {
				appendFileSync(p, text, "utf-8");
			} catch {
				// Best-effort tee
			}
		}
	}
}
