import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Session } from "../../../session.ts";
import type { Context } from "../../../soul/context.ts";
import type { ContentPart } from "../../../types.ts";

export async function handleExport(
	context: Context,
	session: Session,
	args: string,
): Promise<string> {
	const history = context.history;
	if (!history.length) {
		return "Nothing to export - context is empty.";
	}

	// Determine output path (matches Python's perform_export logic)
	const cleaned = args.trim();
	let outputPath: string;

	if (cleaned) {
		// Check if the path looks like a directory (ends with / or is an existing directory)
		const isDirectoryHint = cleaned.endsWith("/") || cleaned.endsWith("\\");
		let isExistingDir = false;
		try {
			const stat = statSync(cleaned);
			isExistingDir = stat.isDirectory();
		} catch {
			// Path doesn't exist — not a directory
		}

		if (isDirectoryHint || isExistingDir) {
			// Treat as directory — generate filename inside it
			const now = new Date();
			const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
			const filename = `kimi-export-${session.id.slice(0, 8)}-${ts}.md`;
			outputPath = join(cleaned, filename);
		} else {
			// Treat as file path directly
			outputPath = cleaned;
		}
	} else {
		// No args — use working directory with generated filename
		const now = new Date();
		const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
		const filename = `kimi-export-${session.id.slice(0, 8)}-${ts}.md`;
		outputPath = join(session.workDir, filename);
	}

	// Build markdown
	const lines: string[] = [];
	lines.push(`# Kimi CLI Session Export`);
	lines.push(`Session: ${session.id}`);
	lines.push(`Exported: ${new Date().toISOString()}`);
	lines.push(`Messages: ${history.length}`);
	lines.push(`Tokens: ${context.tokenCountWithPending}`);
	lines.push("");

	for (let i = 0; i < history.length; i++) {
		const msg = history[i]!;
		lines.push(`## ${msg.role.toUpperCase()} (#${i + 1})`);
		lines.push("");
		if (typeof msg.content === "string") {
			lines.push(msg.content);
		} else if (Array.isArray(msg.content)) {
			for (const part of msg.content as ContentPart[]) {
				if (part.type === "text") {
					lines.push(part.text);
				} else if (part.type === "tool_use") {
					lines.push(`**Tool Call: ${part.name}**`);
					lines.push("```json");
					lines.push(JSON.stringify(part.input, null, 2));
					lines.push("```");
				} else if (part.type === "tool_result") {
					lines.push(`**Tool Result** (${part.isError ? "error" : "success"})`);
					lines.push("```");
					lines.push(part.content);
					lines.push("```");
				}
			}
		}
		lines.push("");
	}

	try {
		await Bun.write(outputPath, lines.join("\n"));
		// Shorten home dir for display
		const display = outputPath.replace(homedir(), "~");
		return (
			`Exported ${history.length} messages to ${display}\n` +
			"Note: The exported file may contain sensitive information. Please be cautious when sharing it externally."
		);
	} catch (err) {
		return `Failed to export: ${err instanceof Error ? err.message : err}`;
	}
}

export async function handleImport(
	context: Context,
	session: Session,
	args: string,
): Promise<string> {
	const target = args.trim();
	if (!target) {
		return "Usage: /import <file_path or session_id>";
	}

	// Check if it's a file path
	const file = Bun.file(target);
	if (await file.exists()) {
		try {
			const content = await file.text();
			// Append as a user message with import marker
			await context.appendMessage({
				role: "user",
				content: `[Imported from ${target}]\n\n${content}`,
			});
			return `Imported ${content.length} chars from ${target}`;
		} catch (err) {
			return `Failed to import: ${err instanceof Error ? err.message : err}`;
		}
	}

	// Try as session ID
	const { Session: SessionClass } = await import("../../../session.ts");
	const otherSession = await SessionClass.find(session.workDir, target);
	if (!otherSession) {
		return `File not found and no session with ID: ${target}`;
	}

	// Read other session's context
	const contextFile = Bun.file(otherSession.contextFile);
	if (!(await contextFile.exists())) {
		return "Target session has no context.";
	}

	const text = await contextFile.text();
	const messageCount = text.split("\n").filter((l) => l.trim()).length;
	await context.appendMessage({
		role: "user",
		content: `[Imported context from session ${target}]\n\n${text}`,
	});
	return `Imported context from session ${target} (~${messageCount} entries)`;
}
