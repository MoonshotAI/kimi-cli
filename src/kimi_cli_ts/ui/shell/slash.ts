/**
 * Shell slash commands — corresponds to Python's ui/shell/slash.py.
 * Shell-level commands: /clear, /help, /exit, /theme, /version.
 */

import type { SlashCommand, CommandPanelConfig } from "../../types";
import { getActiveTheme } from "../theme.ts";
import type { Config } from "../../config.ts";

export type SlashCommandHandler = (args: string) => Promise<void>;

export interface ShellSlashContext {
	clearMessages: () => void;
	exit: () => void;
	setTheme: (theme: "dark" | "light") => void;
	getAllCommands: () => SlashCommand[];
	pushNotification: (title: string, body: string) => void;
	/** Get session dir + workDir + title for /undo and /fork. */
	getSessionInfo?: () => {
		sessionDir: string;
		workDir: string;
		title: string;
	} | null;
	/** Trigger a reload with a new session (and optional prefill text). */
	triggerReload?: (sessionId: string, prefillText?: string) => void;
	/** Current session ID for same-session reload (used by /clear). */
	sessionId?: string;
	/** Show usage panel (called by /usage command). */
	showUsage?: (config: Config) => Promise<void>;
	/** Soul-level context clear: clears context + rewrites system prompt + sends status update. */
	soulClear?: () => Promise<void>;
	/** Get the current line count of the dynamic viewport below <Static> (prompt + bottom slot). */
	getDynamicViewportHeight?: () => number;
	/** Submit input through the soul (goes through runSoul with Wire context). Returns when turn completes. */
	onSubmitExternal?: (input: string) => Promise<void>;
}

/**
 * Create shell-level slash commands.
 */
