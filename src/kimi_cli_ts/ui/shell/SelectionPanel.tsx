/**
 * SelectionPanel.tsx — Reusable selection panel with optional inline text input.
 *
 * A bordered panel that displays a list of numbered options with keyboard
 * navigation. One or more options can be marked as `inputMode`, which turns
 * them into inline text fields when selected.
 *
 * Features:
 * - ↑/↓ circular navigation with number-key shortcuts (1-N)
 * - Inline text input for options with `inputMode: true`
 * - Draft persistence when navigating away from input options
 * - Captures ALL keyboard input via useInputLayer (nothing leaks)
 *
 * Used by ApprovalPanel and any future panel that needs option selection.
 */

import React, { useState, useRef } from "react";
import { Box, Text } from "ink";
import { useInputLayer } from "./input-stack.ts";

// ── Types ────────────────────────────────────────────────

export interface SelectionOption {
  label: string;
  /** If true, selecting this option enters inline text input mode. */
  inputMode?: boolean;
  /** Prefix shown before the input cursor (e.g. "Reject: "). Defaults to label + ": ". */
  inputPrefix?: string;
}

export interface SelectionPanelProps {
  /** Options to display. */
  options: SelectionOption[];
  /** Called when user confirms a non-input option (Enter or number key). */
  onSelect: (index: number) => void;
  /** Called when user submits text from an inputMode option. */
  onInputSubmit?: (index: number, text: string) => void;
  /** Called on Escape. */
  onCancel?: () => void;
  /** Content rendered above the options (children slot). */
  children?: React.ReactNode;
  /** Border color. Default: "yellow". */
  borderColor?: string;
  /** Title text shown at top of panel. */
  title?: string;
  /** Title color. Default: same as borderColor. */
  titleColor?: string;
  /** Extra hint text appended after the standard keyboard hints. */
  extraHint?: string;
}

// ── Component ────────────────────────────────────────────

export function SelectionPanel({
  options,
  onSelect,
  onInputSubmit,
  onCancel,
  children,
  borderColor = "yellow",
  title,
  titleColor,
  extraHint,
}: SelectionPanelProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [inputText, setInputText] = useState("");
  const inputDraftRef = useRef("");

  const isInputActive = !!options[selectedIndex]?.inputMode;
  const optCount = options.length;

  useInputLayer((input, key) => {
    if (isInputActive) {
      // ── INPUT MODE ──
      if (key.return || key.enter) {
        const text = inputText.trim();
        if (text) {
          setInputText("");
          inputDraftRef.current = "";
          onInputSubmit?.(selectedIndex, text);
        }
        // Empty enter: keep editing (matches Python)
        return;
      }

      if (key.escape) {
        setInputText("");
        inputDraftRef.current = "";
        onCancel?.();
        return;
      }

      if (key.upArrow) {
        inputDraftRef.current = inputText;
        setInputText("");
        setSelectedIndex((i) => (i - 1 + optCount) % optCount);
        return;
      }

      if (key.downArrow) {
        inputDraftRef.current = inputText;
        setInputText("");
        setSelectedIndex((i) => (i + 1) % optCount);
        return;
      }

      if (key.backspace || key.delete) {
        setInputText((t) => t.slice(0, -1));
        return;
      }

      if (input && !key.ctrl && !key.meta) {
        setInputText((t) => t + input);
        return;
      }

      return; // Consume everything in input mode
    }

    // ── SELECTION MODE ──
    if (key.upArrow) {
      setSelectedIndex((prev) => {
        const next = (prev - 1 + optCount) % optCount;
        if (options[next]?.inputMode && inputDraftRef.current) {
          setInputText(inputDraftRef.current);
        }
        return next;
      });
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((prev) => {
        const next = (prev + 1) % optCount;
        if (options[next]?.inputMode && inputDraftRef.current) {
          setInputText(inputDraftRef.current);
        }
        return next;
      });
      return;
    }

    if (key.return || key.enter) {
      inputDraftRef.current = "";
      onSelect(selectedIndex);
      return;
    }

    if (key.escape) {
      onCancel?.();
      return;
    }

    // Number keys 1-9 (up to option count)
    if (input >= "1" && input <= "9") {
      const idx = parseInt(input) - 1;
      if (idx < optCount) {
        setSelectedIndex(idx);
        if (options[idx]?.inputMode) {
          // Enter input mode; restore draft if available
          if (inputDraftRef.current) {
            setInputText(inputDraftRef.current);
          }
        } else {
          inputDraftRef.current = "";
          onSelect(idx);
        }
      }
      return;
    }

    // Consume all other keys
  });

  const effectiveTitleColor = titleColor ?? borderColor;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
    >
      {/* Title */}
      {title && (
        <>
          <Text color={effectiveTitleColor} bold>
            {title}
          </Text>
          <Text>{" "}</Text>
        </>
      )}

      {/* Content slot */}
      {children}

      {children && <Text>{" "}</Text>}

      {/* Options */}
      {options.map((option, i) => {
        const num = i + 1;
        const isSelected = i === selectedIndex;

        // Input mode rendering
        if (option.inputMode && isInputActive && isSelected) {
          const prefix = option.inputPrefix ?? `${option.label}: `;
          return (
            <Text key={i} color="cyan">
              → [{num}] {prefix}{inputText}█
            </Text>
          );
        }

        return (
          <Text key={i} color={isSelected ? "cyan" : "grey"}>
            {isSelected ? "→" : " "} [{num}] {option.label}
          </Text>
        );
      })}

      <Text>{" "}</Text>

      {/* Keyboard hints */}
      {isInputActive ? (
        <Text dimColor>
          {"  "}Type your feedback, then press Enter to submit.
        </Text>
      ) : (
        <Text dimColor>
          {"  "}▲/▼ select{"  "}
          {optCount <= 9 ? `1/${optCount}` : "1-9"} choose{"  "}↵ confirm
          {extraHint ?? ""}
        </Text>
      )}
    </Box>
  );
}
