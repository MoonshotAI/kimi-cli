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
 * This eliminates the multi-useInput conflict where ink-text-input's
 * internal useInput would receive leaked characters from Ctrl shortcuts.
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
import type { SlashCommand } from "../../types.ts";
import type { KeyAction } from "./keyboard.ts";

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
  /** Incremented by parent to signal "clear the input box" */
  clearSignal?: number;
  /** One-shot prefill text for the input (e.g. from /undo) */
  prefillText?: string;
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
  clearSignal = 0,
  prefillText,
}: PromptProps) {
  const { value, setValue, historyPrev, historyNext, addToHistory, isFromHistory } =
    useInputHistory();

  const [slashMenuIndex, setSlashMenuIndex] = useState(0);
  const [mentionMenuIndex, setMentionMenuIndex] = useState(0);
  const [bufferedLines, setBufferedLines] = useState<string[]>([]);
  const [cursorOffset, setCursorOffset] = useState(0);

  // @ file mention
  const mention = useFileMention(value, workDir);
  const showMentionMenu = mention.isActive && mention.suggestions.length > 0 && !shellMode;

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

  // Detect slash completion mode
  const isSlashMode =
    value.startsWith("/") && !value.includes(" ") && commands.length > 0 && !isFromHistory;
  const slashFilter = isSlashMode ? value.slice(1) : "";
  const menuCount = isSlashMode
    ? getFilteredCommandCount(commands, slashFilter)
    : 0;
  const showSlashMenu = isSlashMode && menuCount > 0;

  // Notify parent about menu visibility
  React.useEffect(() => {
    onSlashMenuChange?.(showSlashMenu || showMentionMenu);
  }, [showSlashMenu, showMentionMenu, onSlashMenuChange]);

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
      const selected = getFilteredCommand(commands, slashFilter, slashMenuIndex);
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
    const fullInput = bufferedLines.length > 0
      ? [...bufferedLines, value].join("\n")
      : value;
    const finalTrimmed = fullInput.trim();
    if (!finalTrimmed) return;
    addToHistory(finalTrimmed);
    setValue("");
    setCursorOffset(0);
    setBufferedLines([]);
    onSubmit(finalTrimmed);
  }, [
    value, onSubmit, onOpenPanel, addToHistory, setValue,
    showSlashMenu, showMentionMenu, commands, slashFilter,
    slashMenuIndex, mention.suggestions, mentionMenuIndex,
    applyMentionSelection, bufferedLines,
  ]);

  // Paste clipboard text directly into value
  const pasteClipboardIntoValue = useCallback(async () => {
    const commands = process.platform === "darwin"
      ? [["pbpaste"]]
      : [["xclip", "-selection", "clipboard", "-o"], ["xsel", "--clipboard", "--output"], ["wl-paste"]];
    for (const cmd of commands) {
      try {
        const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
        const text = await new Response(proc.stdout).text();
        const code = await proc.exited;
        if (code === 0 && text) {
          // Insert at cursor position
          const next = value.slice(0, cursorOffset) + text + value.slice(cursorOffset);
          setValue(next);
          setCursorOffset((prev) => prev + text.length);
          return;
        }
      } catch { /* try next */ }
    }
  }, [value, cursorOffset, setValue]);

  // ── Single unified useInput ──────────────────────────────
  useInput(
    (input, key) => {
      // ── Ctrl shortcuts → dispatch to parent, NO char insertion ──
      if (key.ctrl) {
        if (input === "c") { onAction?.("interrupt"); return; }
        if (input === "x") { onAction?.("toggle-shell-mode"); return; }
        if (input === "o") { onAction?.("open-editor"); return; }
        if (input === "v") {
        // Ctrl+V: paste clipboard directly into value
        pasteClipboardIntoValue();
        return;
      }
        if (input === "j") {
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

      // ── Shift+Tab → plan mode ──
      if (key.shift && key.tab) {
        onAction?.("toggle-plan-mode");
        return;
      }

      // ── Tab (no shift) → menu completion ──
      if (key.tab) {
        if (showMentionMenu) {
          const selected = mention.suggestions[mentionMenuIndex];
          if (selected) applyMentionSelection(selected);
        } else if (showSlashMenu) {
          const selected = getFilteredCommand(commands, slashFilter, slashMenuIndex);
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
        } else {
          historyPrev();
        }
        return;
      }
      if (key.downArrow) {
        if (showMentionMenu) {
          setMentionMenuIndex((i) => Math.min(mention.suggestions.length - 1, i + 1));
        } else if (showSlashMenu) {
          setSlashMenuIndex((i) => Math.min(menuCount - 1, i + 1));
        } else {
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
          const next = value.slice(0, cursorOffset - 1) + value.slice(cursorOffset);
          setValue(next);
          setCursorOffset((prev) => prev - 1);
        }
        return;
      }

      // ── Printable character → insert at cursor ──
      if (input) {
        const next = value.slice(0, cursorOffset) + input + value.slice(cursorOffset);
        setValue(next);
        setCursorOffset((prev) => prev + input.length);
      }
    },
    { isActive: !disabled },
  );

  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;

  // Prompt symbol
  const promptSymbol = shellMode ? "$ " : isStreaming ? "💫 " : planMode ? "📋 " : "✨ ";

  // Render value with fake cursor (matching ink-text-input style)
  const renderedValue = renderWithCursor(value, cursorOffset);

  return (
    <Box flexDirection="column">
      {/* Separator */}
      <Text color="#555555">{"─".repeat(columns)}</Text>

      {/* Buffered lines (multiline via Ctrl+J) */}
      {bufferedLines.map((line, i) => (
        <Box key={i}>
          <Text color="#555555">{i === 0 ? promptSymbol : "  "}</Text>
          <Text>{line}</Text>
        </Box>
      ))}

      {/* Input line with inline cursor */}
      <Box>
        <Text>{bufferedLines.length > 0 ? "  " : promptSymbol}</Text>
        <Text>{renderedValue}</Text>
      </Box>

      {/* Slash command menu */}
      {showSlashMenu && (
        <SlashMenu
          commands={commands}
          filter={slashFilter}
          selectedIndex={slashMenuIndex}
        />
      )}

      {/* @ file mention menu */}
      {showMentionMenu && !showSlashMenu && (
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
