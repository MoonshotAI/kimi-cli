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

const MAX_VISIBLE = 6;

export function SlashMenu({ commands, filter, selectedIndex }: SlashMenuProps) {
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;

  // Fuzzy filter commands
  const allFiltered = filterCommands(commands, filter);

  if (allFiltered.length === 0) return null;

  // Windowed display: show MAX_VISIBLE items around selectedIndex
  const total = allFiltered.length;
  let start = 0;
  if (total > MAX_VISIBLE) {
    // Keep selected item visible with some context
    start = Math.max(0, Math.min(selectedIndex - 2, total - MAX_VISIBLE));
  }
  const visible = allFiltered.slice(start, start + MAX_VISIBLE);
  const hasMore = total > MAX_VISIBLE;

  const separator = "─".repeat(columns);

  return (
    <Box flexDirection="column">
      <Text color={DIM}>{separator}</Text>
      {start > 0 && <Text color={DIM}>  ↑ {start} more</Text>}
      {visible.map((cmd, i) => {
        const realIndex = start + i;
        const isSelected = realIndex === selectedIndex;
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
      {start + MAX_VISIBLE < total && <Text color={DIM}>  ↓ {total - start - MAX_VISIBLE} more</Text>}
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
  return commands
    .map((cmd) => {
      const nameScore = fuzzyScore(cmd.name.toLowerCase(), lower);
      const aliasScores = (cmd.aliases ?? []).map((a) =>
        fuzzyScore(a.toLowerCase(), lower),
      );
      const best = Math.max(nameScore, ...aliasScores);
      return { cmd, score: best };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.cmd);
}

/**
 * Fuzzy match: characters of `pattern` must appear in `text` in order.
 * Returns a score > 0 on match (higher = tighter), 0 on miss.
 * Bonus for consecutive matches and prefix match.
 */
function fuzzyScore(text: string, pattern: string): number {
  let ti = 0;
  let pi = 0;
  let score = 0;
  let consecutive = 0;

  while (ti < text.length && pi < pattern.length) {
    if (text[ti] === pattern[pi]) {
      score += 1 + consecutive;
      consecutive++;
      // Bonus for matching at start
      if (ti === pi) score += 2;
      pi++;
    } else {
      consecutive = 0;
    }
    ti++;
  }
  return pi === pattern.length ? score : 0;
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
