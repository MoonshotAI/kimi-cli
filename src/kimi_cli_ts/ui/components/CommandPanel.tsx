/**
 * CommandPanel.tsx — Secondary interactive panel for slash commands.
 * Renders below the input area when a command needs a secondary menu.
 *
 * Supports three modes:
 * - "choice": selectable list (↑↓ navigate, Enter select, Esc close)
 * - "content": scrollable text (↑↓ scroll, Esc close)
 * - "input": text input field (type, Enter submit, Esc close)
 *
 * Panels can chain: onSelect/onSubmit may return a new CommandPanelConfig
 * to transition to the next step (wizard pattern).
 */

import React, { useState, useCallback } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import type { CommandPanelConfig } from "../../types.ts";

const DIM = "#888888";
const HIGHLIGHT = "#1e90ff";
const BORDER_COLOR = "#555555";

interface CommandPanelProps {
  config: CommandPanelConfig;
  onClose: () => void;
}

export function CommandPanel({ config, onClose }: CommandPanelProps) {
  // Support panel transitions: when a child panel returns a new config,
  // we replace the current config with the new one.
  const [currentConfig, setCurrentConfig] = useState(config);

  // Reset when external config changes (e.g. opening a different command panel)
  React.useEffect(() => {
    setCurrentConfig(config);
  }, [config]);

  const handleTransition = useCallback(
    (result: CommandPanelConfig | Promise<CommandPanelConfig | void> | void) => {
      if (!result) return;
      if (result instanceof Promise) {
        result.then((next) => {
          if (next) setCurrentConfig(next);
        });
      } else {
        setCurrentConfig(result);
      }
    },
    [],
  );

  if (currentConfig.type === "choice") {
    return <ChoicePanel config={currentConfig} onClose={onClose} onTransition={handleTransition} />;
  }
  if (currentConfig.type === "input") {
    return <InputPanel config={currentConfig} onClose={onClose} onTransition={handleTransition} />;
  }
  return <ContentPanel config={currentConfig} onClose={onClose} />;
}

// ── Choice Panel ────────────────────────────────────────

