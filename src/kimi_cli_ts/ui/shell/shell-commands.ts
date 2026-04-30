/**
 * shell-commands.ts — Slash command management utilities.
 *
 * - Deduplication of slash commands
 * - Aggregation of shell + extra commands
 * - Shell-mode command whitelist
 */

import type { SlashCommand } from "../../types.ts";

/** Commands available in shell mode ($ prompt). */
export const SHELL_MODE_COMMANDS = new Set([
	"clear",
	"exit",
	"help",
	"theme",
	"version",
	"quit",
	"q",
	"cls",
	"reset",
	"h",
	"?",
]);

/** Deduplicate commands by name, keeping first occurrence. */
export function deduplicateCommands(commands: SlashCommand[]): SlashCommand[] {
	const seen = new Map<string, SlashCommand>();
	for (const cmd of commands) if (!seen.has(cmd.name)) seen.set(cmd.name, cmd);
	return [...seen.values()];
}

/** Merge shell + extra commands with deduplication. Shell commands take priority (matching Python). */
export function createAllCommands(
	shellCommands: SlashCommand[],
	extraCommands: SlashCommand[] = [],
): SlashCommand[] {
	return deduplicateCommands([...shellCommands, ...extraCommands]);
}
