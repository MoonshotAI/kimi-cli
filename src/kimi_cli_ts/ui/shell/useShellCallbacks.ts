/**
 * useShellCallbacks.ts — Callback bundle for useShellInput and approval handling.
 *
 * Extracts all callback logic from Shell.tsx into a single hook that returns
 * the options object for useShellInput plus handleApprovalResponse.
 */

import { useCallback, useRef } from "react";
import { parseSlashCommand, findSlashCommand } from "./slash.ts";
import { runShellCommand, openExternalEditor } from "./shell-executor.ts";
import { Reload } from "../../cli/errors.ts";
import { SHELL_MODE_COMMANDS } from "./shell-commands.ts";
import type { WireUIEvent } from "./events.ts";
import type {
	ApprovalRequest,
	ApprovalResponseKind,
} from "../../wire/types.ts";
import type { SlashCommand, CommandPanelConfig } from "../../types.ts";

interface WireLike {
	pushEvent: (event: WireUIEvent) => void;
	isStreaming: boolean;
	pendingApproval: ApprovalRequest | null;
}

export interface UseShellCallbacksOptions {
	wire: WireLike;
	allCommands: SlashCommand[];
	shellCommands: SlashCommand[];
	exit: () => void;
	pushNotification: (title: string, body: string) => void;
	/** External onSubmit from ShellProps — sends input to the agent loop. */
	onSubmitExternal?: (input: string) => Promise<void>;
	onInterruptExternal?: () => void;
	onPlanModeToggleExternal?: () => Promise<boolean>;
	onApprovalResponseExternal?: (
		requestId: string,
		decision: ApprovalResponseKind,
		feedback?: string,
	) => void;
	/** External onReload from ShellProps — triggers reload with new session. */
	onReloadExternal?: (sessionId: string, prefillText?: string) => void;
}

export interface ShellCallbacks {
	/** Callbacks to spread into useShellInput options. */
	inputCallbacks: {
		onSubmit: (input: string) => void;
		onSlashExecute: (cmd: SlashCommand) => void;
		onExit: () => void;
		onInterrupt: () => void;
		onPlanModeToggle: () => void;
		onOpenEditor: () => void;
		onNotify: (title: string, body: string) => void;
		onReload: (sessionId: string, prefillText?: string) => void;
	};
	/** Approval response handler for <ApprovalPrompt>. */
	handleApprovalResponse: (
		decision: ApprovalResponseKind,
		feedback?: string,
	) => void;
	/** Set this after useShellInput returns — provides access to shellMode/openPanel. */
	setInputStateAccessor: (accessor: InputStateAccessor) => void;
}

interface InputStateAccessor {
	shellMode: boolean;
	openPanel: (config: CommandPanelConfig) => void;
}

/**
 * Commands that are purely UI-side and never pass through soul.run().
 * Mirrors Python: shell_slash_registry commands that are NOT also soul commands.
 */
const PURE_SHELL_COMMANDS = new Set([
	"exit",
	"quit",
	"q",
	"theme",
	"clear",
	"cls",
	"reset",
	"new",
	"help",
	"h",
	"?",
	"version",
	"undo",
	"fork",
	"usage",
	"status",
]);

