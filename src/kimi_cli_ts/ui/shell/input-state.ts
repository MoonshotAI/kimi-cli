/**
 * input-state.ts — Shell-level UI state machine + input dispatcher + hotkeys.
 *
 * Single `useInput` hook that:
 * - Routes keyboard events based on UIMode (normal, slash, mention, panel)
 * - Handles all hotkeys (Ctrl+C double-press, shell mode, plan mode, editor)
 * - Manages input value, cursor, history, mention suggestions
 * - Manages UI mode transitions (menus, panels)
 *
 * Shell passes external callbacks; all keyboard logic lives here.
 * Rendering components receive pure props from the returned state.
 *
 * Input Stack: Components can push input layers via useInputLayer()
 * (from input-stack.ts). When a layer is active, normal keys are
 * routed to it instead of the default handler. Global keys (Ctrl+C,
 * Esc when no panel is open) always fire regardless of stack depth.
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { useInput } from "ink";
import { useInputHistory } from "../hooks/useInput.ts";
import { useFileMention } from "../hooks/useFileMention.ts";
import { getTopHandler, hasLayers } from "./input-stack.ts";
import {
	getFilteredCommandCount,
	getFilteredCommand,
} from "../components/SlashMenu.tsx";
import type { SlashCommand, CommandPanelConfig } from "../../types.ts";

// Paste handling thresholds (matches Python version)
const TEXT_PASTE_CHAR_THRESHOLD = 1000;
const TEXT_PASTE_LINE_THRESHOLD = 15;

/** Normalize pasted text: convert \r\n and \r to \n (matches Python's normalize_pasted_text). */
function normalizePastedText(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function countTextLines(text: string): number {
	if (!text) return 1;
	return text.split("\n").length;
}

function shouldPlaceholderizePastedText(text: string): boolean {
	return (
		text.length >= TEXT_PASTE_CHAR_THRESHOLD ||
		countTextLines(text) >= TEXT_PASTE_LINE_THRESHOLD
	);
}

function buildPastedTextPlaceholder(pasteId: number, text: string): string {
	const lineCount = countTextLines(text);
	return lineCount <= 1
		? `[Pasted text #${pasteId}]`
		: `[Pasted text #${pasteId} +${lineCount} lines]`;
}

function resolvePastedTextPlaceholders(
	text: string,
	pastedTexts: Map<number, string>,
): string {
	// Replace [Pasted text #N +lines] with actual content
	return text.replace(
		/\[Pasted text #(\d+)(?: \+\d+ lines?)?\]/g,
		(match, id) => {
			const actualText = pastedTexts.get(parseInt(id));
			return actualText ?? match;
		},
	);
}

// ── UI Mode ─────────────────────────────────────────────

type ChoiceConfig = Extract<CommandPanelConfig, { type: "choice" }>;
type InputConfig = Extract<CommandPanelConfig, { type: "input" }>;
type ContentConfig = Extract<CommandPanelConfig, { type: "content" }>;
type DebugConfig = Extract<CommandPanelConfig, { type: "debug" }>;

export type UIMode =
	| { type: "normal" }
	| { type: "slash_menu" }
	| { type: "mention_menu" }
	| { type: "panel_choice"; config: ChoiceConfig; index: number }
	| { type: "panel_input"; config: InputConfig }
	| { type: "panel_content"; config: ContentConfig; scrollOffset: number }
	| { type: "panel_debug"; config: DebugConfig }
	| { type: "panel_task" };

// ── Hook Return ─────────────────────────────────────────

export interface ShellInputState {
	value: string;
	cursorOffset: number;
	bufferedLines: string[];
	mode: UIMode;
	shellMode: boolean;
	slashFilter: string;
	slashMenuIndex: number;
	slashMenuCount: number;
	mentionSuggestions: string[];
	mentionMenuIndex: number;
	showSlashMenu: boolean;
	showMentionMenu: boolean;
	openPanel: (config: CommandPanelConfig) => void;
	closePanel: () => void;
}

// ── Hook Options ────────────────────────────────────────

interface UseShellInputOptions {
	commands: SlashCommand[];
	workDir?: string;
	disabled?: boolean;
	/** Called when user submits text input (normal or slash command text) */
	onSubmit: (input: string) => void;
	/** Called when a slash command is selected from menu and has no panel */
	onSlashExecute: (cmd: SlashCommand) => void;
	/** Called on Ctrl+C double-press — should exit the app */
	onExit: () => void;
	/** Called on single interrupt (Ctrl+C or Esc in normal mode) — should abort streaming */
	onInterrupt: () => void;
	/** Called to toggle plan mode */
	onPlanModeToggle: () => void;
	/** Called to open external editor */
	onOpenEditor: () => void;
	/** Called to push a notification to the UI */
	onNotify: (title: string, body: string) => void;
	/** Called to trigger a reload (e.g., on model change) */
	onReload: (sessionId: string, prefillText?: string) => void;
}

// ── Hotkey Constants ────────────────────────────────────

const CTRLC_WINDOW_MS = 2000;

// ── Hook ────────────────────────────────────────────────

export function useShellInput({
	commands,
	workDir,
	disabled = false,
	onSubmit,
	onSlashExecute,
	onExit,
	onInterrupt,
	onPlanModeToggle,
	onOpenEditor,
	onNotify,
	onReload,
}: UseShellInputOptions): ShellInputState {
	// ── Input value + history ──
	const {
		value,
		setValue,
		historyPrev,
		historyNext,
		addToHistory,
		isBrowsingHistory,
		exitHistory,
	} = useInputHistory();
	const [cursorOffset, setCursorOffset] = useState(0);
	const [bufferedLines, setBufferedLines] = useState<string[]>([]);

	// ── Pasted text storage ──
	const pastedTexts = useRef<Map<number, string>>(new Map());
	const nextPasteId = useRef(1);

	// ── Bracketed paste state machine ──
	// When terminal sends \x1b[200~...text...\x1b[201~, Ink splits it into
	// multiple input events. We buffer them and emit one paste at the end.
	const pasteBuffering = useRef(false);
	const pasteBuffer = useRef<string[]>([]);

	// ── Shell mode (toggled by Ctrl+X) ──
	const [shellMode, setShellMode] = useState(false);

	// ── UI mode ──
	const [mode, setMode] = useState<UIMode>({ type: "normal" });

	// ── Slash menu state ──
	const [slashMenuIndex, setSlashMenuIndex] = useState(0);

	// ── Mention menu state ──
	const [mentionMenuIndex, setMentionMenuIndex] = useState(0);
	const mention = useFileMention(
		mode.type === "normal" ||
			mode.type === "slash_menu" ||
			mode.type === "mention_menu"
			? value
			: "",
		workDir,
	);

	// ── Hotkey: Ctrl+C double-press tracking ──
	const ctrlCCount = useRef(0);
	const ctrlCTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	// ── Hotkey: Esc double-press tracking (for clearing input) ──
	const escCount = useRef(0);
	const escTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	// ── Stable callback refs (avoid stale closures in useInput) ──
	const onExitRef = useRef(onExit);
	onExitRef.current = onExit;
	const onInterruptRef = useRef(onInterrupt);
	onInterruptRef.current = onInterrupt;
	const onPlanModeToggleRef = useRef(onPlanModeToggle);
	onPlanModeToggleRef.current = onPlanModeToggle;
	const onOpenEditorRef = useRef(onOpenEditor);
	onOpenEditorRef.current = onOpenEditor;
	const onNotifyRef = useRef(onNotify);
	onNotifyRef.current = onNotify;
	const onSubmitRef = useRef(onSubmit);
	onSubmitRef.current = onSubmit;
	const onSlashExecuteRef = useRef(onSlashExecute);
	onSlashExecuteRef.current = onSlashExecute;
	const onReloadRef = useRef(onReload);
	onReloadRef.current = onReload;

	// ── Derived: slash menu (suppressed when browsing history) ──
	const isSlashMode =
		!isBrowsingHistory &&
		(mode.type === "normal" || mode.type === "slash_menu") &&
		value.startsWith("/") &&
		!value.includes(" ") &&
		commands.length > 0;
	const slashFilter = isSlashMode ? value.slice(1) : "";
	const slashMenuCount = isSlashMode
		? getFilteredCommandCount(commands, slashFilter)
		: 0;
	const showSlashMenu = isSlashMode && slashMenuCount > 0;

	// ── Derived: mention menu ──
	const showMentionMenu =
		!showSlashMenu &&
		(mode.type === "normal" || mode.type === "mention_menu") &&
		mention.isActive &&
		mention.suggestions.length > 0 &&
		!shellMode;

	// ── Auto mode transitions ──
	useEffect(() => {
		if (showSlashMenu && mode.type === "normal") {
			setMode({ type: "slash_menu" });
			setSlashMenuIndex(0);
		} else if (!showSlashMenu && mode.type === "slash_menu") {
			setMode({ type: "normal" });
		}
	}, [showSlashMenu, mode.type]);

	useEffect(() => {
		if (showMentionMenu && mode.type === "normal") {
			setMode({ type: "mention_menu" });
			setMentionMenuIndex(0);
		} else if (!showMentionMenu && mode.type === "mention_menu") {
			setMode({ type: "normal" });
		}
	}, [showMentionMenu, mode.type]);

	useEffect(() => {
		setSlashMenuIndex(0);
	}, [slashFilter]);
	useEffect(() => {
		setMentionMenuIndex(0);
	}, [mention.fragment]);
	// When value changes: if browsing history, move cursor to end; otherwise clamp
	useEffect(() => {
		if (isBrowsingHistory) {
			setCursorOffset(value.length);
		} else {
			setCursorOffset((prev) => Math.min(prev, value.length));
		}
	}, [value, isBrowsingHistory]);

	// ── Apply mention selection ──
	const applyMention = useCallback(
		(path: string) => {
			const atIdx = value.lastIndexOf("@");
			if (atIdx === -1) return;
			const newValue = value.slice(0, atIdx) + "@" + path + " ";
			setValue(newValue);
			setCursorOffset(newValue.length);
			setMode({ type: "normal" });
		},
		[value, setValue],
	);

	// ── Panel transition ──
	const openPanelConfig = useCallback(
		(config: CommandPanelConfig) => {
			setValue("");
			setCursorOffset(0);
			setBufferedLines([]);
			if (config.type === "choice") {
				const idx = config.items.findIndex((i) => i.current);
				setMode({ type: "panel_choice", config, index: idx >= 0 ? idx : 0 });
			} else if (config.type === "input") {
				setMode({ type: "panel_input", config });
			} else if (config.type === "content") {
				setMode({ type: "panel_content", config, scrollOffset: 0 });
			} else if (config.type === "debug") {
				setMode({ type: "panel_debug", config });
			} else if (config.type === "task") {
				setMode({ type: "panel_task" });
			}
		},
		[setValue],
	);

	const handlePanelResult = useCallback(
		(
			result: CommandPanelConfig | Promise<CommandPanelConfig | void> | void,
		) => {
			if (!result) {
				setMode({ type: "normal" });
				return;
			}
			if (result instanceof Promise) {
				result.then((next) =>
					next ? openPanelConfig(next) : setMode({ type: "normal" }),
				);
			} else {
				openPanelConfig(result);
			}
		},
		[openPanelConfig],
	);

	// ── Paste clipboard ──
	const pasteClipboard = useCallback(async () => {
		const cmds =
			process.platform === "darwin"
				? [["pbpaste"]]
				: [
						["xclip", "-selection", "clipboard", "-o"],
						["xsel", "--clipboard", "--output"],
						["wl-paste"],
					];
		for (const cmd of cmds) {
			try {
				const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
				const text = await new Response(proc.stdout).text();
				if ((await proc.exited) === 0 && text) {
					// Check if we should placeholderize this text
					let insertText = text;
					if (shouldPlaceholderizePastedText(text)) {
						const pasteId = nextPasteId.current;
						nextPasteId.current += 1;
						pastedTexts.current.set(pasteId, text);
						insertText = buildPastedTextPlaceholder(pasteId, text);
					}

					const next =
						value.slice(0, cursorOffset) +
						insertText +
						value.slice(cursorOffset);
					setValue(next);
					setCursorOffset((prev) => prev + insertText.length);
					return;
				}
			} catch {
				/* try next */
			}
		}
	}, [value, cursorOffset, setValue]);

	// ── Insert pasted text (with optional placeholderization) ──
	const insertPastedText = useCallback(
		(pastedText: string) => {
			exitHistory();
			// Normalize \r\n and \r to \n (terminal may send \r in raw mode)
			const normalized = normalizePastedText(pastedText);
			let text = normalized;
			if (shouldPlaceholderizePastedText(normalized)) {
				const pasteId = nextPasteId.current;
				nextPasteId.current += 1;
				pastedTexts.current.set(pasteId, normalized);
				text = buildPastedTextPlaceholder(pasteId, normalized);
			}
			const next =
				value.slice(0, cursorOffset) + text + value.slice(cursorOffset);
			setValue(next);
			setCursorOffset((prev) => prev + text.length);
		},
		[value, cursorOffset, setValue, exitHistory],
	);

	// ── Text editing (exit history browsing on any edit) ──
	const insertChar = useCallback(
		(input: string) => {
			exitHistory();
			const next =
				value.slice(0, cursorOffset) + input + value.slice(cursorOffset);
			setValue(next);
			setCursorOffset((prev) => prev + input.length);
		},
		[value, cursorOffset, setValue, exitHistory],
	);

	const backspace = useCallback(() => {
		if (cursorOffset > 0) {
			exitHistory();
			setValue(value.slice(0, cursorOffset - 1) + value.slice(cursorOffset));
			setCursorOffset((prev) => prev - 1);
		}
	}, [value, cursorOffset, setValue, exitHistory]);

	// ── Hotkey: handle Ctrl+C (interrupt / double-press exit) ──
	const handleCtrlC = useCallback(() => {
		ctrlCCount.current += 1;
		if (ctrlCCount.current >= 2) {
			// Ctrl+C pressed twice: force exit
			ctrlCCount.current = 0;
			if (ctrlCTimer.current) clearTimeout(ctrlCTimer.current);
			onExitRef.current();
			return;
		}
		// Ctrl+C pressed once: interrupt
		if (ctrlCTimer.current) clearTimeout(ctrlCTimer.current);
		ctrlCTimer.current = setTimeout(() => {
			ctrlCCount.current = 0;
		}, CTRLC_WINDOW_MS);
		onInterruptRef.current();
		onNotifyRef.current("Ctrl-C", "Press Ctrl-C again to exit");
	}, []);

	// ── Hotkey: handle Escape (close panel / clear input on double-press) ──
	const handleEscape = useCallback(() => {
		const m = mode.type;

		// panel_input doesn't use useInputLayer, so Esc still comes here
		if (m === "panel_input") {
			setValue("");
			setCursorOffset(0);
			setMode({ type: "normal" });
			escCount.current = 0;
			if (escTimer.current) clearTimeout(escTimer.current);
			return;
		}

		// In normal mode: track double-press to clear input
		if (m === "normal") {
			escCount.current += 1;
			if (escCount.current >= 2) {
				// Esc pressed twice: clear input
				escCount.current = 0;
				if (escTimer.current) clearTimeout(escTimer.current);
				setValue("");
				setCursorOffset(0);
				setBufferedLines([]);
				onNotifyRef.current("Input", "Cleared");
				return;
			}
			// Esc pressed once: interrupt streaming
			if (escTimer.current) clearTimeout(escTimer.current);
			escTimer.current = setTimeout(() => {
				escCount.current = 0;
			}, CTRLC_WINDOW_MS);
			onInterruptRef.current();
			onNotifyRef.current("Esc", "Press Esc again to clear input");
			return;
		}

		// If in a menu (slash/mention), just return to normal
		if (m === "slash_menu" || m === "mention_menu") {
			setMode({ type: "normal" });
			escCount.current = 0;
			if (escTimer.current) clearTimeout(escTimer.current);
			return;
		}
	}, [mode.type, setValue]);

	// ── Submit handler ──
	const doSubmit = useCallback(() => {
		// Panel input mode
		if (mode.type === "panel_input") {
			const trimmed = value.trim();
			if (!trimmed) return;
			const result = mode.config.onSubmit(trimmed);
			setValue("");
			setCursorOffset(0);
			handlePanelResult(result);
			return;
		}

		// Mention menu: select
		if (mode.type === "mention_menu") {
			const sel = mention.suggestions[mentionMenuIndex];
			if (sel) {
				applyMention(sel);
				return;
			}
		}

		// Slash menu: select and execute
		if (mode.type === "slash_menu") {
			const sel = getFilteredCommand(commands, slashFilter, slashMenuIndex);
			if (sel) {
				addToHistory(`/${sel.name}`);
				setValue("");
				setCursorOffset(0);
				setMode({ type: "normal" });
				if (sel.panel) {
					const pc = sel.panel();
					if (pc) {
						openPanelConfig(pc);
						return;
					}
				}
				onSlashExecuteRef.current(sel);
				return;
			}
		}

		// Normal submit
		const trimmed = value.trim();
		if (!trimmed && bufferedLines.length === 0) return;
		const fullInput =
			bufferedLines.length > 0 ? [...bufferedLines, value].join("\n") : value;
		const final = fullInput.trim();
		if (!final) return;

		// Resolve paste placeholders before submitting
		const resolved = resolvePastedTextPlaceholders(final, pastedTexts.current);

		addToHistory(final);
		setValue("");
		setCursorOffset(0);
		setBufferedLines([]);
		onSubmitRef.current(resolved);
	}, [
		mode,
		value,
		commands,
		slashFilter,
		slashMenuIndex,
		mention.suggestions,
		mentionMenuIndex,
		applyMention,
		addToHistory,
		setValue,
		bufferedLines,
		handlePanelResult,
		openPanelConfig,
	]);

	// ── Single useInput dispatcher ──
	useInput(
		(input, key) => {
			// ── Bracketed paste buffering (must be checked before any key handling) ──
			// When paste mode is active, buffer everything except the end marker.
			// Terminal sends \x1b[200~...text...\x1b[201~ which Ink splits into
			// multiple events. The markers arrive as "[200~" / "[201~" (ESC stripped).
			if (pasteBuffering.current) {
				// Check for paste end marker
				if (input && input.includes("[201~")) {
					const beforeMarker = input.split("[201~")[0];
					if (beforeMarker) pasteBuffer.current.push(beforeMarker);
					pasteBuffering.current = false;
					const fullPaste = pasteBuffer.current.join("");
					pasteBuffer.current = [];
					if (fullPaste) insertPastedText(fullPaste);
					return;
				}
				// Buffer text content; restore newlines from return/enter keys
				if (key.return) {
					pasteBuffer.current.push("\n");
				} else if (input) {
					pasteBuffer.current.push(input);
				}
				return;
			}
			// Check for paste start marker (outside paste mode)
			if (input && input.includes("[200~")) {
				pasteBuffering.current = true;
				pasteBuffer.current = [];
				const afterMarker = input.split("[200~").slice(1).join("[200~");
				if (afterMarker) pasteBuffer.current.push(afterMarker);
				return;
			}

			// ── Global keys: always fire regardless of input stack ──
			// Ctrl+C: interrupt / double-press exit (separate from Esc)
			if (key.ctrl && input === "c") {
				handleCtrlC();
				return;
			}

			// Ctrl+D: direct exit (no double-press required)
			if (key.ctrl && input === "d") {
				onExitRef.current();
				return;
			}

			// Esc: if input stack layer is active, let it handle Esc first
			if (key.escape) {
				const topHandler = getTopHandler();
				if (topHandler) {
					topHandler(input, key);
					return;
				}
				handleEscape();
				return;
			}

			// ── Input stack: if a layer is active, route all other keys to it ──
			const topHandler = getTopHandler();
			if (topHandler) {
				topHandler(input, key);
				return;
			}

			// ── Default handler (no stack layers) ──
			const m = mode.type;

			// ── Ctrl shortcuts ──
			if (key.ctrl) {
				// Ctrl+C already handled above as global key
				if (input === "v") {
					pasteClipboard();
					return;
				}
				if (m === "normal" || m === "slash_menu" || m === "mention_menu") {
					if (input === "x") {
						setShellMode((prev) => {
							const next = !prev;
							onNotifyRef.current("Mode", next ? "Shell mode" : "Agent mode");
							return next;
						});
						return;
					}
					if (input === "o") {
						onOpenEditorRef.current();
						return;
					}
					if (input === "j") {
						setBufferedLines((prev) => [...prev, value]);
						setValue("");
						setCursorOffset(0);
						return;
					}
				}
				return;
			}

			// ── Escape already handled above as global key ──

			// ── Normal / slash / mention / panel_input ──

			if (key.shift && key.tab && m !== "panel_input") {
				onPlanModeToggleRef.current();
				return;
			}

			if (key.tab && m !== "panel_input") {
				if (m === "mention_menu") {
					const sel = mention.suggestions[mentionMenuIndex];
					if (sel) applyMention(sel);
				} else if (m === "slash_menu") {
					const sel = getFilteredCommand(commands, slashFilter, slashMenuIndex);
					if (sel) {
						setValue(`/${sel.name} `);
						setCursorOffset(`/${sel.name} `.length);
					}
				}
				return;
			}

			if (key.return) {
				doSubmit();
				return;
			}

			if (key.upArrow) {
				if (m === "mention_menu")
					setMentionMenuIndex((i) => Math.max(0, i - 1));
				else if (m === "slash_menu")
					setSlashMenuIndex((i) => Math.max(0, i - 1));
				else if (m === "normal") historyPrev();
				return;
			}
			if (key.downArrow) {
				if (m === "mention_menu")
					setMentionMenuIndex((i) =>
						Math.min(mention.suggestions.length - 1, i + 1),
					);
				else if (m === "slash_menu")
					setSlashMenuIndex((i) => Math.min(slashMenuCount - 1, i + 1));
				else if (m === "normal") historyNext();
				return;
			}

			if (key.leftArrow) {
				setCursorOffset((prev) => Math.max(0, prev - 1));
				return;
			}
			if (key.rightArrow) {
				setCursorOffset((prev) => Math.min(value.length, prev + 1));
				return;
			}
			if (key.backspace || key.delete) {
				backspace();
				return;
			}

			// Handle input which may contain newlines from screen/tmux bulk paste
			if (input) {
				// Filter out CR/LF from the end and treat as Enter submission trigger
				const hasNewline = /[\r\n]$/.test(input);
				const cleanInput = input.replace(/[\r\n]+$/, "");

				if (cleanInput) {
					insertChar(cleanInput);
				}

				// If input ended with newline, treat as Enter submission
				if (hasNewline) {
					doSubmit();
				}
			}
		},
		{ isActive: !disabled },
	);

	return {
		value,
		cursorOffset,
		bufferedLines,
		mode,
		shellMode,
		slashFilter,
		slashMenuIndex,
		slashMenuCount,
		mentionSuggestions: mention.suggestions,
		mentionMenuIndex,
		showSlashMenu,
		showMentionMenu,
		openPanel: openPanelConfig,
		closePanel: useCallback(() => setMode({ type: "normal" }), []),
	};
}
