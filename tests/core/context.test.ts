/**
 * Tests for soul/context.ts — context window management.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { Context } from "../../src/kimi_cli_ts/soul/context.ts";
import { createTempDir, removeTempDir } from "../conftest.ts";

describe("Context", () => {
  let tempDir: string;
  let contextFile: string;

  beforeEach(() => {
    tempDir = createTempDir();
    contextFile = join(tempDir, "context.jsonl");
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  // ── Empty context ────────────────────────────────────

  test("new context is empty", () => {
    const ctx = new Context(contextFile);
    expect(ctx.history).toEqual([]);
    expect(ctx.tokenCount).toBe(0);
    expect(ctx.tokenCountWithPending).toBe(0);
    expect(ctx.systemPrompt).toBeNull();
    expect(ctx.nCheckpoints).toBe(0);
  });

  // ── Append message ───────────────────────────────────

  test("appendMessage adds to history and persists", async () => {
    const ctx = new Context(contextFile);
    await ctx.appendMessage({ role: "user", content: "hello" });
    expect(ctx.history.length).toBe(1);
    expect(ctx.history[0]!.role).toBe("user");
    expect(ctx.history[0]!.content).toBe("hello");

    // File should contain the message
    const text = await Bun.file(contextFile).text();
    const record = JSON.parse(text.trim());
    expect(record.role).toBe("user");
    expect(record.content).toBe("hello");
  });

  test("appendMessage increases pending token estimate", async () => {
    const ctx = new Context(contextFile);
    await ctx.appendMessage({ role: "user", content: "a".repeat(100) });
    expect(ctx.tokenCountWithPending).toBeGreaterThan(0);
  });

  // ── Restore from file ────────────────────────────────

  test("restore recovers messages from file", async () => {
    const ctx = new Context(contextFile);
    await ctx.appendMessage({ role: "user", content: "msg1" });
    await ctx.appendMessage({ role: "assistant", content: "msg2" });

    const ctx2 = new Context(contextFile);
    await ctx2.restore();
    expect(ctx2.history.length).toBe(2);
    expect(ctx2.history[0]!.content).toBe("msg1");
    expect(ctx2.history[1]!.content).toBe("msg2");
  });

  test("restore recovers system prompt", async () => {
    const ctx = new Context(contextFile);
    await ctx.writeSystemPrompt("You are helpful.");
    await ctx.appendMessage({ role: "user", content: "hi" });

    const ctx2 = new Context(contextFile);
    await ctx2.restore();
    expect(ctx2.systemPrompt).toBe("You are helpful.");
    expect(ctx2.history.length).toBe(1);
  });

  test("restore from nonexistent file is no-op", async () => {
    const ctx = new Context(join(tempDir, "nonexistent.jsonl"));
    await ctx.restore();
    expect(ctx.history).toEqual([]);
  });

  // ── Token count update ───────────────────────────────

  test("updateTokenCount sets token count and resets pending", async () => {
    const ctx = new Context(contextFile);
    await ctx.appendMessage({ role: "user", content: "hello" });
    expect(ctx.tokenCountWithPending).toBeGreaterThan(0);

    await ctx.updateTokenCount({ inputTokens: 100, outputTokens: 50 });
    // Only input tokens count toward context window (output doesn't consume context)
    expect(ctx.tokenCount).toBe(100);
    expect(ctx.tokenCountWithPending).toBe(100);
  });

  test("restore recovers token count from usage record", async () => {
    const ctx = new Context(contextFile);
    await ctx.appendMessage({ role: "user", content: "hello" });
    await ctx.updateTokenCount({ inputTokens: 200, outputTokens: 100 });

    const ctx2 = new Context(contextFile);
    await ctx2.restore();
    // Only input tokens are restored for context tracking
    expect(ctx2.tokenCount).toBe(200);
  });

  // ── Checkpoint and revert ────────────────────────────

  test("checkpoint increments checkpoint id", async () => {
    const ctx = new Context(contextFile);
    const id0 = await ctx.checkpoint();
    expect(id0).toBe(0);
    expect(ctx.nCheckpoints).toBe(1);

    const id1 = await ctx.checkpoint();
    expect(id1).toBe(1);
    expect(ctx.nCheckpoints).toBe(2);
  });

  test("checkpoint with reminder injects system-reminder message", async () => {
    const ctx = new Context(contextFile);
    await ctx.appendMessage({ role: "user", content: "msg1" });
    await ctx.checkpoint("remember this");
    expect(ctx.history.length).toBe(2);
    expect((ctx.history[1]!.content as string)).toContain("remember this");
  });

  test("revertTo restores context up to checkpoint", async () => {
    const ctx = new Context(contextFile);
    await ctx.appendMessage({ role: "user", content: "before" });
    const cpId = await ctx.checkpoint();
    await ctx.appendMessage({ role: "user", content: "after" });

    await ctx.revertTo(cpId);
    // After revert, should only have messages up to checkpoint
    expect(ctx.history.some((m) => (m.content as string) === "after")).toBe(false);
    expect(ctx.history.some((m) => (m.content as string) === "before")).toBe(true);
  });

  // ── Compact ──────────────────────────────────────────

  test("compact clears history and creates backup", async () => {
    const ctx = new Context(contextFile);
    await ctx.appendMessage({ role: "user", content: "msg1" });
    await ctx.appendMessage({ role: "assistant", content: "msg2" });

    await ctx.compact();
    expect(ctx.history.length).toBe(0);
    expect(ctx.tokenCount).toBe(0);

    // Rotated file should exist (context_1.jsonl, matching Python rotation naming)
    const rotatedExists = await Bun.file(join(tempDir, "context_1.jsonl")).exists();
    expect(rotatedExists).toBe(true);
  });

  test("compact resets system prompt (matches Python)", async () => {
    const ctx = new Context(contextFile);
    await ctx.writeSystemPrompt("System prompt here.");
    await ctx.appendMessage({ role: "user", content: "hello" });

    await ctx.compact();
    expect(ctx.systemPrompt).toBeNull();
    expect(ctx.history.length).toBe(0);

    // Restoring should not recover system prompt (cleared file)
    const ctx2 = new Context(contextFile);
    await ctx2.restore();
    expect(ctx2.systemPrompt).toBeNull();
  });
});
