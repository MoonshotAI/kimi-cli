/**
 * SlashMenu.tsx — Slash command completion menu.
 * Renders a list of matching commands when user types '/'.
 * Corresponds to Python's SlashCommandCompletionMenu.
 */

import React from "react";
import { Box, Text, useStdout } from "ink";
import type { SlashCommand } from "../../types.ts";

const DIM = "#888888";
const HIGHLIGHT_BG = "#1e90ff";

interface SlashMenuProps {
  /** All available commands */
  commands: SlashCommand[];
  /** Current filter text (what user typed after '/') */
  filter: string;
  /** Currently selected index */
  selectedIndex: number;
}

export function SlashMenu({ commands, filter, selectedIndex }: SlashMenuProps) {
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;

  // Fuzzy filter commands
  const filtered = filterCommands(commands, filter);

  if (filtered.length === 0) return null;

  const separator = "─".repeat(columns);

  return (
    <Box flexDirection="column">
      <Text color={DIM}>{separator}</Text>
      {filtered.map((cmd, i) => {
        const isSelected = i === selectedIndex;
        return (
          <Box key={cmd.name}>
            <Text color={isSelected ? HIGHLIGHT_BG : DIM}>
              {isSelected ? "▸ " : "  "}
            </Text>
            <Text bold={isSelected} color={isSelected ? HIGHLIGHT_BG : undefined}>
              /{cmd.name}
            </Text>
            <Text color={DIM}>
              {"  " + cmd.description}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

/** Fuzzy-filter commands by name or alias */
function filterCommands(
  commands: SlashCommand[],
  filter: string,
): SlashCommand[] {
  if (!filter) return commands;

  const lower = filter.toLowerCase();
  return commands.filter((cmd) => {
    if (cmd.name.toLowerCase().includes(lower)) return true;
    if (cmd.aliases) {
      return cmd.aliases.some((a) => a.toLowerCase().includes(lower));
    }
    return false;
  });
}

/** Get filtered command count (used by parent to know menu size) */
export function getFilteredCommandCount(
  commands: SlashCommand[],
  filter: string,
): number {
  return filterCommands(commands, filter).length;
}

/** Get the command at a given index after filtering */
export function getFilteredCommand(
  commands: SlashCommand[],
  filter: string,
  index: number,
): SlashCommand | undefined {
  const filtered = filterCommands(commands, filter);
  return filtered[index];
}
