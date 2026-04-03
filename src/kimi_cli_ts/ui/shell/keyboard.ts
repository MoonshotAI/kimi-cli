/**
 * Keyboard handling — corresponds to Python's ui/shell/keyboard.py
 * Uses Ink's useInput hook for keyboard events in the React tree.
 *
 * Behavior:
 * - Ctrl+C ×1: interrupt current streaming turn
 * - Ctrl+C ×2 (within 500ms): exit the application
 * - Esc ×1: interrupt current streaming turn
 * - Esc ×2 (within 500ms): clear the input box
 * - Shift+Tab: toggle plan mode
 */

import { useInput, useApp } from "ink";
import { useRef } from "react";

export type KeyAction =
  | "interrupt"
  | "exit"
  | "clear-input"
  | "toggle-plan-mode";

export interface UseKeyboardOptions {
  onAction: (action: KeyAction) => void;
  /** Whether keyboard input is active (default true) */
  active?: boolean;
}

const DOUBLE_PRESS_WINDOW = 500; // ms

/**
 * Hook that handles global keyboard shortcuts for the shell.
 *
 * Ctrl+C: 1st press = interrupt, 2nd press within 500ms = exit
 * Escape: 1st press = interrupt, 2nd press within 500ms = clear input
 */
export function useKeyboard({ onAction, active = true }: UseKeyboardOptions) {
  const { exit } = useApp();

  // Ctrl+C double-press tracking
  const ctrlCCount = useRef(0);
  const ctrlCTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Esc double-press tracking
  const escCount = useRef(0);
  const escTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useInput(
    (input, key) => {
      // ── Ctrl+C ────────────────────────────────────
      if (input === "c" && key.ctrl) {
        // Reset Esc counter on Ctrl+C
        escCount.current = 0;

        ctrlCCount.current += 1;
        if (ctrlCCount.current >= 2) {
          // Double Ctrl+C → exit
          ctrlCCount.current = 0;
          if (ctrlCTimer.current) clearTimeout(ctrlCTimer.current);
          exit();
          return;
        }
        // Start/reset the window timer
        if (ctrlCTimer.current) clearTimeout(ctrlCTimer.current);
        ctrlCTimer.current = setTimeout(() => {
          ctrlCCount.current = 0;
        }, DOUBLE_PRESS_WINDOW);
        onAction("interrupt");
        return;
      }

      // ── Escape ────────────────────────────────────
      if (key.escape) {
        // Reset Ctrl+C counter on Esc
        ctrlCCount.current = 0;

        escCount.current += 1;
        if (escCount.current >= 2) {
          // Double Esc → clear input
          escCount.current = 0;
          if (escTimer.current) clearTimeout(escTimer.current);
          onAction("clear-input");
          return;
        }
        // Start/reset the window timer
        if (escTimer.current) clearTimeout(escTimer.current);
        escTimer.current = setTimeout(() => {
          escCount.current = 0;
        }, DOUBLE_PRESS_WINDOW);
        onAction("interrupt");
        return;
      }

      // ── Shift+Tab ─────────────────────────────────
      if (key.shift && key.tab) {
        onAction("toggle-plan-mode");
        return;
      }

      // Any other key resets both counters
      ctrlCCount.current = 0;
      escCount.current = 0;
    },
    { isActive: active },
  );
}
