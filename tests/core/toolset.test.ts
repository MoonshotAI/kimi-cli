/**
 * Tests for soul/toolset.ts — tool registry with hooks.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { z } from "zod/v4";
import { KimiToolset } from "../../src/kimi_cli_ts/soul/toolset.ts";
import { CallableTool } from "../../src/kimi_cli_ts/tools/base.ts";
import { HookEngine } from "../../src/kimi_cli_ts/hooks/engine.ts";
import type { ToolContext, ToolResult } from "../../src/kimi_cli_ts/tools/types.ts";
import { createTempDir, removeTempDir, createTestToolContext } from "../conftest.ts";

// ── Stub tool ─────────────────────────────────────

class EchoTool extends CallableTool<typeof EchoTool.Schema> {
  static readonly Schema = z.object({ text: z.string() });
  readonly name = "echo";
  readonly description = "Echo text";
  readonly schema = EchoTool.Schema;

  async execute(params: { text: string }): Promise<ToolResult> {
    return { isError: false, output: params.text };
  }
}

class FailTool extends CallableTool<typeof FailTool.Schema> {
  static readonly Schema = z.object({});
  readonly name = "fail";
  readonly description = "Always fails";
  readonly schema = FailTool.Schema;

  async execute(): Promise<ToolResult> {
    throw new Error("intentional failure");
  }
}

describe("KimiToolset", () => {
  let tempDir: string;
  let ctx: ToolContext;

  beforeEach(() => {
    tempDir = createTempDir();
    ctx = createTestToolContext(tempDir);
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  // ── Registration and lookup ──────────────────────────

  test("add and find tool", () => {
    const toolset = new KimiToolset({ context: ctx });
    toolset.add(new EchoTool());
    expect(toolset.find("echo")).toBeDefined();
    expect(toolset.find("nonexistent")).toBeUndefined();
  });

  test("list returns all tools", () => {
    const toolset = new KimiToolset({ context: ctx });
    toolset.add(new EchoTool());
    toolset.add(new FailTool());
    expect(toolset.list().length).toBe(2);
  });

  // ── Definitions (hide/unhide) ────────────────────────

  test("definitions excludes hidden tools", () => {
    const toolset = new KimiToolset({ context: ctx });
    toolset.add(new EchoTool());
    toolset.add(new FailTool());

    toolset.hide("fail");
    const defs = toolset.definitions();
    expect(defs.length).toBe(1);
    expect(defs[0]!.name).toBe("echo");

    toolset.unhide("fail");
    expect(toolset.definitions().length).toBe(2);
  });

  // ── Handle tool call ─────────────────────────────────

  test("handle executes tool and returns result", async () => {
    const toolset = new KimiToolset({ context: ctx });
    toolset.add(new EchoTool());

    const result = await toolset.handle({
      id: "tc-1",
      name: "echo",
      arguments: JSON.stringify({ text: "hello world" }),
    });
    expect(result.isError).toBe(false);
    expect(result.output).toBe("hello world");
  });

  test("handle returns error for invalid JSON arguments", async () => {
    const toolset = new KimiToolset({ context: ctx });
    toolset.add(new EchoTool());

    const result = await toolset.handle({
      id: "tc-1",
      name: "echo",
      arguments: "{bad json",
    });
    expect(result.isError).toBe(true);
    expect(result.message).toContain("Failed to parse arguments");
  });

  test("handle catches tool execution errors", async () => {
    const toolset = new KimiToolset({ context: ctx });
    toolset.add(new FailTool());

    const result = await toolset.handle({
      id: "tc-1",
      name: "fail",
      arguments: "{}",
    });
    expect(result.isError).toBe(true);
    expect(result.message).toContain("intentional failure");
  });

  // ── Callbacks ────────────────────────────────────────

  test("onToolCall and onToolResult callbacks fire", async () => {
    const calls: string[] = [];
    const results: string[] = [];

    const toolset = new KimiToolset({
      context: ctx,
      onToolCall: (tc) => calls.push(tc.name),
      onToolResult: (id, r) => results.push(id),
    });
    toolset.add(new EchoTool());

    await toolset.handle({
      id: "tc-1",
      name: "echo",
      arguments: JSON.stringify({ text: "hi" }),
    });

    expect(calls).toEqual(["echo"]);
    expect(results).toEqual(["tc-1"]);
  });

  // ── Hook integration (PreToolUse block) ──────────────

  test("PreToolUse hook can block tool execution", async () => {
    // Create a hook that blocks "echo"
    const hookEngine = new HookEngine({
      hooks: [
        {
          event: "PreToolUse",
          command: 'echo \'{"action":"block","reason":"blocked by test"}\'',
          matcher: "echo",
          timeout: 5,
        },
      ],
      cwd: tempDir,
    });

    const toolset = new KimiToolset({ context: ctx, hookEngine });
    toolset.add(new EchoTool());

    const result = await toolset.handle({
      id: "tc-1",
      name: "echo",
      arguments: JSON.stringify({ text: "hello" }),
    });
    expect(result.isError).toBe(true);
    expect(result.message).toContain("blocked by hook");
  });
});
