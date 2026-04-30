/**
 * Tests for ui/shell/keyboard.ts — KeyAction types and useKeyboard structure.
 * Note: We cannot test the React hook directly without rendering,
 * so we test exported types and the function's existence.
 */

import { test, expect, describe } from "bun:test";
import type { KeyAction, UseKeyboardOptions } from "../../src/kimi_cli_ts/ui/shell/keyboard";
import { useKeyboard } from "../../src/kimi_cli_ts/ui/shell/keyboard";

describe("keyboard types and exports", () => {
  test("KeyAction type covers expected actions", () => {
    const actions: KeyAction[] = [
      "submit",
      "interrupt",
      "escape",
      "history-prev",
      "history-next",
      "tab",
    ];
    expect(actions).toHaveLength(6);
  });

  test("useKeyboard is exported as a function", () => {
    expect(typeof useKeyboard).toBe("function");
  });

  test("UseKeyboardOptions interface accepts valid options", () => {
    const opts: UseKeyboardOptions = {
      onAction: (_action: KeyAction) => {},
      active: true,
    };
    expect(opts.active).toBe(true);
    expect(typeof opts.onAction).toBe("function");
  });
});
