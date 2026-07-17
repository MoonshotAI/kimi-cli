/**
 * CLI router — corresponds to Python cli/__init__.py
 * Uses Commander.js (replaces Typer)
 */

import { Command } from "commander";
// Heavy imports are lazy-loaded inside the action handler to speed up --help/--version.
// Only type imports (erased at runtime) are kept static.
import type { UILoopFn } from "../soul/index.ts";
import type { ContentPart } from "../types.ts";
import type { WireUIEvent } from "../ui/shell/events.ts";
import type { ApprovalResponseKind } from "../wire/types.ts";
import type { Wire } from "../wire/wire_core.ts";

// ── Re-exports from Python cli/__init__.py ──────────────
// These live in cli/errors.ts to avoid circular imports (cli ↔ soul ↔ cli).
export { Reload, isReload, SwitchToWeb, SwitchToVis } from "./errors.ts";
import { Reload, isReload } from "./errors.ts";

export type UIMode = "shell" | "print" | "acp" | "wire";
export type InputFormat = "text" | "stream-json";
export type OutputFormat = "text" | "stream-json";

export const ExitCode = {
	SUCCESS: 0,
	FAILURE: 1,
	RETRYABLE: 75, // EX_TEMPFAIL from sysexits.h
} as const;

// ── Helpers ─────────────────────────────────────────

/**
 * Remove the trailing ` (session_id)` suffix from a session title, if present.
 */
function stripSessionIdSuffix(title: string, sessionId: string): string {
	const suffix = ` (${sessionId})`;
	return title.endsWith(suffix) ? title.slice(0, -suffix.length) : title;
}

/**
 * Print a hint for resuming the session after exit.
 * chalk must be passed in since it's lazy-loaded.
 */
function printResumeHint(
	session: { id: string; isEmpty?: () => Promise<boolean> },
	chalk: any,
): void {
	console.error(chalk.dim(`\nTo resume this session: kimi -r ${session.id}`));
}

// ── Subcommands ──────────────────────────────────────────

import { loginCommand } from "./login.ts";
import { logoutCommand } from "./logout.ts";
import { infoCommand } from "./info.ts";
import { exportCommand } from "./export.ts";
import { mcpCommand } from "./mcp.ts";
import { pluginCommand } from "./plugin.ts";
import { toadCommand } from "./toad.ts";
import { visCommand } from "./vis.ts";
import { webCommand } from "./web.ts";

// ── Version callback ─────────────────────────────────────

function getVersionString(): string {
	try {
		const { getVersion } = require("../constant.ts");
		return getVersion();
	} catch {
		return "0.0.0";
	}
}

// ── Program ──────────────────────────────────────────────

const program = new Command()
	.name("kimi")
	.description("Kimi, your next CLI agent.")
	.version(getVersionString(), "-V, --version")
	.addCommand(loginCommand)
	.addCommand(logoutCommand)
	.addCommand(infoCommand)
	.addCommand(exportCommand)
	.addCommand(mcpCommand)
	.addCommand(pluginCommand)
	.addCommand(toadCommand)
	.addCommand(visCommand)
	.addCommand(webCommand);