export function createShellSlashCommands(
	ctx: ShellSlashContext,
): SlashCommand[] {
	return [
		{
			name: "clear",
			description: "Clear conversation history",
			aliases: ["cls", "reset"],
			handler: async () => {
				// Match Python exactly: await run_soul_command("/clear"); raise Reload()
				// Step 1: Clear UI messages before soul command (prevents flash of old content)
				ctx.clearMessages?.();
				// Step 2: Run soul /clear through Wire context (clears context + wire file)
				await ctx.onSubmitExternal?.("/clear");
				// Step 3: Snapshot viewport height before reload unmounts Ink
				const height = ctx.getDynamicViewportHeight?.() ?? 5;
				// Step 4: Trigger same-session reload (remounts Ink with fresh state)
				if (ctx.triggerReload && ctx.sessionId) {
					ctx.triggerReload(ctx.sessionId);
				}
				// Step 5: Erase residual lines left by Ink unmount, show feedback
				const eraseLine = "\x1b[2K";
				const cursorUp = "\x1b[A";
				process.stdout.write(
					(eraseLine + cursorUp).repeat(height) +
						eraseLine +
						"\r" +
						"• The context has been cleared.\n",
				);
			},
		},
		{
			name: "new",
			description: "Start a new session",
			handler: async () => {
				// Match Python: create new session, clean up empty current session, then reload.
				const info = ctx.getSessionInfo?.();
				if (!info || !ctx.triggerReload) {
					ctx.pushNotification("New", "No active session.");
					return;
				}
				const { Session } = await import("../../session.ts");
				const currentSession = await Session.find(
					info.workDir,
					ctx.sessionId ?? "",
				);
				if (currentSession && (await currentSession.isEmpty())) {
					await currentSession.delete();
				}
				const newSession = await Session.create(info.workDir);
				// Snapshot viewport height before reload unmounts Ink
				const height = ctx.getDynamicViewportHeight?.() ?? 5;
				// Trigger reload with new session
				ctx.triggerReload(newSession.id);
				// Erase residual Ink lines and show feedback (same pattern as /clear)
				const eraseLine = "\x1b[2K";
				const cursorUp = "\x1b[A";
				process.stdout.write(
					(eraseLine + cursorUp).repeat(height) +
						eraseLine +
						"\r" +
						"\x1b[32mNew session created. Switching...\x1b[39m\n",
				);
			},
		},
		{
			name: "exit",
			description: "Exit the application",
			aliases: ["quit", "q"],
			handler: async () => {
				ctx.exit();
			},
		},
		{
			name: "help",
			description: "Show help information",
			aliases: ["h", "?"],
			handler: async () => {
				// Fallback when panel is not used (e.g. direct /help invocation)
				const allCmds = ctx.getAllCommands();
				ctx.pushNotification("Help", formatHelp(allCmds));
			},
			panel: (): CommandPanelConfig => {
				const allCmds = ctx.getAllCommands();
				return {
					type: "content",
					title: "Help",
					content: formatHelp(allCmds),
				};
			},
		},
		{
			name: "theme",
			description: "Toggle dark/light theme",
			handler: async (args: string) => {
				const theme = args.trim() as "dark" | "light";
				if (theme === "dark" || theme === "light") {
					ctx.setTheme(theme);
					ctx.pushNotification("Theme", `Switched to ${theme} theme.`);
				} else {
					// Toggle
					const current = getActiveTheme();
					const next = current === "dark" ? "light" : "dark";
					ctx.setTheme(next);
					ctx.pushNotification("Theme", `Switched to ${next} theme.`);
				}
			},
			panel: (): CommandPanelConfig => {
				const current = getActiveTheme();
				return {
					type: "choice",
					title: "Theme",
					items: [
						{ label: "🌙 Dark", value: "dark", current: current === "dark" },
						{ label: "☀️  Light", value: "light", current: current === "light" },
					],
					onSelect: (value: string) => {
						const theme = value as "dark" | "light";
						ctx.setTheme(theme);
						ctx.pushNotification("Theme", `Switched to ${theme} theme.`);
					},
				};
			},
		},
		{
			name: "version",
			description: "Show version information",
			handler: async () => {
				const { VERSION } = await import("../../constant.ts");
				return `kimi, version ${VERSION}`;
			},
		},
		{
			name: "undo",
			description: "Undo: fork the session at a previous turn and retry",
			handler: async () => {
				if (!ctx.getSessionInfo || !ctx.triggerReload) return;
				const info = ctx.getSessionInfo();
				if (!info) {
					ctx.pushNotification("Undo", "No active session.");
					return;
				}
				const { enumerateTurns, forkSession } = await import(
					"../../session_fork.ts"
				);
				const { join } = await import("node:path");

				const wirePath = join(info.sessionDir, "wire.jsonl");
				const turns = enumerateTurns(wirePath);
				if (turns.length === 0) {
					ctx.pushNotification("Undo", "No turns found in this session.");
					return;
				}

				// Build choices panel
				const items = turns.map((t) => {
					const firstLine = t.userText.split("\n", 1)[0] ?? "";
					const label =
						firstLine.length > 80 ? firstLine.slice(0, 77) + "..." : firstLine;
					return {
						label: `[${t.index}] ${label}`,
						value: String(t.index),
						current: t.index === turns.length - 1,
					};
				});

				// Use the panel system for selection
				// (Panel-based selection is handled externally; here we use a simple last-turn undo)
				// For the panel-based approach, we expose a panel config:
				ctx.pushNotification("Undo", "Select a turn from the /undo panel.");
			},
			panel: (): CommandPanelConfig => {
				if (!ctx.getSessionInfo || !ctx.triggerReload) {
					return {
						type: "content",
						title: "Undo",
						content: "No active session.",
					};
				}
				const info = ctx.getSessionInfo();
				if (!info) {
					return {
						type: "content",
						title: "Undo",
						content: "No active session.",
					};
				}

				// Synchronous — enumerateTurns is sync in our TS impl
				const {
					enumerateTurns,
					forkSession,
				} = require("../../session_fork.ts");
				const { join } = require("node:path");

				const wirePath = join(info.sessionDir, "wire.jsonl");
				const turns = enumerateTurns(
					wirePath,
				) as import("../../session_fork.ts").TurnInfo[];
				if (turns.length === 0) {
					return {
						type: "content",
						title: "Undo",
						content: "No turns found in this session.",
					};
				}

				const items = turns.map((t) => {
					const firstLine = t.userText.split("\n", 1)[0] ?? "";
					const label =
						firstLine.length > 80 ? firstLine.slice(0, 77) + "..." : firstLine;
					return {
						label: `[${t.index}] ${label}`,
						value: String(t.index),
						current: t.index === turns.length - 1,
					};
				});

				return {
					type: "choice",
					title: "Undo — select a turn to redo",
					items,
					onSelect: async (value: string) => {
						const turnIndex = parseInt(value, 10);
						const selectedTurn = turns[turnIndex];
						if (!selectedTurn) return;

						const userText = selectedTurn.userText;

						try {
							let newSessionId: string;
							if (turnIndex === 0) {
								// Fork with no history — just the user text
								const { Session } = await import("../../session.ts");
								const { loadSessionState, saveSessionState } = await import(
									"../../session.ts"
								);
								const newSession = await Session.create(info.workDir);
								newSessionId = newSession.id;
								const newState = await loadSessionState(newSession.dir);
								newState.custom_title = `Undo: ${info.title}`;
								newState.title_generated = true;
								await saveSessionState(newState, newSession.dir);
							} else {
								const forkTurnIndex = turnIndex - 1;
								newSessionId = await forkSession({
									sourceSessionDir: info.sessionDir,
									workDir: info.workDir,
									turnIndex: forkTurnIndex,
									titlePrefix: "Undo",
									sourceTitle: info.title,
								});
							}

							// Save old session ID and viewport height before reload
							const oldSessionId = ctx.sessionId;
							const height = ctx.getDynamicViewportHeight?.() ?? 5;

							ctx.triggerReload!(newSessionId, userText);

							// After Ink unmount: erase viewport + write green message + resume hint
							const eraseLine = "\x1b[2K";
							const cursorUp = "\x1b[A";
							process.stdout.write(
								(eraseLine + cursorUp).repeat(height) +
									eraseLine +
									"\r" +
									`\x1b[32mForked at turn ${turnIndex}. Switching to new session...\x1b[39m\n` +
									"\n" +
									`To resume this session: kimi -r ${oldSessionId}\n`,
							);
						} catch (err: any) {
							ctx.pushNotification(
								"Undo",
								`Error: ${err.message ?? String(err)}`,
							);
						}
					},
				};
			},
		},
		{
			name: "fork",
			description: "Fork the current session (copy all history)",
			handler: async () => {
				if (!ctx.getSessionInfo || !ctx.triggerReload) {
					ctx.pushNotification("Fork", "No active session.");
					return;
				}
				const info = ctx.getSessionInfo();
				if (!info) {
					ctx.pushNotification("Fork", "No active session.");
					return;
				}

				try {
					const { forkSession } = await import("../../session_fork.ts");
					const newSessionId = await forkSession({
						sourceSessionDir: info.sessionDir,
						workDir: info.workDir,
						titlePrefix: "Fork",
						sourceTitle: info.title,
					});

					// Save old session ID before reload
					const oldSessionId = ctx.sessionId;

					// Snapshot the dynamic viewport height BEFORE triggerReload unmounts Ink
					const height = ctx.getDynamicViewportHeight?.() ?? 5;

					// Trigger reload — calls inkUnmount() internally
					ctx.triggerReload(newSessionId);

					// AFTER Ink unmount: erase residual viewport lines, then write feedback.
					// Matches Python: green message + blank line + resume hint.
					const eraseLine = "\x1b[2K";
					const cursorUp = "\x1b[A";
					process.stdout.write(
						(eraseLine + cursorUp).repeat(height) +
							eraseLine +
							"\r" +
							"\x1b[32mSession forked. Switching to new session...\x1b[39m\n" +
							"\n" +
							`To resume this session: kimi -r ${oldSessionId}\n`,
					);
				} catch (err: any) {
					ctx.pushNotification("Fork", `Error: ${err.message ?? String(err)}`);
				}
			},
		},
		{
			name: "usage",
			description: "Display API usage and quota information",
			aliases: ["status"],
			handler: async () => {
				if (!ctx.showUsage) {
					ctx.pushNotification("Usage", "Usage panel not available.");
					return;
				}
				try {
					const { loadConfig } = await import("../../config.ts");
					const { config } = await loadConfig();
					await ctx.showUsage(config);
				} catch (err: any) {
					ctx.pushNotification("Usage", `Error: ${err.message ?? String(err)}`);
				}
			},
		},
	];
}