export function useShellCallbacks({
	wire,
	allCommands,
	shellCommands,
	exit,
	pushNotification,
	onSubmitExternal,
	onInterruptExternal,
	onPlanModeToggleExternal,
	onApprovalResponseExternal,
	onReloadExternal,
}: UseShellCallbacksOptions): ShellCallbacks {
	// Use a ref so onSubmit can access inputState without circular dependency.
	const inputRef = useRef<InputStateAccessor>({
		shellMode: false,
		openPanel: () => {},
	});
	const setInputStateAccessor = useCallback((accessor: InputStateAccessor) => {
		inputRef.current = accessor;
	}, []);

	const onSubmit = useCallback(
		(input: string) => {
			const parsed = parseSlashCommand(input);
			if (parsed) {
				// Shell mode: only whitelisted commands
				if (
					inputRef.current.shellMode &&
					!SHELL_MODE_COMMANDS.has(parsed.name)
				) {
					wire.pushEvent({
						type: "notification",
						title: "Shell mode",
						body: `/${parsed.name} is not available in shell mode.`,
					});
					return;
				}

				// Check if this is a pure shell command (handled locally, never reaches soul)
				// Mirrors Python: shell_slash_registry.find_command(name) is not None
				const shellCmd = findSlashCommand(shellCommands, parsed.name);
				if (shellCmd && PURE_SHELL_COMMANDS.has(parsed.name)) {
					if (shellCmd.panel && !parsed.args) {
						const pc = shellCmd.panel();
						if (pc) {
							inputRef.current.openPanel(pc);
							return;
						}
					}
					const result = shellCmd.handler(parsed.args);
					if (result && typeof result.then === "function") {
						result.then((feedback: void | string) => {
							if (typeof feedback === "string") {
								wire.pushEvent({ type: "slash_result", text: feedback });
							}
						});
					}
					return;
				}

				// Check if it's a known command (for panel support + unknown detection)
				const knownCmd = findSlashCommand(allCommands, parsed.name);
				if (knownCmd) {
					// Panel support: if command has a panel and no args, open it locally
					if (knownCmd.panel && !parsed.args) {
						const pc = knownCmd.panel();
						if (pc) {
							// Wrap onSelect/onSubmit to catch Reload thrown by soul-level panels
							// and translate to shell-level reload (matching Python pattern)
							if (pc.type === "choice") {
								const origOnSelect = pc.onSelect;
								pc.onSelect = (value: string) => {
									try {
										const result = origOnSelect(value);
										// Handle async onSelect (e.g. /model saves config then throws Reload)
										if (result instanceof Promise) {
											return result.catch((err: unknown) => {
												if (err instanceof Reload) {
													onReloadExternal?.(
														err.sessionId ?? "",
														err.prefillText ?? undefined,
													);
													return;
												}
												throw err;
											});
										}
										return result;
									} catch (err) {
										if (err instanceof Reload) {
											onReloadExternal?.(
												err.sessionId ?? "",
												err.prefillText ?? undefined,
											);
											return;
										}
										throw err;
									}
								};
							} else if (pc.type === "input" && pc.onSubmit) {
								const origOnSubmit = pc.onSubmit;
								pc.onSubmit = (value: string) => {
									try {
										const result = origOnSubmit(value);
										if (result instanceof Promise) {
											return result.catch((err: unknown) => {
												if (err instanceof Reload) {
													onReloadExternal?.(
														err.sessionId ?? "",
														err.prefillText ?? undefined,
													);
													return;
												}
												throw err;
											});
										}
										return result;
									} catch (err) {
										if (err instanceof Reload) {
											onReloadExternal?.(
												err.sessionId ?? "",
												err.prefillText ?? undefined,
											);
											return;
										}
										throw err;
									}
								};
							}
							inputRef.current.openPanel(pc);
							return;
						}
					}
					// Route to soul.run() — mirrors Python: await self.run_soul_command(raw_input)
					onSubmitExternal?.(input);
					return;
				}

				// Unknown command
				wire.pushEvent({
					type: "notification",
					title: "Unknown command",
					body: `/${parsed.name} is not recognized. Type /help.`,
				});
				return;
			}
			if (inputRef.current.shellMode) {
				runShellCommand(input, pushNotification);
				return;
			}
			onSubmitExternal?.(input);
		},
		[
			allCommands,
			shellCommands,
			onSubmitExternal,
			onReloadExternal,
			wire,
			pushNotification,
		],
	);

	const onSlashExecute = useCallback(
		(cmd: SlashCommand) => {
			// Shell commands (clear, exit, quit, theme, etc.) run directly — their handlers
			// manage their own lifecycle and don't need Wire context.
			// Soul commands must route through onSubmitExternal → runSoul() for Wire context.
			const isShellCmd = shellCommands.some(
				(sc) => sc.name === cmd.name || sc.aliases?.includes(cmd.name),
			);
			if (isShellCmd) {
				const result = cmd.handler("");
				if (result && typeof result.then === "function") {
					result.then((feedback: void | string) => {
						if (typeof feedback === "string") {
							wire.pushEvent({ type: "slash_result", text: feedback });
						}
					});
				}
			} else {
				// Soul command — route through runSoul() to ensure Wire context exists
				onSubmitExternal?.(`/${cmd.name}`);
			}
		},
		[wire, shellCommands, onSubmitExternal],
	);

	const onExit = useCallback(() => exit(), [exit]);

	const onInterrupt = useCallback(() => {
		if (wire.isStreaming) {
			onInterruptExternal?.();
			wire.pushEvent({ type: "error", message: "Interrupted by user" });
		}
	}, [wire, onInterruptExternal]);

	const onPlanModeToggle = useCallback(() => {
		onPlanModeToggleExternal?.()
			.then((s) => pushNotification("Plan mode", s ? "ON" : "OFF"))
			.catch((e: unknown) =>
				pushNotification("Plan mode", `Error: ${String(e)}`),
			);
	}, [onPlanModeToggleExternal, pushNotification]);

	const onOpenEditor = useCallback(
		() => openExternalEditor(pushNotification, onSubmitExternal),
		[pushNotification, onSubmitExternal],
	);

	const onReload = useCallback(
		(sessionId: string, prefillText?: string) => {
			onReloadExternal?.(sessionId, prefillText);
		},
		[onReloadExternal],
	);

	// Track which approval request IDs we've already responded to, so that
	// a second keypress (e.g. number key followed by Enter) does not
	// accidentally approve the NEXT queued request. We use a Set rather
	// than a single ref because React state may update between keystrokes,
	// making the current pendingApproval point to the next queued request.
	const respondedIdsRef = useRef(new Set<string>());
	// Debounce: ignore rapid-fire responses within a short window to prevent
	// a stale Enter keypress from approving the next request in the queue.
	const lastRespondTimeRef = useRef(0);
	const APPROVAL_DEBOUNCE_MS = 400;

	const handleApprovalResponse = useCallback(
		(decision: ApprovalResponseKind, feedback?: string) => {
			const current = wire.pendingApproval;
			if (!current) return;
			// Guard: don't respond to a request we already handled
			if (respondedIdsRef.current.has(current.id)) return;
			// Debounce: ignore if too soon after last response
			const now = Date.now();
			if (now - lastRespondTimeRef.current < APPROVAL_DEBOUNCE_MS) return;
			respondedIdsRef.current.add(current.id);
			lastRespondTimeRef.current = now;
			onApprovalResponseExternal?.(current.id, decision, feedback);
			wire.pushEvent({
				type: "approval_response",
				requestId: current.id,
				response: decision,
			});
		},
		[wire.pendingApproval, onApprovalResponseExternal, wire],
	);

	return {
		inputCallbacks: {
			onSubmit,
			onSlashExecute,
			onExit,
			onInterrupt,
			onPlanModeToggle,
			onOpenEditor,
			onNotify: pushNotification,
			onReload,
		},
		handleApprovalResponse,
		setInputStateAccessor,
	};
}
