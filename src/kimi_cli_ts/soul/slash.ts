/**
 * Slash command registry — corresponds to Python soul/slash concepts
 * Provides registration + dispatch for /commands in the CLI.
 */

import type { SlashCommand } from "../types.ts";

export class SlashCommandRegistry {
	private commands = new Map<string, SlashCommand>();
	private aliases = new Map<string, string>();

	register(command: SlashCommand): void {
		this.commands.set(command.name, command);
		if (command.aliases) {
			for (const alias of command.aliases) {
				this.aliases.set(alias, command.name);
			}
		}
	}

	get(name: string): SlashCommand | undefined {
		const resolved = this.aliases.get(name) ?? name;
		return this.commands.get(resolved);
	}

	has(name: string): boolean {
		return this.commands.has(name) || this.aliases.has(name);
	}

	list(): SlashCommand[] {
		return [...this.commands.values()];
	}

	async execute(input: string): Promise<boolean> {
		const trimmed = input.trim();
		if (!trimmed.startsWith("/")) return false;

		const spaceIdx = trimmed.indexOf(" ");
		const name =
			spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
		const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

		const cmd = this.get(name);
		if (!cmd) return false;

		await cmd.handler(args);
		return true;
	}
}

/**
 * Create a default registry with built-in commands.
 * Handlers are stubs — the real app wires them up.
 */
export function createDefaultRegistry(): SlashCommandRegistry {
	const registry = new SlashCommandRegistry();

	const builtins: SlashCommand[] = [
		{
			name: "clear",
			description: "Clear conversation history",
			aliases: ["reset"],
			handler: async () => {
				/* wired by app */
			},
		},
		{
			name: "compact",
			description: "Compact conversation context",
			handler: async () => {},
		},
		{
			name: "yolo",
			description: "Toggle auto-approve mode",
			aliases: ["auto-approve"],
			handler: async () => {},
		},
		{
			name: "plan",
			description: "Toggle plan mode",
			handler: async () => {},
		},
		{
			name: "model",
			description: "Switch model",
			handler: async () => {},
		},
		{
			name: "help",
			description: "Show help",
			aliases: ["?"],
			handler: async () => {},
		},
		{
			name: "init",
			description: "Initialize project configuration",
			handler: async () => {},
		},
		{
			name: "add-dir",
			description: "Add directory to workspace scope",
			handler: async () => {},
		},
		// ── Commands below are newly registered to match Python version ──
		{
			name: "login",
			description: "Login or setup a platform",
			aliases: ["setup"],
			handler: async () => {},
		},
		{
			name: "logout",
			description: "Logout from the current platform",
			handler: async () => {},
		},
		{
			name: "new",
			description: "Start a new session",
			handler: async () => {},
		},
		{
			name: "sessions",
			description: "List sessions and resume",
			aliases: ["resume"],
			handler: async () => {},
		},
		{
			name: "title",
			description: "Set or show the session title",
			aliases: ["rename"],
			handler: async () => {},
		},
		{
			name: "task",
			description: "Browse and manage background tasks",
			handler: async () => {},
		},
		{
			name: "editor",
			description: "Set default external editor",
			handler: async () => {},
		},
		{
			name: "reload",
			description: "Reload configuration",
			handler: async () => {},
		},
		{
			name: "usage",
			description: "Display API usage and quota information",
			aliases: ["status"],
			handler: async () => {},
		},
		{
			name: "changelog",
			description: "Show release notes",
			aliases: ["release-notes"],
			handler: async () => {},
		},
		{
			name: "feedback",
			description: "Submit feedback",
			handler: async () => {},
		},
		{
			name: "hooks",
			description: "List configured hooks",
			handler: async () => {},
		},
		{
			name: "mcp",
			description: "Show MCP servers and tools",
			handler: async () => {},
		},
		{
			name: "web",
			description: "Open Kimi Code Web UI in browser",
			handler: async () => {},
		},
		{
			name: "vis",
			description: "Open Kimi Agent Tracing Visualizer",
			handler: async () => {},
		},
		{
			name: "export",
			description: "Export session context to markdown",
			handler: async () => {},
		},
		{
			name: "import",
			description: "Import context from file or session",
			handler: async () => {},
		},
		{
			name: "debug",
			description: "Debug the context",
			handler: async () => {},
		},
	];

	for (const cmd of builtins) {
		registry.register(cmd);
	}

	return registry;
}
