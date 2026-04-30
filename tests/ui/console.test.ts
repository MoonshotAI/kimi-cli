/**
 * Tests for ui/shell/console.ts — terminal size detection.
 */

import { test, expect, describe } from "bun:test";
import { getTerminalSize, onResize } from "../../src/kimi_cli_ts/ui/shell/console";

describe("getTerminalSize", () => {
  test("returns an object with columns and rows", () => {
    const size = getTerminalSize();
    expect(typeof size.columns).toBe("number");
    expect(typeof size.rows).toBe("number");
  });

  test("columns and rows are positive", () => {
    const size = getTerminalSize();
    expect(size.columns).toBeGreaterThan(0);
    expect(size.rows).toBeGreaterThan(0);
  });

  test("defaults to at least 80x24", () => {
    const size = getTerminalSize();
    expect(size.columns).toBeGreaterThanOrEqual(80);
    expect(size.rows).toBeGreaterThanOrEqual(24);
  });
});

describe("onResize", () => {
  test("returns an unsubscribe function", () => {
    const unsub = onResize(() => {});
    expect(typeof unsub).toBe("function");
    // Clean up
    unsub();
  });
});
