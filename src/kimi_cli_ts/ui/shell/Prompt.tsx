/**
 * Prompt.tsx — Unified input prompt component.
 *
 * Uses a SINGLE useInput hook to handle ALL keyboard events:
 * - Ctrl shortcuts (X/O/V/J/C) → dispatched to parent via onAction
 * - Arrow keys → menu navigation or history
 * - Tab → menu completion
 * - Enter → submit or menu select
 * - Printable chars → append to value
 * - Backspace/Delete → remove char
 * - Left/Right → cursor movement
 *
 * Also supports panelInput mode: when a CommandPanel config with type="input"
 * is active, Prompt acts as that panel's input field (title shown, password
 * masking, Enter submits to panel callback).
 */

import React, { useState, useCallback, useRef } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import chalk from "chalk";
import { useInputHistory } from "../hooks/useInput.ts";
import { useFileMention } from "../hooks/useFileMention.ts";
import {
	SlashMenu,
	getFilteredCommandCount,
	getFilteredCommand,
} from "../components/SlashMenu.tsx";
import { MentionMenu } from "../components/MentionMenu.tsx";
import type { SlashCommand, CommandPanelConfig } from "../../types.ts";
import type { KeyAction } from "./keyboard.ts";

type PanelInputConfig = Extract<CommandPanelConfig, { type: "input" }>;

interface PromptProps {
	onSubmit: (input: string) => void;
	onOpenPanel?: (cmd: SlashCommand) => void;
	onAction?: (action: KeyAction) => void;
	disabled?: boolean;
	isStreaming?: boolean;
	planMode?: boolean;
	shellMode?: boolean;
	workDir?: string;
	commands?: SlashCommand[];
	onSlashMenuChange?: (visible: boolean) => void;
	/** Called with the menu ReactNode to render outside Prompt (in the bottom slot) */
	onMenuPortal?: (menu: React.ReactNode) => void;
	/** Incremented by parent to signal "clear the input box" */
	clearSignal?: number;
	/** One-shot prefill text for the input (e.g. from /undo) */
	prefillText?: string;
	/** When set, Prompt acts as input for this panel config */
	panelInput?: PanelInputConfig | null;
	/** Called when panel input is submitted */
	onPanelInputSubmit?: (value: string) => void;
}

