/**
 * Prompt.tsx — Input prompt component with slash command + @ file mention completion.
 * Prompt symbols: $ (shell), 💫 (streaming), 📋 (plan), ✨ (agent default)
 * Slash menu and mention menu render BELOW the input.
 */

import React, { useState, useCallback } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { useInputHistory } from "../hooks/useInput.ts";
import { useFileMention, extractMentionFragment } from "../hooks/useFileMention.ts";
import {
  SlashMenu,
  getFilteredCommandCount,
  getFilteredCommand,
} from "../components/SlashMenu.tsx";
import { MentionMenu } from "../components/MentionMenu.tsx";
import type { SlashCommand } from "../../types.ts";

interface PromptProps {
  onSubmit: (input: string) => void;
  onOpenPanel?: (cmd: SlashCommand) => void;
  disabled?: boolean;
  placeholder?: string;
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
  /** Signal from parent to insert a newline (Ctrl+J) */
  newlineSignal?: number;
  /** Signal from parent to paste clipboard text */
  pasteText?: string;
}

export function Prompt({
  onSubmit,
  onOpenPanel,
  disabled = false,
  placeholder = "Send a message... (/ for commands)",
  isStreaming = false,
  planMode = false,
  shellMode = false,
  workDir,
  commands = [],
  onSlashMenuChange,
  clearSignal = 0,
  prefillText,
  newlineSignal = 0,
  pasteText,
}: PromptProps) {
  const { value, setValue, historyPrev, historyNext, addToHistory } =
    useInputHistory();

  const [slashMenuIndex, setSlashMenuIndex] = useState(0);
  const [mentionMenuIndex, setMentionMenuIndex] = useState(0);
  // Multiline buffer: lines accumulated via Ctrl+J
  const [bufferedLines, setBufferedLines] = useState<string[]>([]);

  // @ file mention
  const mention = useFileMention(value, workDir);
  const showMentionMenu = mention.isActive && mention.suggestions.length > 0 && !shellMode;

  // React to clearSignal from parent (double-Esc)
  React.useEffect(() => {
    if (clearSignal > 0) {
      setValue("");
      setBufferedLines([]);
    }
  }, [clearSignal, setValue]);

  // React to newlineSignal (Ctrl+J): push current line to buffer
  React.useEffect(() => {
    if (newlineSignal > 0) {
      setBufferedLines((prev) => [...prev, value]);
      setValue("");
    }
  }, [newlineSignal]); // intentionally omit value — capture at moment of signal

  // React to pasteText (Ctrl+V)
  React.useEffect(() => {
    if (pasteText) {
      setValue((prev) => prev + pasteText);
    }
  }, [pasteText, setValue]);

  // Consume one-shot prefill text
  React.useEffect(() => {
    if (prefillText) {
      setValue(prefillText);
    }
  }, [prefillText, setValue]);

  // Detect slash completion mode
  const isSlashMode =
    value.startsWith("/") && !value.includes(" ") && commands.length > 0;
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

  const handleChange = useCallback(
    (newValue: string) => {
      setValue(newValue);
    },
    [setValue],
  );

  // Apply a mention selection: replace @fragment with @path
  const applyMentionSelection = useCallback(
    (path: string) => {
      const atIdx = value.lastIndexOf("@");
      if (atIdx === -1) return;
      const newValue = value.slice(0, atIdx) + "@" + path + " ";
      setValue(newValue);
      setMentionMenuIndex(0);
    },
    [value, setValue],
  );

  const handleSubmit = useCallback(
    (input: string) => {
      // If mention menu is open, Tab/Enter selects the item
      if (showMentionMenu) {
        const selected = mention.suggestions[mentionMenuIndex];
        if (selected) {
          applyMentionSelection(selected);
          return;
        }
      }

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
          if (selected.panel && onOpenPanel) {
            onOpenPanel(selected);
            return;
          }
          onSubmit(cmd);
          return;
        }
      }

      const trimmed = input.trim();
      if (!trimmed && bufferedLines.length === 0) return;
      // Combine buffered lines with current input
      const fullInput = bufferedLines.length > 0
        ? [...bufferedLines, input].join("\n")
        : input;
      const finalTrimmed = fullInput.trim();
      if (!finalTrimmed) return;
      addToHistory(finalTrimmed);
      setValue("");
      setBufferedLines([]);
      onSubmit(finalTrimmed);
    },
    [
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
    ],
  );

  // Handle up/down/tab for navigation
  useInput(
    (_input, key) => {
      if (showMentionMenu) {
        if (key.upArrow) {
          setMentionMenuIndex((i) => Math.max(0, i - 1));
        } else if (key.downArrow) {
          setMentionMenuIndex((i) => Math.min(mention.suggestions.length - 1, i + 1));
        } else if (key.tab && !key.shift) {
          const selected = mention.suggestions[mentionMenuIndex];
          if (selected) {
            applyMentionSelection(selected);
          }
        }
      } else if (showSlashMenu) {
        if (key.upArrow) {
          setSlashMenuIndex((i) => Math.max(0, i - 1));
        } else if (key.downArrow) {
          setSlashMenuIndex((i) => Math.min(menuCount - 1, i + 1));
        } else if (key.tab && !key.shift) {
          const selected = getFilteredCommand(
            commands,
            slashFilter,
            slashMenuIndex,
          );
          if (selected) {
            setValue(`/${selected.name} `);
          }
        }
      } else {
        if (key.upArrow) historyPrev();
        else if (key.downArrow) historyNext();
      }
    },
    { isActive: !disabled },
  );

  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;

  // Prompt symbol: $ (shell) > 💫 (streaming) > 📋 (plan) > ✨ (default)
  const promptSymbol = shellMode ? "$ " : isStreaming ? "💫 " : planMode ? "📋 " : "✨ ";

  return (
    <Box flexDirection="column">
      {/* Separator line above input */}
      <Text color="#555555">{"─".repeat(columns)}</Text>

      {/* Buffered lines (multiline via Ctrl+J) */}
      {bufferedLines.map((line, i) => (
        <Box key={i}>
          <Text color="#555555">{i === 0 ? promptSymbol : "  "}</Text>
          <Text>{line}</Text>
        </Box>
      ))}

      {/* Input line */}
      <Box>
        <Text>{bufferedLines.length > 0 ? "  " : promptSymbol}</Text>
        <TextInput
          value={value}
          onChange={handleChange}
          onSubmit={handleSubmit}
          placeholder={isStreaming ? "Type to steer the agent..." : shellMode ? "Enter shell command..." : placeholder}
        />
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
