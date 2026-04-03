/**
 * Tests for ui/theme.ts — theme switching, color getters.
 * Corresponds to Python tests/ui_and_conv/test_theme.py
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  setActiveTheme,
  getActiveTheme,
  getDiffColors,
  getToolbarColors,
  getMcpPromptColors,
  getMessageColors,
  getStyles,
  type ThemeName,
} from "../../src/kimi_cli_ts/ui/theme";

// Reset theme around every test
beforeEach(() => setActiveTheme("dark"));
afterEach(() => setActiveTheme("dark"));

// ── set / get ───────────────────────────────────────────

describe("setActiveTheme / getActiveTheme", () => {
  test("defaults to dark", () => {
    expect(getActiveTheme()).toBe("dark");
  });

  test("can switch to light and back", () => {
    setActiveTheme("light");
    expect(getActiveTheme()).toBe("light");
    setActiveTheme("dark");
    expect(getActiveTheme()).toBe("dark");
  });
});

// ── Diff colors ─────────────────────────────────────────

describe("getDiffColors", () => {
  test("dark theme returns dark add background", () => {
    const colors = getDiffColors();
    expect(colors.addBg).toBe("#12261e");
  });

  test("light theme returns light add background", () => {
    setActiveTheme("light");
    const colors = getDiffColors();
    expect(colors.addBg).toBe("#dafbe1");
  });
});

// ── All getters respond to theme switch ─────────────────

describe("color getters respond to theme switch", () => {
  test("diff colors differ between themes", () => {
    const darkDiff = getDiffColors();
    setActiveTheme("light");
    const lightDiff = getDiffColors();
    expect(darkDiff.addBg).not.toBe(lightDiff.addBg);
  });

  test("toolbar colors differ between themes", () => {
    const darkToolbar = getToolbarColors();
    setActiveTheme("light");
    const lightToolbar = getToolbarColors();
    expect(darkToolbar.separator).not.toBe(lightToolbar.separator);
  });

  test("mcp prompt colors differ between themes", () => {
    const darkMcp = getMcpPromptColors();
    setActiveTheme("light");
    const lightMcp = getMcpPromptColors();
    expect(darkMcp.text).not.toBe(lightMcp.text);
  });

  test("message colors differ between themes", () => {
    const darkMsg = getMessageColors();
    setActiveTheme("light");
    const lightMsg = getMessageColors();
    expect(darkMsg.user).not.toBe(lightMsg.user);
  });
});

// ── getStyles ───────────────────────────────────────────

describe("getStyles", () => {
  test("returns ThemeStyles with expected keys", () => {
    const styles = getStyles();
    expect(styles.user).toBeDefined();
    expect(styles.assistant).toBeDefined();
    expect(styles.system).toBeDefined();
    expect(styles.tool).toBeDefined();
    expect(styles.error).toBeDefined();
    expect(styles.dim).toBeDefined();
    expect(styles.thinking).toBeDefined();
    expect(styles.highlight).toBeDefined();
    expect(styles.bold).toBeDefined();
    expect(styles.italic).toBeDefined();
  });

  test("styles are callable (ChalkInstance)", () => {
    const styles = getStyles();
    expect(typeof styles.user).toBe("function");
    const result = styles.user("hello");
    expect(typeof result).toBe("string");
  });
});