/**
 * Parse a slash command from input string.
 * Returns null if not a slash command.
 */
export function parseSlashCommand(
	input: string,
): { name: string; args: string } | null {
	if (!input.startsWith("/")) return null;
	const trimmed = input.slice(1).trim();
	if (!trimmed) return null;
	const spaceIdx = trimmed.indexOf(" ");
	if (spaceIdx === -1) {
		return { name: trimmed, args: "" };
	}
	return {
		name: trimmed.slice(0, spaceIdx),
		args: trimmed.slice(spaceIdx + 1).trim(),
	};
}

/**
 * Find a slash command by name or alias.
 */
export function findSlashCommand(
	commands: SlashCommand[],
	name: string,
): SlashCommand | undefined {
	return commands.find(
		(cmd) => cmd.name === name || cmd.aliases?.includes(name),
	);
}

const SKILL_COMMAND_PREFIX = "skill:";

function formatHelp(commands: SlashCommand[]): string {
	const lines = [
		"Kimi Code CLI — Help",
		"",
		"Keyboard Shortcuts:",
		"  Ctrl+X             Toggle agent/shell mode",
		"  Shift+Tab          Toggle plan mode",
		"  Ctrl+O             Edit in external editor",
		"  Ctrl+J / Alt+Enter Insert newline",
		"  Ctrl+V             Paste (supports images)",
		"  Ctrl+D             Exit",
		"  Ctrl+C             Interrupt",
		"",
	];

	// Separate skills from regular commands
	const seen = new Set<string>();
	const regularCmds: SlashCommand[] = [];
	const skillCmds: SlashCommand[] = [];

	for (const cmd of commands) {
		if (seen.has(cmd.name)) continue;
		seen.add(cmd.name);
		if (cmd.name.startsWith(SKILL_COMMAND_PREFIX)) {
			skillCmds.push(cmd);
		} else {
			regularCmds.push(cmd);
		}
	}

	regularCmds.sort((a, b) => a.name.localeCompare(b.name));
	skillCmds.sort((a, b) => a.name.localeCompare(b.name));

	lines.push("Slash Commands:");
	for (const cmd of regularCmds) {
		const aliases = cmd.aliases?.length ? `, /${cmd.aliases.join(", /")}` : "";
		const nameStr = `/${cmd.name}${aliases}`;
		lines.push(`  ${nameStr.padEnd(22)} ${cmd.description}`);
	}

	if (skillCmds.length > 0) {
		lines.push("");
		lines.push("Skills:");
		for (const cmd of skillCmds) {
			const nameStr = `/${cmd.name}`;
			lines.push(`  ${nameStr.padEnd(30)} ${cmd.description}`);
		}
	}

	lines.push("");
	return lines.join("\n");
}