function ChoicePanel({
  config,
  onClose,
  onTransition,
}: {
  config: Extract<CommandPanelConfig, { type: "choice" }>;
  onClose: () => void;
  onTransition: (result: CommandPanelConfig | Promise<CommandPanelConfig | void> | void) => void;
}) {
  const { items, onSelect, title } = config;
  const defaultIndex = items.findIndex((item) => item.current);
  const [selectedIndex, setSelectedIndex] = useState(
    defaultIndex >= 0 ? defaultIndex : 0,
  );
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;

  useInput(
    useCallback(
      (_input: string, key: { upArrow?: boolean; downArrow?: boolean; return?: boolean; escape?: boolean }) => {
        if (key.escape) {
          onClose();
          return;
        }
        if (key.upArrow) {
          setSelectedIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (key.downArrow) {
          setSelectedIndex((i) => Math.min(items.length - 1, i + 1));
          return;
        }
        if (key.return) {
          const item = items[selectedIndex];
          if (item) {
            const result = onSelect(item.value);
            if (result) {
              onTransition(result);
            } else {
              onClose();
            }
          }
          return;
        }
      },
      [items, selectedIndex, onSelect, onClose, onTransition],
    ),
  );

  return (
    <Box flexDirection="column">
      <Text color={BORDER_COLOR}>{"─".repeat(columns)}</Text>
      <Box paddingX={1}>
        <Text bold color={HIGHLIGHT}>
          {title}
        </Text>
        <Text color={DIM}> (↑↓ select, Enter confirm, Esc cancel)</Text>
      </Box>
      <Text color={BORDER_COLOR}>{"─".repeat(columns)}</Text>
      {items.map((item, i) => {
        const isSelected = i === selectedIndex;
        return (
          <Box key={item.value} paddingX={1}>
            <Text color={isSelected ? HIGHLIGHT : DIM}>
              {isSelected ? "▸ " : "  "}
            </Text>
            <Text bold={isSelected} color={isSelected ? HIGHLIGHT : undefined}>
              {item.label}
            </Text>
            {item.description && (
              <Text color={DIM}>{"  " + item.description}</Text>
            )}
            {item.current && (
              <Text color={DIM}> (current)</Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

// ── Input Panel ─────────────────────────────────────────

function InputPanel({
  config,
  onClose,
  onTransition,
}: {
  config: Extract<CommandPanelConfig, { type: "input" }>;
  onClose: () => void;
  onTransition: (result: CommandPanelConfig | Promise<CommandPanelConfig | void> | void) => void;
}) {
  const { title, placeholder, password, onSubmit } = config;
  const [value, setValue] = useState("");
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;

  useInput(
    useCallback(
      (_input: string, key: { escape?: boolean }) => {
        if (key.escape) {
          onClose();
        }
      },
      [onClose],
    ),
  );

  const handleSubmit = useCallback(
    (input: string) => {
      const trimmed = input.trim();
      if (!trimmed) return;
      const result = onSubmit(trimmed);
      if (result) {
        onTransition(result);
      } else {
        onClose();
      }
    },
    [onSubmit, onClose, onTransition],
  );

  // For password fields, mask the input
  const displayValue = password ? "•".repeat(value.length) : value;

  return (
    <Box flexDirection="column">
      <Text color={BORDER_COLOR}>{"─".repeat(columns)}</Text>
      <Box paddingX={1}>
        <Text bold color={HIGHLIGHT}>
          {title}
        </Text>
        <Text color={DIM}> (Enter submit, Esc cancel)</Text>
      </Box>
      <Text color={BORDER_COLOR}>{"─".repeat(columns)}</Text>
      <Box paddingX={1}>
        <Text>{"▸ "}</Text>
        {password ? (
          <TextInput
            value={value}
            onChange={setValue}
            onSubmit={handleSubmit}
            placeholder={placeholder ?? ""}
            mask="•"
          />
        ) : (
          <TextInput
            value={value}
            onChange={setValue}
            onSubmit={handleSubmit}
            placeholder={placeholder ?? ""}
          />
        )}
      </Box>
    </Box>
  );
}

// ── Content Panel ───────────────────────────────────────

function ContentPanel({
  config,
  onClose,
}: {
  config: Extract<CommandPanelConfig, { type: "content" }>;
  onClose: () => void;
}) {
  const { content, title } = config;
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;
  const maxVisibleLines = Math.max((stdout?.rows ?? 24) - 8, 10);

  const lines = content.split("\n");
  const [scrollOffset, setScrollOffset] = useState(0);
  const maxScroll = Math.max(0, lines.length - maxVisibleLines);

  useInput(
    useCallback(
      (_input: string, key: { upArrow?: boolean; downArrow?: boolean; escape?: boolean }) => {
        if (key.escape) {
          onClose();
          return;
        }
        if (key.upArrow) {
          setScrollOffset((o) => Math.max(0, o - 1));
          return;
        }
        if (key.downArrow) {
          setScrollOffset((o) => Math.min(maxScroll, o + 1));
          return;
        }
      },
      [maxScroll, onClose],
    ),
  );

  const visibleLines = lines.slice(scrollOffset, scrollOffset + maxVisibleLines);
  const hasMore = scrollOffset < maxScroll;

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
            {`  [${scrollOffset + 1}-${Math.min(scrollOffset + maxVisibleLines, lines.length)}/${lines.length}]`}
          </Text>
        )}
      </Box>
      <Text color={BORDER_COLOR}>{"─".repeat(columns)}</Text>
      <Box flexDirection="column" paddingX={1}>
        {visibleLines.map((line, i) => (
          <Text key={scrollOffset + i}>{line || " "}</Text>
        ))}
      </Box>
      {hasMore && (
        <Text color={DIM}>  ↓ more...</Text>
      )}
    </Box>
  );
}
