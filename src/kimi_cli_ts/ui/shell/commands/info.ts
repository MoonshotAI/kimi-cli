/**
 * Info slash-command handlers: /hooks, /mcp, /debug, /changelog
 * Corresponds to Python ui/shell/commands/info.py
 */

import type { HookEngine } from "../../../hooks/engine.ts";
import type { Config } from "../../../config.ts";
import type { Context } from "../../../soul/context.ts";
import type { ContentPart, CommandPanelConfig } from "../../../types.ts";
import type { MCPStatusSnapshot } from "../../../wire/types.ts";
import { CHANGELOG } from "../../../utils/changelog.ts";

export function handleHooks(hookEngine: HookEngine): string {
	const summary = hookEngine.summary;
	if (!Object.keys(summary).length) {
		return "No hooks configured. Add [[hooks]] sections to config.toml.";
	}
	const lines = ["Configured Hooks:"];
	for (const [event, count] of Object.entries(summary)) {
		lines.push(`  ${event}: ${count} hook(s)`);
	}
	return lines.join("\n");
}

export function handleMcp(
	config: Config,
	mcpSnapshot: MCPStatusSnapshot | null,
): string {
	if (!mcpSnapshot) {
		return "No MCP servers configured.";
	}
	const lines: string[] = [];
	lines.push(
		`MCP Servers: ${mcpSnapshot.connected}/${mcpSnapshot.total} connected, ${mcpSnapshot.tools} tools`,
	);
	for (const server of mcpSnapshot.servers) {
		const statusSuffix =
			server.status === "unauthorized"
				? ` (unauthorized - run: kimi mcp auth ${server.name})`
				: server.status !== "connected"
					? ` (${server.status})`
					: "";
		lines.push(`  • ${server.name}${statusSuffix}`);
		for (const tool of server.tools) {
			lines.push(`      • ${tool}`);
		}
	}
	lines.push("");
	lines.push(`Client timeout: ${config.mcp.client.tool_call_timeout_ms}ms`);
	return lines.join("\n");
}

export function handleDebug(context: Context): string {
	const history = context.history;
	if (!history.length) {
		return "Context is empty - no messages yet.";
	}

	const lines = [
		"=== Context Debug ===",
		`Total messages: ${history.length}`,
		`Token count: ${context.tokenCountWithPending}`,
		"---",
	];

	for (let i = 0; i < history.length; i++) {
		const msg = history[i]!;
		const role = msg.role.toUpperCase();

		if (typeof msg.content === "string") {
			const preview =
				msg.content.length > 200
					? msg.content.slice(0, 200) + "..."
					: msg.content;
			lines.push(`#${i + 1} [${role}] ${preview}`);
		} else if (Array.isArray(msg.content)) {
			const parts = msg.content as ContentPart[];
			const summary = parts
				.map((p: any) => {
					if (p.type === "text")
						return p.text.length > 100 ? p.text.slice(0, 100) + "..." : p.text;
					if (p.type === "tool_use") return `[tool_use: ${p.name}]`;
					if (p.type === "tool_result") return `[tool_result]`;
					if (p.type === "image") return `[image]`;
					return `[${p.type}]`;
				})
				.join(" | ");
			lines.push(`#${i + 1} [${role}] ${summary}`);
		}
	}
	lines.push("=== End Debug ===");
	return lines.join("\n");
}

export function handleChangelog(): string {
	const lines = ["  Release Notes:", ""];
	for (const [version, entry] of Object.entries(CHANGELOG)) {
		lines.push(`  ${version}: ${entry.description}`);
		for (const item of entry.entries) {
			lines.push(`    \u2022 ${item}`);
		}
		lines.push("");
	}
	return lines.join("\n");
}

// ── Panel factory functions ─────────────────────────────

export function createChangelogPanel(): CommandPanelConfig {
	const lines: string[] = ["  Release Notes:", ""];
	for (const [version, entry] of Object.entries(CHANGELOG)) {
		lines.push(`  ${version}: ${entry.description}`);
		for (const item of entry.entries) {
			lines.push(`    \u2022 ${item}`);
		}
		lines.push("");
	}
	return { type: "content", title: "Release Notes", content: lines.join("\n") };
}

export function createDebugPanel(context: Context): CommandPanelConfig {
	const history = context.history;

	return {
		type: "debug",
		data: {
			context: {
				totalMessages: history.length,
				tokenCount: context.tokenCountWithPending,
				checkpoints: context.nCheckpoints,
				trajectory: context.filePath,
			},
			messages: history as any, // KMessage[] from context.jsonl
		},
	};
}

export function createHooksPanel(hookEngine: HookEngine): CommandPanelConfig {
	const summary = hookEngine.summary;
	if (!Object.keys(summary).length) {
		return {
			type: "content",
			title: "Hooks",
			content: "No hooks configured. Add [[hooks]] sections to config.toml.",
		};
	}
	const lines: string[] = ["Configured Hooks:"];
	for (const [event, count] of Object.entries(summary)) {
		lines.push(`  ${event}: ${count} hook(s)`);
	}
	return { type: "content", title: "Hooks", content: lines.join("\n") };
}

export function createMcpPanel(
	config: Config,
	mcpSnapshot: MCPStatusSnapshot | null,
): CommandPanelConfig {
	const content = handleMcp(config, mcpSnapshot);
	return { type: "content", title: "MCP Servers", content };
}
