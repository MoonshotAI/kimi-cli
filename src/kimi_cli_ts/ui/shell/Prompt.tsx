/**
 * Prompt.tsx — Input prompt component with slash command completion.
 * Uses ✨ sparkles emoji matching Python version.
 * Slash menu renders BELOW the input (pushes up from bottom).
 */

import React, { useState, useCallback } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { useInputHistory } from "../hooks/useInput.ts";
import {
  SlashMenu,
  getFilteredCommandCount,
  getFilteredCommand,
} from "../components/SlashMenu.tsx";
import type { SlashCommand } from "../../types.ts";

interface PromptProps {
  onSubmit: (input: string) => void;
  onOpenPanel?: (cmd: SlashCommand) => void;
  disabled?: boolean;
  placeholder?: string;
  isStreaming?: boolean;
  planMode?: boolean;
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
  disabled = false,
  placeholder = "Send a message... (/ for commands)",
  isStreaming = false,
  planMode = false,
  commands = [],
  onSlashMenuChange,
  clearSignal = 0,
  prefillText,
}: PromptProps) {
  const { value, setValue, historyPrev, historyNext, addToHistory } =
    useInputHistory();

  const [slashMenuIndex, setSlashMenuIndex] = useState(0);

  // React to clearSignal from parent (double-Esc)
  React.useEffect(() => {
    if (clearSignal > 0) {
      setValue("");
    }
  }, [clearSignal, setValue]);

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

  // Notify parent about slash menu visibility
  React.useEffect(() => {
    onSlashMenuChange?.(showSlashMenu);
  }, [showSlashMenu, onSlashMenuChange]);

  // Reset menu index when filter changes
  React.useEffect(() => {
    setSlashMenuIndex(0);
  }, [slashFilter]);

  const handleChange = useCallback(
    (newValue: string) => {
      setValue(newValue);
    },
    [setValue],
  );

  const handleSubmit = useCallback(
    (input: string) => {
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
          // If the command has a panel, open it instead of submitting
          if (selected.panel && onOpenPanel) {
            onOpenPanel(selected);
            return;
          }
          onSubmit(cmd);
          return;
        }
      }

      const trimmed = input.trim();
      if (!trimmed) return;
      addToHistory(trimmed);
      setValue("");
      onSubmit(trimmed);
    },
    [
      onSubmit,
      onOpenPanel,
      addToHistory,
      setValue,
      showSlashMenu,
      commands,
      slashFilter,
      slashMenuIndex,
    ],
  );

  // Handle up/down/tab for navigation
  useInput(
    (_input, key) => {
      if (showSlashMenu) {
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

  return (
    <Box flexDirection="column">
      {/* Separator line above input */}
      <Text color="#555555">{"─".repeat(columns)}</Text>

      {/* Input line — always rendered, always on top */}
      <Box>
        <Text>{isStreaming ? "💫 " : planMode ? "📋 " : "✨ "}</Text>
        <TextInput
          value={value}
          onChange={handleChange}
          onSubmit={handleSubmit}
          placeholder={isStreaming ? "Type to steer the agent..." : placeholder}
        />
      </Box>

      {/* Slash command menu — renders below input, pushes up from bottom */}
      {showSlashMenu && (
        <SlashMenu
          commands={commands}
          filter={slashFilter}
          selectedIndex={slashMenuIndex}
        />
      )}
    </Box>
  );
}