export function Prompt({
	onSubmit,
	onOpenPanel,
	onAction,
	disabled = false,
	isStreaming = false,
	planMode = false,
	shellMode = false,
	workDir,
	commands = [],
	onSlashMenuChange,
	onMenuPortal,
	clearSignal = 0,
	prefillText,
	panelInput = null,
	onPanelInputSubmit,
}: PromptProps) {
	const {
		value,
		setValue,
		historyPrev,
		historyNext,
		addToHistory,
		isBrowsingHistory,
	} = useInputHistory();

	const [slashMenuIndex, setSlashMenuIndex] = useState(0);
	const [mentionMenuIndex, setMentionMenuIndex] = useState(0);
	const [bufferedLines, setBufferedLines] = useState<string[]>([]);
	const [cursorOffset, setCursorOffset] = useState(0);

	// Track panel mode transitions: clear input when entering/leaving panel mode
	const prevPanelRef = useRef<PanelInputConfig | null>(null);
	React.useEffect(() => {
		const entering = panelInput && !prevPanelRef.current;
		const leaving = !panelInput && prevPanelRef.current;
		if (entering || leaving) {
			setValue("");
			setCursorOffset(0);
			setBufferedLines([]);
		}
		prevPanelRef.current = panelInput;
	}, [panelInput, setValue]);

	const inPanelMode = panelInput !== null;

	// @ file mention — disabled in panel mode
	const mention = useFileMention(inPanelMode ? "" : value, workDir);
	const showMentionMenu =
		!inPanelMode &&
		mention.isActive &&
		mention.suggestions.length > 0 &&
		!shellMode;

	// React to clearSignal from parent (double-Esc)
	React.useEffect(() => {
		if (clearSignal > 0) {
			setValue("");
			setBufferedLines([]);
			setCursorOffset(0);
		}
	}, [clearSignal, setValue]);

	// Consume one-shot prefill text
	React.useEffect(() => {
		if (prefillText) {
			setValue(prefillText);
			setCursorOffset(prefillText.length);
		}
	}, [prefillText, setValue]);

	// Keep cursor in bounds when value changes externally
	React.useEffect(() => {
		setCursorOffset((prev) => Math.min(prev, value.length));
	}, [value]);

	// Detect slash completion mode — disabled in panel mode
	const isSlashMode =
		!inPanelMode &&
		value.startsWith("/") &&
		!value.includes(" ") &&
		commands.length > 0 &&
		!isBrowsingHistory;
	const slashFilter = isSlashMode ? value.slice(1) : "";
	const menuCount = isSlashMode
		? getFilteredCommandCount(commands, slashFilter)
		: 0;
	const showSlashMenu = isSlashMode && menuCount > 0;

	// Stable ref for menu portal callback to avoid re-render loops
	const menuPortalRef = useRef(onMenuPortal);
	menuPortalRef.current = onMenuPortal;

	// Track what menu state we last sent to portal to avoid unnecessary updates
	const lastMenuKeyRef = useRef("");

	// Notify parent about menu visibility and provide menu content
	React.useEffect(() => {
		const hasMenu = showSlashMenu || showMentionMenu;
		onSlashMenuChange?.(hasMenu);

		// Build a stable key to detect actual changes
		const key = showSlashMenu
			? `slash:${slashFilter}:${slashMenuIndex}`
			: showMentionMenu
				? `mention:${mention.fragment}:${mentionMenuIndex}`
				: "none";

		if (key !== lastMenuKeyRef.current) {
			lastMenuKeyRef.current = key;
			const portal = menuPortalRef.current;
			if (portal) {
				if (showSlashMenu) {
					portal(
						<SlashMenu
							commands={commands}
							filter={slashFilter}
							selectedIndex={slashMenuIndex}
						/>,
					);
				} else if (showMentionMenu) {
					portal(
						<MentionMenu
							suggestions={mention.suggestions}
							selectedIndex={mentionMenuIndex}
						/>,
					);
				} else {
					portal(null);
				}
			}
		}
	}, [
		showSlashMenu,
		showMentionMenu,
		onSlashMenuChange,
		commands,
		slashFilter,
		slashMenuIndex,
		mention.suggestions,
		mention.fragment,
		mentionMenuIndex,
	]);

	// Reset menu indices when filter changes
	React.useEffect(() => {
		setSlashMenuIndex(0);
	}, [slashFilter]);

	React.useEffect(() => {
		setMentionMenuIndex(0);
	}, [mention.fragment]);

	// Apply a mention selection: replace @fragment with @path
	const applyMentionSelection = useCallback(
		(path: string) => {
			const atIdx = value.lastIndexOf("@");
			if (atIdx === -1) return;
			const newValue = value.slice(0, atIdx) + "@" + path + " ";
			setValue(newValue);
			setCursorOffset(newValue.length);
			setMentionMenuIndex(0);
		},
		[value, setValue],
	);

	// Submit handler
	const doSubmit = useCallback(() => {
		// ── Panel input mode: submit to panel callback ──
		if (inPanelMode && onPanelInputSubmit) {
			const trimmed = value.trim();
			if (!trimmed) return;
			onPanelInputSubmit(trimmed);
			setValue("");
			setCursorOffset(0);
			return;
		}

		// Mention menu: select item
		if (showMentionMenu) {
			const selected = mention.suggestions[mentionMenuIndex];
			if (selected) {
				applyMentionSelection(selected);
				return;
			}
		}

		// Slash menu: select and execute
		if (showSlashMenu) {
			const selected = getFilteredCommand(
				commands,
				slashFilter,
				slashMenuIndex,
			);
			if (selected) {
				const cmd = `/${selected.name}`;
				addToHistory(cmd);
				setValue("");
				setCursorOffset(0);
				if (selected.panel && onOpenPanel) {
					onOpenPanel(selected);
					return;
				}
				onSubmit(cmd);
				return;
			}
		}

		// Normal submit
		const trimmed = value.trim();
		if (!trimmed && bufferedLines.length === 0) return;
		const fullInput =
			bufferedLines.length > 0 ? [...bufferedLines, value].join("\n") : value;
		const finalTrimmed = fullInput.trim();
		if (!finalTrimmed) return;
		addToHistory(finalTrimmed);
		setValue("");
		setCursorOffset(0);
		setBufferedLines([]);
		onSubmit(finalTrimmed);
	}, [
		value,
		onSubmit,
		onOpenPanel,
		addToHistory,
		setValue,
		showSlashMenu,
		showMentionMenu,
		commands,
		slashFilter,
		slashMenuIndex,
		mention.suggestions,
		mentionMenuIndex,
		applyMentionSelection,
		bufferedLines,
		inPanelMode,
		onPanelInputSubmit,
	]);

	// Paste clipboard text directly into value
	const pasteClipboardIntoValue = useCallback(async () => {
		const commands =
			process.platform === "darwin"
				? [["pbpaste"]]
				: [
						["xclip", "-selection", "clipboard", "-o"],
						["xsel", "--clipboard", "--output"],
						["wl-paste"],
					];
		for (const cmd of commands) {
			try {
				const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
				const text = await new Response(proc.stdout).text();
				const code = await proc.exited;
				if (code === 0 && text) {
					// Insert at cursor position
					const next =
						value.slice(0, cursorOffset) + text + value.slice(cursorOffset);
					setValue(next);
					setCursorOffset((prev) => prev + text.length);
					return;
				}
			} catch {
				/* try next */
			}
		}
	}, [value, cursorOffset, setValue]);

	// ── Single unified useInput ──────────────────────────────
	useInput(
		(input, key) => {
			// ── Ctrl shortcuts → dispatch to parent, NO char insertion ──
			if (key.ctrl) {
				if (input === "c") {
					onAction?.("interrupt");
					return;
				}
				if (input === "x" && !inPanelMode) {
					onAction?.("toggle-shell-mode");
					return;
				}
				if (input === "o" && !inPanelMode) {
					onAction?.("open-editor");
					return;
				}
				if (input === "v") {
					// Ctrl+V: paste clipboard directly into value
					pasteClipboardIntoValue();
					return;
				}
				if (input === "j" && !inPanelMode) {
					// Ctrl+J: push current line to buffer (multiline)
					setBufferedLines((prev) => [...prev, value]);
					setValue("");
					setCursorOffset(0);
					return;
				}
				// Ctrl+D: ignore (or could exit)
				return;
			}

			// ── Escape ──
			if (key.escape) {
				onAction?.("interrupt");
				return;
			}

			// ── Shift+Tab → plan mode (not in panel mode) ──
			if (key.shift && key.tab && !inPanelMode) {
				onAction?.("toggle-plan-mode");
				return;
			}

			// ── Tab (no shift) → menu completion (not in panel mode) ──
			if (key.tab && !inPanelMode) {
				if (showMentionMenu) {
					const selected = mention.suggestions[mentionMenuIndex];
					if (selected) applyMentionSelection(selected);
				} else if (showSlashMenu) {
					const selected = getFilteredCommand(
						commands,
						slashFilter,
						slashMenuIndex,
					);
					if (selected) {
						setValue(`/${selected.name} `);
						setCursorOffset(`/${selected.name} `.length);
					}
				}
				return;
			}

			// ── Enter → submit ──
			if (key.return) {
				doSubmit();
				return;
			}

			// ── Arrow keys → menu navigation or history ──
			if (key.upArrow) {
				if (showMentionMenu) {
					setMentionMenuIndex((i) => Math.max(0, i - 1));
				} else if (showSlashMenu) {
					setSlashMenuIndex((i) => Math.max(0, i - 1));
				} else if (!inPanelMode) {
					historyPrev();
				}
				return;
			}
			if (key.downArrow) {
				if (showMentionMenu) {
					setMentionMenuIndex((i) =>
						Math.min(mention.suggestions.length - 1, i + 1),
					);
				} else if (showSlashMenu) {
					setSlashMenuIndex((i) => Math.min(menuCount - 1, i + 1));
				} else if (!inPanelMode) {
					historyNext();
				}
				return;
			}

			// ── Left/Right arrows → cursor movement ──
			if (key.leftArrow) {
				setCursorOffset((prev) => Math.max(0, prev - 1));
				return;
			}
			if (key.rightArrow) {
				setCursorOffset((prev) => Math.min(value.length, prev + 1));
				return;
			}

			// ── Backspace ──
			if (key.backspace || key.delete) {
				if (cursorOffset > 0) {
					const next =
						value.slice(0, cursorOffset - 1) + value.slice(cursorOffset);
					setValue(next);
					setCursorOffset((prev) => prev - 1);
				}
				return;
			}

			// ── Printable character → insert at cursor ──
			if (input) {
				const next =
					value.slice(0, cursorOffset) + input + value.slice(cursorOffset);
				setValue(next);
				setCursorOffset((prev) => prev + input.length);
			}
		},
		{ isActive: !disabled },
	);

	const { stdout } = useStdout();
	const columns = stdout?.columns ?? 80;

	// Prompt symbol — panel mode uses ▸, normal mode uses context-dependent emoji
	const promptSymbol = inPanelMode
		? "▸ "
		: shellMode
			? "$ "
			: isStreaming
				? "💫 "
				: planMode
					? "📋 "
					: "✨ ";

	// Render value with fake cursor (matching ink-text-input style)
	// In password mode, mask characters
	const displayValue =
		inPanelMode && panelInput?.password ? "•".repeat(value.length) : value;
	const renderedValue = renderWithCursor(
		displayValue,
		Math.min(cursorOffset, displayValue.length),
	);

	return (
		<Box flexDirection="column">
			{/* Separator */}
			<Text color="#555555">{"─".repeat(columns)}</Text>

			{/* Panel input title (when in panel mode) */}
			{inPanelMode && (
				<Box paddingX={1}>
					<Text bold color="#1e90ff">
						{panelInput!.title}
					</Text>
					<Text color="#888888"> (Enter submit, Esc cancel)</Text>
				</Box>
			)}

			{/* Buffered lines (multiline via Ctrl+J) — not in panel mode */}
			{!inPanelMode &&
				bufferedLines.map((line, i) => (
					<Box key={i}>
						<Text color="#555555">{i === 0 ? promptSymbol : "  "}</Text>
						<Text>{line}</Text>
					</Box>
				))}

			{/* Input line with inline cursor */}
			<Box>
				<Text>
					{!inPanelMode && bufferedLines.length > 0 ? "  " : promptSymbol}
				</Text>
				<Text>{renderedValue}</Text>
			</Box>

			{/* Menus rendered outside via onMenuPortal — only render inline if no portal */}
			{!onMenuPortal && !inPanelMode && showSlashMenu && (
				<SlashMenu
					commands={commands}
					filter={slashFilter}
					selectedIndex={slashMenuIndex}
				/>
			)}
			{!onMenuPortal && !inPanelMode && showMentionMenu && !showSlashMenu && (
				<MentionMenu
					suggestions={mention.suggestions}
					selectedIndex={mentionMenuIndex}
				/>
			)}
		</Box>
	);
}

/** Render text with a fake inverse cursor at the given offset. */
function renderWithCursor(text: string, offset: number): string {
	if (text.length === 0) {
		return chalk.inverse(" ");
	}
	const before = text.slice(0, offset);
	const cursorChar = offset < text.length ? text[offset]! : " ";
	const after = offset < text.length ? text.slice(offset + 1) : "";
	return before + chalk.inverse(cursorChar) + after;
}
