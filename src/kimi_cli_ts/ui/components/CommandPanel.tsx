/**
 * CommandPanel.tsx — Controlled panel components for slash commands.
 *
 * Two modes:
 * - ChoicePanel: selectable list (controlled via selectedIndex prop)
 * - ContentPanel: scrollable text (controlled via scrollOffset prop)
 *
 * No useInput inside — keyboard is handled by Shell's useShellInput dispatcher.
 * "input" type panels are handled by Prompt + useShellInput directly.
 */

import React from "react";
import { Box, Text, useStdout } from "ink";
import type { CommandPanelConfig } from "../../types.ts";

const DIM = "#888888";
const HIGHLIGHT = "#1e90ff";
const BORDER_COLOR = "#555555";

// ── Choice Panel (controlled) ───────────────────────────

interface ChoicePanelProps {
  config: Extract<CommandPanelConfig, { type: "choice" }>;
  selectedIndex: number;
}

export function ChoicePanel({ config, selectedIndex }: ChoicePanelProps) {
  const { items, title } = config;
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 24;

  const maxVisible = Math.max(rows - 8, 5);
  const total = items.length;

  // Compute visible window centered on selectedIndex
  let start = 0;
  if (total > maxVisible) {
    start = Math.max(
      0,
      Math.min(selectedIndex - Math.floor(maxVisible / 2), total - maxVisible),
    );
  }
  const visibleItems = items.slice(start, start + maxVisible);
  const hasMore = start + maxVisible < total;
  const hasPrev = start > 0;

  return (
    <Box flexDirection="column">
      <Text color={BORDER_COLOR}>{"─".repeat(columns)}</Text>
      <Box paddingX={1}>
        <Text bold color={HIGHLIGHT}>
          {title}
        </Text>
        <Text color={DIM}> (↑↓ select, Enter confirm, Esc cancel)</Text>
        {total > maxVisible && (
          <Text color={DIM}>{`  [${selectedIndex + 1}/${total}]`}</Text>
        )}
      </Box>
      <Text color={BORDER_COLOR}>{"─".repeat(columns)}</Text>
      {hasPrev && <Text color={DIM}>  ↑ more...</Text>}
      {visibleItems.map((item, vi) => {
        const i = start + vi;
        const isSelected = i === selectedIndex;
        return (
          <Box key={item.value} paddingX={1}>
            <Text color={isSelected ? HIGHLIGHT : DIM}>
              {isSelected ? "▸ " : "  "}
            </Text>
            <Text
              bold={isSelected}
              color={isSelected ? HIGHLIGHT : undefined}
            >
              {item.label}
            </Text>
            {item.description && (
              <Text color={DIM}>{"  " + item.description}</Text>
            )}
            {item.current && <Text color={DIM}> (current)</Text>}
          </Box>
        );
      })}
      {hasMore && <Text color={DIM}>  ↓ more...</Text>}
    </Box>
  );
}

// ── Content Panel (controlled) ──────────────────────────

interface ContentPanelProps {
  config: Extract<CommandPanelConfig, { type: "content" }>;
  scrollOffset: number;
}

export function ContentPanel({ config, scrollOffset }: ContentPanelProps) {
  const { content, title } = config;
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;
  const maxVisibleLines = Math.max((stdout?.rows ?? 24) - 8, 10);

  const lines = content.split("\n");
  const maxScroll = Math.max(0, lines.length - maxVisibleLines);
  const clampedOffset = Math.min(scrollOffset, maxScroll);
  const visibleLines = lines.slice(clampedOffset, clampedOffset + maxVisibleLines);
  const hasMore = clampedOffset < maxScroll;

  return (
    <Box flexDirection="column">
      <Text color={BORDER_COLOR}>{"─".repeat(columns)}</Text>
      <Box paddingX={1}>
        <Text bold color={HIGHLIGHT}>
          {title}
        </Text>
        <Text color={DIM}> (↑↓ scroll, Esc close)</Text>
        {maxScroll > 0 && (
          <Text color={DIM}>
            {`  [${clampedOffset + 1}-${Math.min(clampedOffset + maxVisibleLines, lines.length)}/${lines.length}]`}
          </Text>
        )}
      </Box>
      <Text color={BORDER_COLOR}>{"─".repeat(columns)}</Text>
      <Box flexDirection="column" paddingX={1}>
        {visibleLines.map((line, i) => (
          <Text key={clampedOffset + i}>{line || " "}</Text>
        ))}
      </Box>
      {hasMore && <Text color={DIM}>  ↓ more...</Text>}
    </Box>
  );
}
