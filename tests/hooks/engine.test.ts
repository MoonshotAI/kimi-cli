/**
 * Tests for hooks/engine.ts — hook engine.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { HookEngine } from "../../src/kimi_cli_ts/hooks/engine.ts";
import { createTempDir, removeTempDir } from "../conftest.ts";

describe("HookEngine", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  // ── Basic setup ──────────────────────────────────────

  test("empty engine has no hooks", () => {
    const engine = new HookEngine({ cwd: tempDir });
    expect(engine.hasHooks).toBe(false);
    expect(engine.hasHooksFor("PreToolUse")).toBe(false);
  });

  test("engine with hooks reports hasHooks", () => {
    const engine = new HookEngine({
      hooks: [
        { event: "PreToolUse", command: "echo ok", matcher: "", timeout: 5 },
      ],
      cwd: tempDir,
    });
    expect(engine.hasHooks).toBe(true);
    expect(engine.hasHooksFor("PreToolUse")).toBe(true);
    expect(engine.hasHooksFor("PostToolUse")).toBe(false);
  });

  test("summary returns hook counts by event", () => {
    const engine = new HookEngine({
      hooks: [
        { event: "PreToolUse", command: "echo a", matcher: "", timeout: 5 },
        { event: "PreToolUse", command: "echo b", matcher: "", timeout: 5 },
        { event: "PostToolUse", command: "echo c", matcher: "", timeout: 5 },
      ],
      cwd: tempDir,
    });
    const summary = engine.summary;
    expect(summary["PreToolUse"]).toBe(2);
    expect(summary["PostToolUse"]).toBe(1);
  });

  // ── Matching ─────────────────────────────────────────

  test("trigger returns empty for unmatched event", async () => {
    const engine = new HookEngine({
      hooks: [
        { event: "PreToolUse", command: "echo ok", matcher: "", timeout: 5 },
      ],
      cwd: tempDir,
    });
    const results = await engine.trigger("PostToolUse", { inputData: {} });
    expect(results).toEqual([]);
  });

  test("trigger matches by event with empty matcher", async () => {
    const engine = new HookEngine({
      hooks: [
        { event: "PreToolUse", command: 'echo \'{"action":"allow"}\'', matcher: "", timeout: 5 },
      ],
      cwd: tempDir,
    });
    const results = await engine.trigger("PreToolUse", {
      matcherValue: "shell",
      inputData: { tool_name: "shell" },
    });
    expect(results.length).toBe(1);
    expect(results[0]!.action).toBe("allow");
  });

  test("matcher regex filters by target", async () => {
    const engine = new HookEngine({
      hooks: [
        { event: "PreToolUse", command: 'echo \'{"action":"block","reason":"no shell"}\'', matcher: "^shell$", timeout: 5 },
      ],
      cwd: tempDir,
    });

    // Matches "shell"
    const results = await engine.trigger("PreToolUse", {
      matcherValue: "shell",
      inputData: {},
    });
    expect(results.length).toBe(1);
    expect(results[0]!.action).toBe("block");

    // Does not match "read"
    const results2 = await engine.trigger("PreToolUse", {
      matcherValue: "read",
      inputData: {},
    });
    expect(results2).toEqual([]);
  });

  // ── Block/Allow ──────────────────────────────────────

  test("hook that outputs block action", async () => {
    const engine = new HookEngine({
      hooks: [
        {
          event: "PreToolUse",
          command: 'echo \'{"action":"block","reason":"blocked by policy"}\'',
          matcher: "",
          timeout: 5,
        },
      ],
      cwd: tempDir,
    });
    const results = await engine.trigger("PreToolUse", {
      inputData: { tool_name: "shell" },
    });
    expect(results[0]!.action).toBe("block");
    expect(results[0]!.reason).toBe("blocked by policy");
  });

  test("hook that exits non-zero fails open", async () => {
    const engine = new HookEngine({
      hooks: [
        {
          event: "PreToolUse",
          command: "exit 1",
          matcher: "",
          timeout: 5,
        },
      ],
      cwd: tempDir,
    });
    const results = await engine.trigger("PreToolUse", { inputData: {} });
    expect(results[0]!.action).toBe("allow");
  });

  test("hook with invalid JSON output fails open", async () => {
    const engine = new HookEngine({
      hooks: [
        {
          event: "PreToolUse",
          command: "echo 'not json'",
          matcher: "",
          timeout: 5,
        },
      ],
      cwd: tempDir,
    });
    const results = await engine.trigger("PreToolUse", { inputData: {} });
    expect(results[0]!.action).toBe("allow");
  });

  // ── Callbacks ────────────────────────────────────────

  test("onTriggered and onResolved callbacks fire", async () => {
    let triggered = false;
    let resolved = false;

    const engine = new HookEngine({
      hooks: [
        { event: "PreToolUse", command: "echo '{}'", matcher: "", timeout: 5 },
      ],
      cwd: tempDir,
      onTriggered: () => { triggered = true; },
      onResolved: () => { resolved = true; },
    });

    await engine.trigger("PreToolUse", { inputData: {} });
    expect(triggered).toBe(true);
    expect(resolved).toBe(true);
  });

  // ── addHooks ─────────────────────────────────────────

  test("addHooks dynamically adds hooks", async () => {
    const engine = new HookEngine({ cwd: tempDir });
    expect(engine.hasHooksFor("PreToolUse")).toBe(false);

    engine.addHooks([
      { event: "PreToolUse", command: "echo '{}'", matcher: "", timeout: 5 },
    ]);
    expect(engine.hasHooksFor("PreToolUse")).toBe(true);
  });

  // ── Deduplication ────────────────────────────────────

  test("duplicate commands are deduplicated", async () => {
    let callCount = 0;
    const engine = new HookEngine({
      hooks: [
        { event: "PreToolUse", command: "echo '{}'", matcher: "", timeout: 5 },
        { event: "PreToolUse", command: "echo '{}'", matcher: "", timeout: 5 }, // duplicate
      ],
      cwd: tempDir,
      onTriggered: (_e, _t, count) => { callCount = count; },
    });

    await engine.trigger("PreToolUse", { inputData: {} });
    expect(callCount).toBe(1); // deduplicated to 1
  });
});
