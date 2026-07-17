/**
 * Tests for ui/shell/slash.ts — slash command creation, parsing, finding.
 * Corresponds to Python tests/ui_and_conv/test_shell_slash_commands.py
 */

import { test, expect, describe } from "bun:test";
import {
  createShellSlashCommands,
  parseSlashCommand,
  findSlashCommand,
  type ShellSlashContext,
} from "../../src/kimi_cli_ts/ui/shell/slash";

// ── Helper: mock context ────────────────────────────────

function makeMockCtx(): ShellSlashContext {
  return {
    clearMessages: () => {},
    exit: () => {},
    setTheme: () => {},
  };
}

// ── createShellSlashCommands ────────────────────────────

describe("createShellSlashCommands", () => {
  test("returns a non-empty list of commands", () => {
    const cmds = createShellSlashCommands(makeMockCtx());
    expect(cmds.length).toBeGreaterThan(0);
  });

  test("includes expected command names", () => {
    const cmds = createShellSlashCommands(makeMockCtx());
    const names = cmds.map((c) => c.name);
    expect(names).toContain("clear");
    expect(names).toContain("exit");
    expect(names).toContain("help");
    expect(names).toContain("theme");
    expect(names).toContain("version");
  });

  test("each command has a handler function", () => {
    const cmds = createShellSlashCommands(makeMockCtx());
    for (const cmd of cmds) {
      expect(typeof cmd.handler).toBe("function");
    }
  });

  test("exit command has aliases", () => {
    const cmds = createShellSlashCommands(makeMockCtx());
    const exitCmd = cmds.find((c) => c.name === "exit");
    expect(exitCmd).toBeDefined();
    expect(exitCmd!.aliases).toContain("quit");
    expect(exitCmd!.aliases).toContain("q");
  });

  test("clear command has cls alias", () => {
    const cmds = createShellSlashCommands(makeMockCtx());
    const clearCmd = cmds.find((c) => c.name === "clear");
    expect(clearCmd).toBeDefined();
    expect(clearCmd!.aliases).toContain("cls");
  });
});

// ── parseSlashCommand ───────────────────────────────────

describe("parseSlashCommand", () => {
  test("returns null for non-slash input", () => {
    expect(parseSlashCommand("hello")).toBeNull();
    expect(parseSlashCommand("")).toBeNull();
  });

  test("returns null for bare slash", () => {
    expect(parseSlashCommand("/")).toBeNull();
    expect(parseSlashCommand("/  ")).toBeNull();
  });

  test("parses command without args", () => {
    const result = parseSlashCommand("/help");
    expect(result).toEqual({ name: "help", args: "" });
  });

  test("parses command with args", () => {
    const result = parseSlashCommand("/theme dark");
    expect(result).toEqual({ name: "theme", args: "dark" });
  });

  test("trims args", () => {
    const result = parseSlashCommand("/theme   light  ");
    expect(result).toEqual({ name: "theme", args: "light" });
  });
});

// ── findSlashCommand ────────────────────────────────────

describe("findSlashCommand", () => {
  const cmds = createShellSlashCommands(makeMockCtx());

  test("finds by exact name", () => {
    const found = findSlashCommand(cmds, "exit");
    expect(found).toBeDefined();
    expect(found!.name).toBe("exit");
  });

  test("finds by alias", () => {
    const found = findSlashCommand(cmds, "q");
    expect(found).toBeDefined();
    expect(found!.name).toBe("exit");
  });

  test("returns undefined for unknown command", () => {
    const found = findSlashCommand(cmds, "nonexistent");
    expect(found).toBeUndefined();
  });

  test("finds help by ? alias", () => {
    const found = findSlashCommand(cmds, "?");
    expect(found).toBeDefined();
    expect(found!.name).toBe("help");
  });
});