// Main chat command (default)
program
	.argument("[prompt...]", "Initial prompt to send")
	.option("-m, --model <model>", "Model to use")
	.option("--thinking", "Enable thinking mode")
	.option("--no-thinking", "Disable thinking mode")
	.option("--yolo", "Auto-approve all tool calls")
	.option("-y, --yes", "Alias for --yolo (auto-approve all tool calls)")
	.option("--plan", "Start in plan mode")
	.option("--print", "Print mode (non-interactive)")
	.option("-w, --work-dir <dir>", "Working directory")
	.option("--add-dir <dir...>", "Add additional directories to the workspace")
	.option("--max-steps-per-turn <n>", "Max steps per turn", parseInt)
	.option("--max-retries-per-step <n>", "Max retries per step", parseInt)
	.option("--config-file <path>", "Config TOML/JSON file to load")
	.option("--config <string>", "Config TOML/JSON string to load")
	.option(
		"-S, --session [id]",
		"Resume a session. With ID: resume that session. Without ID: interactively pick a session.",
	)
	.option("-r, --resume [id]", "Alias for --session")
	.option("-C, --continue", "Continue the most recent session")
	.option(
		"--input-format <format>",
		"Input format (text, stream-json). Print mode only.",
	)
	.option(
		"--output-format <format>",
		"Output format (text, stream-json). Print mode only.",
	)
	.option(
		"--quiet",
		"Alias for --print --output-format text --final-message-only",
	)
	.option(
		"--final-message-only",
		"Only print the final assistant message (print UI)",
	)
	.option("-p, --prompt <text>", "User prompt to the agent")
	.option("--verbose", "Verbose output")
	.option("--debug", "Debug mode")
	.option("--wire", "Run as Wire server (experimental)")
	.option("--agent <name>", "Builtin agent specification to use")
	.option("--agent-file <path>", "Custom agent specification file")
	.option("--mcp-config-file <path...>", "MCP config file(s) to load")
	.option("--mcp-config <json...>", "MCP config JSON to load")
	.option("--command <cmd>", "Run a single shell command and exit")
	.option("--skills-dir <dir...>", "Custom skills directories (repeatable)")
	.option("--max-ralph-iterations <n>", "Max ralph loop iterations", parseInt)
	.action(
		async (
			promptParts: string[],
			options: {
				model?: string;
				thinking?: boolean;
				yolo?: boolean;
				yes?: boolean;
				plan?: boolean;
				print?: boolean;
				workDir?: string;
				addDir?: string[];
				maxStepsPerTurn?: number;
				maxRetriesPerStep?: number;
				configFile?: string;
				config?: string;
				session?: string | true;
				resume?: string | true;
				continue?: boolean;
				inputFormat?: string;
				outputFormat?: string;
				quiet?: boolean;
				finalMessageOnly?: boolean;
				prompt?: string;
				verbose?: boolean;
				debug?: boolean;
				wire?: boolean;
				agent?: string;
				agentFile?: string;
				mcpConfigFile?: string[];
				mcpConfig?: string[];
				command?: string;
				skillsDir?: string[];
				maxRalphIterations?: number;
			},
		) => {
			// ── Lazy-load heavy modules (only needed for actual runs, not --help/--version) ──
			const [
				ReactModule,
				{ render },
				{ KimiCLI },
				{ runSoul },
				{ WireFile },
				{ Shell },
				{ QueueShutDown },
				chalkModule,
				{ patchInkLogUpdate },
			] = await Promise.all([
				import("react"),
				import("ink"),
				import("../app.ts"),
				import("../soul/index.ts"),
				import("../wire/file.ts"),
				import("../ui/shell/Shell.tsx"),
				import("../utils/queue.ts"),
				import("chalk"),
				import("../ui/renderer/index.ts"),
			]);
			const React = ReactModule.default ?? ReactModule;
			const chalk = chalkModule.default ?? chalkModule;

			// Handle --yes alias for --yolo
			if (options.yes) options.yolo = true;

			// Merge --resume into --session (they are aliases)
			if (options.resume !== undefined && options.session === undefined) {
				options.session = options.resume;
			}

			// session states:
			//   undefined → not provided (new session)
			//   true      → --session/--resume without value (picker mode)
			//   "ID"      → --session ID (resume specific session)
			const pickerMode = options.session === true;
			let resolvedSessionId: string | undefined = pickerMode
				? undefined
				: (options.session as string | undefined);

			// Handle --quiet alias
			if (options.quiet) {
				options.print = true;
				options.outputFormat = "text";
				options.finalMessageOnly = true;
			}

			// Resolve prompt from either positional args or --prompt option
			const prompt =
				promptParts.length > 0
					? promptParts.join(" ")
					: (options.prompt ?? undefined);

			// Determine config source: --config-file takes precedence over legacy --config as path
			const configFile = options.configFile ?? undefined;

			// Validate: picker mode only works in shell (interactive) mode
			if (pickerMode && options.print) {
				console.error(
					"Error: --session without a session ID is only supported for shell UI",
				);
				process.exit(2);
			}

			// If picker mode, run interactive session picker before starting the app
			if (pickerMode) {
				const { Session } = await import("../session.ts");
				const workDir = options.workDir ?? process.cwd();
				const allSessions = await Session.list(workDir);
				if (allSessions.length === 0) {
					console.error("No sessions found for the working directory.");
					process.exit(0);
				}

				// Use simple numbered list for session picking
				console.log("Select a session to resume:\n");
				for (let i = 0; i < allSessions.length; i++) {
					const s = allSessions[i]!;
					const shortId = s.id.slice(0, 8);
					const name = stripSessionIdSuffix(s.title, s.id);
					console.log(`  ${i + 1}. ${name} (${shortId})`);
				}
				console.log("");

				// Read user selection
				const readline = await import("node:readline");
				const rl = readline.createInterface({
					input: process.stdin,
					output: process.stdout,
				});
				const answer = await new Promise<string>((resolve) => {
					rl.question("Enter number (or Ctrl+C to cancel): ", resolve);
				});
				rl.close();

				const idx = parseInt(answer, 10) - 1;
				if (isNaN(idx) || idx < 0 || idx >= allSessions.length) {
					console.error("Invalid selection.");
					process.exit(1);
				}
				resolvedSessionId = allSessions[idx]!.id;
			}

			// Ink unmount function — captured in interactive mode for error-path cleanup
			let unmount: (() => void) | undefined;
			// pushEvent — hoisted so the outer catch block can push errors to the UI
			let pushEvent: ((event: WireUIEvent) => void) | null = null;
			// disableBracketedPaste — hoisted so the outer catch block can cleanup bracketed paste mode
			let disableBracketedPaste: (() => void) | undefined;

			// ── Load MCP configs (mirrors Python cli/__init__.py lines 503-518) ──
			const mcpConfigs: Record<string, unknown>[] = [];
			{
				const { existsSync, readFileSync } = await import("node:fs");
				const { join } = await import("node:path");
				const { getShareDir } = await import("../share.ts");

				const fileConfigs = options.mcpConfigFile ? [...options.mcpConfigFile] : [];
				// If no explicit config files, try default ~/.kimi/mcp.json
				if (fileConfigs.length === 0) {
					const defaultMcpFile = join(getShareDir(), "mcp.json");
					if (existsSync(defaultMcpFile)) {
						fileConfigs.push(defaultMcpFile);
					}
				}
				// Load file configs
				for (const filePath of fileConfigs) {
					try {
						const raw = readFileSync(filePath, "utf-8");
						mcpConfigs.push(JSON.parse(raw));
					} catch (err) {
						console.error(`Failed to load MCP config from ${filePath}: ${err}`);
					}
				}
				// Load inline JSON configs
				if (options.mcpConfig) {
					for (const raw of options.mcpConfig) {
						try {
							mcpConfigs.push(JSON.parse(raw));
						} catch (err) {
							console.error(`Failed to parse MCP config JSON: ${err}`);
						}
					}
				}
			}

			try {
				if (options.print) {
					// ── Print mode: UILoopFn writes directly to stdout/stderr ──
					// Matches Python's TextPrinter: rich.print(msg) for every wire message.
					/**
					 * Format a value as a Python-style repr string.
					 * Matches Python's rich.pretty_repr output conventions:
					 * - Strings: 'text' (single-quoted)
					 * - null/undefined → None
					 * - booleans → True/False
					 * - Objects with __wireType: TypeName(field=value, ...)
					 * - Plain objects: { key: value, ... } in Python repr style
					 */
					function pyRepr(value: unknown): string {
						if (value === null || value === undefined) return "None";
						if (typeof value === "boolean") return value ? "True" : "False";
						if (typeof value === "number") return String(value);
						if (typeof value === "string") return `'${value}'`;
						if (Array.isArray(value)) {
							const items = value.map((v) => pyRepr(v));
							return `[${items.join(", ")}]`;
						}
						if (typeof value === "object") {
							const obj = value as Record<string, unknown>;
							// If it's a wire-typed object, format as TypeName(field=value, ...)
							if (typeof obj.__wireType === "string") {
								return formatWireMessage(obj);
							}
							// Plain object: format as TypeName(field=value, ...) if it looks like one,
							// otherwise as { key: value, ... }
							const entries = Object.entries(obj);
							if (entries.length === 0) return "{}";
							const parts = entries.map(([k, v]) => `${k}: ${pyRepr(v)}`);
							return `{ ${parts.join(", ")} }`;
						}
						return String(value);
					}

					/**
					 * Format a wire message with Python-style pretty-printing.
					 * Matches rich.pretty_repr(obj, max_width=80):
					 * - If single-line repr fits in max_width, use single line
					 * - Otherwise, use multi-line with 4-space indent per level
					 */
					function prettyRepr(
						typeName: string,
						fields: [string, unknown][],
						indent: number,
						maxWidth: number,
					): string {
						// Build field repr strings
						const fieldReprs = fields.map(([k, v]) => {
							// For nested wire-typed objects, try compact first
							if (v !== null && typeof v === "object" && !Array.isArray(v)) {
								const obj = v as Record<string, unknown>;
								if (typeof obj.__wireType === "string") {
									const nestedName = obj.__wireType;
									const { __wireType: _, ...nestedFields } = obj;
									const nestedEntries = Object.entries(nestedFields);
									return {
										key: k,
										value: v,
										compact: `${k}=${pyRepr(v)}`,
										nestedType: nestedName,
										nestedEntries,
									};
								}
							}
							return {
								key: k,
								value: v,
								compact: `${k}=${pyRepr(v)}`,
								nestedType: null,
								nestedEntries: null,
							};
						});

						// Try compact (single-line) first
						const compact = `${typeName}(${fieldReprs.map((f) => f.compact).join(", ")})`;
						if (compact.length + indent <= maxWidth) {
							return compact;
						}

						// Multi-line format with 4-space indent
						const childIndent = indent + 4;
						const pad = " ".repeat(childIndent);
						const closePad = " ".repeat(indent);
						const lines: string[] = [`${typeName}(`];
						for (let i = 0; i < fieldReprs.length; i++) {
					const f = fieldReprs[i]!;
							const isLast = i === fieldReprs.length - 1;
							const comma = isLast ? "" : ",";

							// For nested wire-typed objects, try to pretty-print them too
							if (f.nestedType && f.nestedEntries) {
								const nestedRepr = prettyRepr(
									f.nestedType,
									f.nestedEntries.map(([nk, nv]) => [nk, nv]),
									childIndent,
									maxWidth,
								);
								// Check if nested repr is multi-line
								if (nestedRepr.includes("\n")) {
									const nestedLines = nestedRepr.split("\n");
									lines.push(`${pad}${f.key}=${nestedLines[0]}`);
									for (let j = 1; j < nestedLines.length - 1; j++) {
										lines.push(`${nestedLines[j]}`);
									}
									lines.push(
										`${nestedLines[nestedLines.length - 1]}${comma}`,
									);
								} else {
									lines.push(`${pad}${f.key}=${nestedRepr}${comma}`);
								}
							} else {
								lines.push(`${pad}${f.key}=${pyRepr(f.value)}${comma}`);
							}
						}
						lines.push(`${closePad})`);
						return lines.join("\n");
					}

					/**
					 * Format a wire message for display, matching Python's rich.print(msg) output.
					 * Uses rich-compatible pretty_repr with max_width=80.
					 */
					function formatWireMessage(msg: any): string {
						const typeName = msg.__wireType ?? "Unknown";
						const { __wireType: _, ...fields } = msg;
						const entries: [string, unknown][] = Object.entries(fields);
						return prettyRepr(typeName, entries, 0, 80);
					}

					const outputFormat = options.outputFormat ?? "text";
					const finalOnly = options.finalMessageOnly ?? false;

					const printUILoopFn: UILoopFn = async (wire) => {
						const uiSide = wire.uiSide(true);
						// For final-only mode, track the last step's text content
						let finalTextBuffer = "";
						// For text mode, merge consecutive TextPart/ThinkPart messages
						// (Python's wire merge produces single merged parts; TS wire sends streaming deltas)
						let pendingMerge: { type: string; msg: any } | null = null;

						function flushPendingMerge(): void {
							if (pendingMerge) {
								process.stdout.write(
									formatWireMessage(pendingMerge.msg) + "\n",
								);
								pendingMerge = null;
							}
						}

						while (true) {
							let msg: any;
							try {
								msg = await uiSide.receive();
							} catch (err) {
								if (err instanceof QueueShutDown) {
									flushPendingMerge();
									break;
								}
								throw err;
							}
							const t = msg.__wireType ?? "";

							if (finalOnly) {
								// FinalOnly mode: only output the last step's text
								if (t === "StepBegin" || t === "StepInterrupted") {
									finalTextBuffer = "";
								} else if (t === "TextPart" || (t === "ContentPart" && msg.type === "text")) {
									finalTextBuffer += msg.text ?? "";
								} else if (t === "TurnEnd") {
									if (finalTextBuffer) {
										if (outputFormat === "stream-json") {
											process.stdout.write(
												JSON.stringify({
													role: "assistant",
													content: finalTextBuffer,
												}) + "\n",
											);
										} else {
											process.stdout.write(finalTextBuffer + "\n");
										}
										finalTextBuffer = "";
									}
								}
							} else if (outputFormat === "text") {
								// Text mode: merge consecutive same-type content parts,
								// matching Python's merged Wire output.
								// ContentPart is the wire name for both TextPart and ThinkPart
								const effectiveType = t === "ContentPart" ? (msg.type === "think" ? "ThinkPart" : "TextPart") : t;
								if (effectiveType === "TextPart" || effectiveType === "ThinkPart") {
									if (pendingMerge && pendingMerge.type === effectiveType) {
										// Merge: append text to the pending message
										if (effectiveType === "ThinkPart") {
											pendingMerge.msg.think = (pendingMerge.msg.think ?? "") + (msg.think ?? msg.text ?? "");
										} else {
											pendingMerge.msg.text = (pendingMerge.msg.text ?? "") + (msg.text ?? "");
										}
									} else {
										// Different type or no pending — flush old, start new
										flushPendingMerge();
										pendingMerge = { type: effectiveType, msg: { ...msg } };
									}
								} else {
									// Non-content message: flush pending merge, then print
									flushPendingMerge();
									process.stdout.write(formatWireMessage(msg) + "\n");
								}
							} else {
								// stream-json mode: emit JSON for each wire message
								const { __wireType: typeName, ...fields } = msg;
								process.stdout.write(
									JSON.stringify({ __wireType: typeName, ...fields }) + "\n",
								);
							}
						}
					};

					const app = await KimiCLI.create({
						workDir: options.workDir,
						additionalDirs: options.addDir,
						configFile,
						modelName: options.model,
						thinking: options.thinking,
						yolo: options.yolo ?? true, // print mode implies yolo
						planMode: options.plan,
						sessionId: resolvedSessionId,
						continueSession: options.continue,
						maxStepsPerTurn:
							options.maxStepsPerTurn ?? options.maxRetriesPerStep,
						mcpConfigs: mcpConfigs.length > 0 ? mcpConfigs : undefined,
						deferMcpLoading: false,
					});

					if (prompt) {
						// Echo user input to stdout (matches Python Print.run() line 89)
						if (outputFormat === "text" && !finalOnly) {
							console.log(prompt);
						}
						const wireFile = app.session.wireFile
							? new WireFile(app.session.wireFile)
							: undefined;
						const cancelController = new AbortController();
						await runSoul(app.soul, prompt, printUILoopFn, cancelController, {
							wireFile,
							runtime: app.soul.runtime,
						});
					}
					printResumeHint(app.session, chalk);
					await app.shutdown();
				} else if (options.wire) {
					// ── Wire mode ──
					const app = await KimiCLI.create({
						workDir: options.workDir,
						additionalDirs: options.addDir,
						configFile,
						configText: options.config,
						modelName: options.model,
						thinking: options.thinking,
						yolo: options.yolo,
						planMode: options.plan,
						sessionId: resolvedSessionId,
						continueSession: options.continue,
						maxStepsPerTurn:
							options.maxStepsPerTurn ?? options.maxRetriesPerStep,
						agentFile: options.agentFile,
						skillsDirs: options.skillsDir,
						mcpConfigs: mcpConfigs.length > 0 ? mcpConfigs : undefined,
						deferMcpLoading: false,
					});

					// Import wire components
					const { WireServer } = await import("../wire/server.ts");
					const { Wire } = await import("../wire/wire_core.ts");
					const { runWithWireContext } = await import("../soul/index.ts");

					// Create the WireServerSoul adapter
					const wireServerSoul = {
						wireFile: app.session.wireFile
							? new WireFile(app.session.wireFile)
							: undefined,

						async onInitialize(params: Record<string, unknown>) {
							// Build slash commands
							const slashCommands = app.soul.availableSlashCommands.map(
								(cmd: { name: string; description: string; aliases?: string[] }) => ({
									name: cmd.name,
									description: cmd.description,
									aliases: cmd.aliases ?? [],
								}),
							);

							// Handle external tools
							const accepted: string[] = [];
							const rejected: Array<{ name: string; reason: string }> = [];
							const externalTools = params.external_tools as
								| Array<{ name: string; description: string; input_schema: Record<string, unknown> }>
								| undefined;
							if (externalTools && app.agent.toolset) {
								for (const tool of externalTools) {
									const existing = app.agent.toolset.find(tool.name);
									if (existing) {
										rejected.push({ name: tool.name, reason: "conflicts with builtin tool" });
									} else {
										// Accept and register external tool
										accepted.push(tool.name);
									}
								}
							}

							// Build hooks info
							const { HookEventType } = await import("../config.ts");
							const supportedEvents = HookEventType.options;
							const hookEngine = app.soul.hookEngine;
							const hooksInfo: Record<string, unknown> = {
								supported_events: supportedEvents,
								configured: hookEngine?.summary ?? [],
							};

							const result: Record<string, unknown> = {
								agent: {
									name: app.agent.name,
									model: app.soul.modelName,
									workDir: app.session.workDir,
								},
								slash_commands: slashCommands,
								hooks: hooksInfo,
							};

							if (accepted.length > 0 || rejected.length > 0) {
								result.rejected_tools = rejected;
								result.external_tools = { accepted, rejected };
							}

							return result;
						},

						async onPrompt(
							userInput: string | unknown[],
							streamCallback: (wire: Wire) => Promise<void>,
							cancelEvent: any,
						): Promise<string> {
							const wire = new Wire({ fileBackend: wireServerSoul.wireFile });

							return runWithWireContext(wire, async () => {
								const streamPromise = streamCallback(wire);
								try {
									await app.soul.run(userInput as string | ContentPart[]);
									return "finished";
								} finally {
									wire.shutdown();
									await wire.join();
									await streamPromise;
								}
							});
						},

						async onSteer(userInput: string | unknown[]): Promise<void> {
							await app.soul.steer(userInput as string | ContentPart[]);
						},

						async onSetPlanMode(enabled: boolean): Promise<boolean> {
							app.soul.setPlanMode(enabled);
							return enabled;
						},
					};

					// Create and configure wire server
					const wireServer = new WireServer();
					wireServer.setSoul(wireServerSoul);

					if (app.soul.runtime.rootWireHub) {
						wireServer.setRootHub(app.soul.runtime.rootWireHub);
					}
					if (app.soul.runtime.approvalRuntime) {
						wireServer.setApprovalRuntime(app.soul.runtime.approvalRuntime);
					}

					// Run the server
					try {
						await wireServer.serve();
					} finally {
						await app.shutdown();
					}
				} else {
					// ── Interactive mode with reload loop ──
					// /undo and /fork trigger a reload by storing the new session info
					// and unmounting Ink, which causes waitUntilExit() to resolve.
					let currentSessionId: string | undefined = resolvedSessionId;
					let currentPrefillText: string | undefined = undefined;
					let currentPrompt: string | undefined = prompt;

					// eslint-disable-next-line no-constant-condition
					while (true) {
						// Pending reload info — set by onReload, checked after waitUntilExit
						let pendingReload: {
							sessionId: string;
							prefillText?: string;
						} | null = null;

						// pushEvent will be set by Shell's onWireReady callback
						pushEvent = null;

						// inkUnmount will be set after render() — captured here so callbacks can trigger reload
						let inkUnmountFn: (() => void) | null = null;

						// Helper: trigger reload from anywhere (UILoopFn or Shell prop)
						const triggerReload = (sessionId: string, prefillText?: string) => {
							pendingReload = { sessionId, prefillText };
							inkUnmountFn?.();
						};

						// Create a UILoopFn that translates Wire messages → WireUIEvent for Shell.
						// Uses the outer `pushEvent` variable (not a parameter) so that event
						// routing stays correct across Shell lifecycle changes.
						const createShellUILoopFn = (): UILoopFn => {
							return async (wire) => {
								const uiSide = wire.uiSide(true);
								while (true) {
									let msg: any;
									try {
										msg = await uiSide.receive();
									} catch (err) {
										if (err instanceof QueueShutDown) break;
										throw err;
									}
									const pe = pushEvent;
									if (!pe) continue;
									const t = msg.__wireType ?? "";
									if (t === "TurnBegin") {
										const raw = msg.user_input;
										let userInput: string;
										if (typeof raw === "string") {
											userInput = raw;
										} else if (Array.isArray(raw)) {
											userInput =
												(raw as any[])
													.filter(
														(p: any) =>
															p?.type === "text" && typeof p.text === "string",
													)
													.map((p: any) => p.text)
													.join("") || "[complex input]";
										} else {
											userInput = "[complex input]";
										}
										// Slash commands: skip user input echo (matches Python — visualize.py
										// only does flush_content() for TurnBegin, never renders user message).
										// Pass empty string so useWire still creates assistant message container.
										pe({
											type: "turn_begin",
											userInput: userInput.startsWith("/") ? "" : userInput,
										});
									} else if (t === "TurnEnd") {
										pe({ type: "turn_end" });
									} else if (t === "StepBegin") {
										pe({ type: "step_begin", n: msg.n });
									} else if (t === "TextPart" || (t === "ContentPart" && msg.type === "text")) {
										pe({ type: "text_delta", text: msg.text ?? "" });
									} else if (t === "ThinkPart" || (t === "ContentPart" && msg.type === "think")) {
										pe({ type: "think_delta", text: msg.think ?? msg.text ?? "" });
									} else if (t === "ToolCall") {
										// ToolCall uses nested function structure: {type:"function", id, function:{name, arguments}, extras}
										const fn = msg.function as { name?: string; arguments?: string } | undefined;
										pe({
											type: "tool_call",
											id: msg.id ?? "",
											name: fn?.name ?? msg.name ?? "",
											arguments: fn?.arguments ?? msg.arguments ?? "",
										});
									} else if (t === "ToolResult") {
										// Normalize return_value: wire uses is_error (snake_case), UI expects isError
										const rv = msg.return_value ?? {};
										const normalizedResult = {
											tool_call_id: msg.tool_call_id ?? "",
											return_value: {
												output: rv.output ?? "",
												isError: rv.isError ?? rv.is_error ?? false,
												message: rv.message ?? "",
												display: rv.display ?? [],
												extras: rv.extras ?? null,
											},
											display: msg.display ?? rv.display ?? [],
										};
										pe({
											type: "tool_result",
											toolCallId: msg.tool_call_id ?? "",
											result: normalizedResult,
										});
									} else if (t === "StatusUpdate") {
										pe({ type: "status_update", status: msg });
									} else if (t === "CompactionBegin") {
										pe({ type: "compaction_begin" });
									} else if (t === "CompactionEnd") {
										pe({ type: "compaction_end" });
									} else if (t === "Notification") {
										pe({
											type: "notification",
											title: msg.title,
											body: msg.body,
										});
									} else if (t === "SubagentEvent") {
										pe({
											type: "subagent_event",
											parentToolCallId: msg.parent_tool_call_id,
											agentId: msg.agent_id,
											subagentType: msg.subagent_type,
											event: msg.event,
										});
									} else if (t === "ApprovalRequest") {
										pe({ type: "approval_request", request: msg });
									} else if (t === "QuestionRequest") {
										pe({ type: "question_request", request: msg });
									} else if (t === "StepInterrupted") {
										pe({ type: "step_interrupted" });
									}
								}
							};
						};

						// Cancel controller for the current soul run — shared between onSubmit and onInterrupt
						let currentCancelController: AbortController | null = null;

						const app = await KimiCLI.create({
							workDir: options.workDir,
							additionalDirs: options.addDir,
							configFile,
							modelName: options.model,
							thinking: options.thinking,
							yolo: options.yolo,
							sessionId: currentSessionId,
							continueSession: !currentSessionId ? options.continue : undefined,
							resumed: !!currentSessionId,
							maxStepsPerTurn:
								options.maxStepsPerTurn ?? options.maxRetriesPerStep,
							mcpConfigs: mcpConfigs.length > 0 ? mcpConfigs : undefined,
							deferMcpLoading: true,
						});

						// Patch Ink's log-update with our cell-level diffing renderer.
						// This must happen before render() creates the Ink instance.
						patchInkLogUpdate();

						// Enable bracketed paste mode so terminal doesn't show paste warning.
						// This tells the terminal (e.g., VSCode) that we handle large pastes.
						process.stdout.write("\x1b[?2004h");
						disableBracketedPaste = () => {
							process.stdout.write("\x1b[?2004l");
						};

						// Check if stdin is a proper TTY for Ink's raw mode support
						const isRawModeSupported = process.stdin.isTTY === true;
						if (!isRawModeSupported) {
							console.error(
								"Error: Kimi CLI requires an interactive terminal.",
							);
							console.error(
								"Raw mode is not supported on stdin. Make sure you're running:",
							);
							console.error("  bun run start");
							console.error("(not piping stdin from another command)");
							process.exit(1);
						}

						const { waitUntilExit, unmount: inkUnmount } = render(
							React.createElement(Shell, {
								modelName: app.soul.modelName,
								workDir: options.workDir ?? process.cwd(),
								sessionId: app.session.id,
								sessionDir: app.session.dir,
								sessionTitle: app.session.title,
								thinking: app.soul.thinking,
								yolo: options.yolo ?? false,
								prefillText: currentPrefillText,
								onSubmit: async (input: string | ContentPart[]) => {
									const cancelController = new AbortController();
									currentCancelController = cancelController;
									const wireFile = app.session.wireFile
										? new WireFile(app.session.wireFile)
										: undefined;
									try {
										await runSoul(
											app.soul,
											input,
											createShellUILoopFn(),
											cancelController,
											{
												wireFile,
												runtime: app.soul.runtime,
											},
										);
									} catch (err) {
										if (err instanceof Reload) {
											// Soul handler requested reload (e.g., /model, /sessions panel)
											// Translate to shell-level triggerReload, matching Python pattern
											triggerReload(
												err.sessionId ?? app.session.id,
												err.prefillText ?? undefined,
											);
											return;
										}
										pushEvent?.({
											type: "error",
											message: err instanceof Error ? err.message : String(err),
										});
									}
								},
								onInterrupt: () => {
									currentCancelController?.abort();
								},
								onPlanModeToggle: async () => {
									return app.soul.togglePlanModeFromManual();
								},
								onApprovalResponse: (
									requestId: string,
									decision: ApprovalResponseKind,
									feedback?: string,
								) => {
									if (app.soul.runtime.approvalRuntime) {
										app.soul.runtime.approvalRuntime.resolve(
											requestId,
											decision,
											feedback,
										);
									}
								},
								onWireReady: (pe) => {
									pushEvent = pe;
									// Emit initial status so StatusBar shows context tokens at startup
									const initStatus = app.soul.status;
									pe({
										type: "status_update",
										status: {
											context_usage: initStatus.contextUsage ?? null,
											context_tokens: initStatus.contextTokens ?? null,
											max_context_tokens: initStatus.maxContextTokens ?? null,
											token_usage: initStatus.tokenUsage
											? {
													input_other: initStatus.tokenUsage.inputTokens,
													output: initStatus.tokenUsage.outputTokens,
													input_cache_read: initStatus.tokenUsage.cacheReadTokens ?? 0,
													input_cache_creation: initStatus.tokenUsage.cacheWriteTokens ?? 0,
												}
											: null,
											message_id: null,
											plan_mode: initStatus.planMode ?? null,
											yolo: initStatus.yoloEnabled ?? null,
											mcp_status: null,
										},
									});
								},
								onReload: (newSessionId: string, prefill?: string) => {
									triggerReload(newSessionId, prefill);
								},
								extraSlashCommands: app.soul.availableSlashCommands,
							}),
							{ exitOnCtrlC: false },
						);
						unmount = inkUnmount;
						inkUnmountFn = inkUnmount;

						// Start background task to forward RootWireHub events to UI.
						// ApprovalRequests flow through ApprovalRuntime → RootWireHub,
						// NOT through the soul's Wire, so we need a separate subscriber.
						let rootHubQueue: any = null;
						if (app.soul.runtime.rootWireHub) {
							rootHubQueue = app.soul.runtime.rootWireHub.subscribe();
							(async () => {
								try {
									while (true) {
										const msg = await rootHubQueue.get();
										if (
											msg &&
											typeof msg === "object" &&
											"id" in msg &&
											"tool_call_id" in msg &&
											"sender" in msg
										) {
											// ApprovalRequest — enrich with source_description from subagent store
											const request = msg as any;
											if (
												request.agent_id &&
												!request.source_description &&
												app.soul.runtime.subagentStore
											) {
												const record =
													app.soul.runtime.subagentStore.getInstance(
														request.agent_id,
													);
												if (record) {
													request.source_description = record.description;
												}
											}
											(pushEvent as ((e: WireUIEvent) => void) | null)?.({
												type: "approval_request",
												request,
											});
										}
									}
								} catch {
									// Queue shutdown or error
									if (rootHubQueue) {
										app.soul.runtime.rootWireHub?.unsubscribe(rootHubQueue);
									}
								}
							})();
						}

						// Run initial prompt if provided (only on first iteration)
						if (currentPrompt) {
							const cancelController = new AbortController();
							currentCancelController = cancelController;
							const wireFile = app.session.wireFile
								? new WireFile(app.session.wireFile)
								: undefined;
							runSoul(
								app.soul,
								currentPrompt,
								createShellUILoopFn(),
								cancelController,
								{
									wireFile,
									runtime: app.soul.runtime,
								},
							).catch((err) => {
								pushEvent?.({
									type: "error",
									message: err instanceof Error ? err.message : String(err),
								});
							});
						}

						await waitUntilExit();
						disableBracketedPaste();
						if (rootHubQueue && app.soul.runtime.rootWireHub) {
							app.soul.runtime.rootWireHub.unsubscribe(rootHubQueue);
						}
						await app.shutdown();

						// Check if this was a reload (/undo or /fork)
						if (pendingReload) {
							currentSessionId = (
								pendingReload as { sessionId: string; prefillText?: string }
							).sessionId;
							currentPrefillText = (
								pendingReload as { sessionId: string; prefillText?: string }
							).prefillText;
							currentPrompt = undefined; // Don't re-run the initial prompt
							continue;
						}

						// Normal exit
						printResumeHint(app.session, chalk);
						break;
					}
				}
			} catch (err) {
				// Clean up bracketed paste mode on error
				disableBracketedPaste?.();
				if (isReload(err)) {
					// Shouldn't happen with the new loop, but handle gracefully
					console.error(
						"Unexpected reload — restarting is not supported here.",
					);
					process.exit(ExitCode.FAILURE);
				}
				const errMsg = err instanceof Error ? err.message : String(err);
				// Push error to UI so the user can see it — don't crash the app
				const push = pushEvent as ((event: WireUIEvent) => void) | null;
				if (push) {
					push({ type: "error", message: errMsg });
				} else {
					// No UI available (e.g. during startup) — fall back to stderr + exit
					if (typeof unmount === "function") unmount();
					console.error("Error:", errMsg);
					process.exit(ExitCode.FAILURE);
				}
			}
		},
	);

export async function cli(argv: string[]): Promise<number> {
	try {
		await program.parseAsync(argv);
		return ExitCode.SUCCESS;
	} catch (error) {
		console.error("Fatal error:", error);
		return ExitCode.FAILURE;
	}
}
