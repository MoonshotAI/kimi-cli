/**
 * useInputHistory hook — manages input history and slash command parsing.
 * Corresponds to history logic in Python's prompt.py.
 */

import { useState, useCallback, useRef } from "react";
import type { SlashCommand } from "../../types";

export interface InputHistoryState {
  /** Current input value */
  value: string;
  /** Set input value */
  setValue: (v: string) => void;
  /** Navigate to previous history entry */
  historyPrev: () => void;
  /** Navigate to next history entry */
  historyNext: () => void;
  /** Add current value to history */
  addToHistory: (entry: string) => void;
  /** Check if current input is a slash command */
  isSlashCommand: boolean;
  /** Parse slash command name and args */
  parseSlashCommand: () => { name: string; args: string } | null;
}

/**
 * Hook for input history management and slash command parsing.
 */
export function useInputHistory(maxHistory = 100): InputHistoryState {
  const [value, setValue] = useState("");
  const history = useRef<string[]>([]);
  const historyIndex = useRef(-1);
  const savedInput = useRef("");

  const addToHistory = useCallback(
    (entry: string) => {
      const trimmed = entry.trim();
      if (!trimmed) return;
      // Deduplicate: remove if already exists at end
      if (
        history.current.length > 0 &&
        history.current[history.current.length - 1] === trimmed
      ) {
        // Already the last entry
      } else {
        history.current.push(trimmed);
        if (history.current.length > maxHistory) {
          history.current.shift();
        }
      }
      historyIndex.current = -1;
      savedInput.current = "";
    },
    [maxHistory],
  );

  const historyPrev = useCallback(() => {
    if (history.current.length === 0) return;
    if (historyIndex.current === -1) {
      savedInput.current = value;
      historyIndex.current = history.current.length - 1;
    } else if (historyIndex.current > 0) {
      historyIndex.current -= 1;
    }
    setValue(history.current[historyIndex.current] ?? "");
  }, [value]);

  const historyNext = useCallback(() => {
    if (historyIndex.current === -1) return;
    if (historyIndex.current < history.current.length - 1) {
      historyIndex.current += 1;
      setValue(history.current[historyIndex.current] ?? "");
    } else {
      historyIndex.current = -1;
      setValue(savedInput.current);
    }
  }, []);

  const isSlashCommand = value.startsWith("/");

  const parseSlashCommand = useCallback(() => {
    if (!value.startsWith("/")) return null;
    const trimmed = value.slice(1).trim();
    const spaceIdx = trimmed.indexOf(" ");
    if (spaceIdx === -1) {
      return { name: trimmed, args: "" };
    }
    return {
      name: trimmed.slice(0, spaceIdx),
      args: trimmed.slice(spaceIdx + 1).trim(),
    };
  }, [value]);

  return {
    value,
    setValue,
    historyPrev,
    historyNext,
    addToHistory,
    isSlashCommand,
    parseSlashCommand,
  };
}
