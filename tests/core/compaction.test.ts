/**
 * Tests for soul/compaction.ts — context compaction logic.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { shouldCompact, compactContext } from "../../src/kimi_cli_ts/soul/compaction.ts";
import { Context } from "../../src/kimi_cli_ts/soul/context.ts";
import { createTempDir, removeTempDir, createMockLLM, textChunks } from "../conftest.ts";

describe("shouldCompact", () => {
  test("returns false when well below limits", () => {
    expect(shouldCompact(1000, 100_000, 5000, 0.85)).toBe(false);
  });

  test("returns true when token count + reserved >= max context", () => {
    // tokenCount + reservedContextSize >= maxContextSize
    expect(shouldCompact(96_000, 100_000, 5000, 0.85)).toBe(true);
  });

  test("returns true when token count >= trigger ratio * max", () => {
    // 85000 >= 100000 * 0.85
    expect(shouldCompact(85_000, 100_000, 5000, 0.85)).toBe(true);
  });

  test("returns false at 84% with 0.85 trigger ratio", () => {
    expect(shouldCompact(84_000, 100_000, 5000, 0.85)).toBe(false);
  });

  test("returns true at boundary: tokenCount == maxContextSize * ratio", () => {
    expect(shouldCompact(85_000, 100_000, 0, 0.85)).toBe(true);
  });
});

describe("compactContext", () => {
  let tempDir: string;
  let contextFile: string;

  beforeEach(() => {
    tempDir = createTempDir();
    contextFile = join(tempDir, "context.jsonl");
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  test("empty context is a no-op", async () => {
    const ctx = new Context(contextFile);
    const { llm } = createMockLLM([textChunks("summary")]);
    await compactContext(ctx, llm);
    expect(ctx.history.length).toBe(0);
  });

  test("compactContext uses LLM to summarize and replaces history", async () => {
    const ctx = new Context(contextFile);
    await ctx.appendMessage({ role: "user", content: "Write a function" });
    await ctx.appendMessage({ role: "assistant", content: "Here is a function..." });
    await ctx.appendMessage({ role: "user", content: "Add error handling" });

    const { llm, provider } = createMockLLM([textChunks("Summarized conversation")]);

    await compactContext(ctx, llm);

    // LLM should have been called once
    expect(provider.calls.length).toBe(1);
    // History should be replaced with summary + preserved messages
    // prepareCompaction preserves the last 2 user/assistant messages,
    // compacts the first, so: 1 summary + 2 preserved = 3
    expect(ctx.history.length).toBe(3);
    expect((ctx.history[0]!.content as string)).toContain("Summarized conversation");
  });

  test("compactContext calls onBegin and onEnd callbacks", async () => {
    const ctx = new Context(contextFile);
    await ctx.appendMessage({ role: "user", content: "test" });

    const { llm } = createMockLLM([textChunks("summary")]);
    let began = false;
    let ended = false;

    await compactContext(ctx, llm, undefined, {
      onBegin: () => { began = true; },
      onEnd: () => { ended = true; },
    });

    expect(began).toBe(true);
    expect(ended).toBe(true);
  });

  test("compactContext falls back when LLM fails", async () => {
    const ctx = new Context(contextFile);
    // Need more messages than maxPreservedMessages (2) to trigger compaction
    await ctx.appendMessage({ role: "user", content: "msg1" });
    await ctx.appendMessage({ role: "assistant", content: "msg2" });
    await ctx.appendMessage({ role: "user", content: "msg3" });
    await ctx.appendMessage({ role: "assistant", content: "msg4" });
    await ctx.appendMessage({ role: "user", content: "msg5" });

    // Mock LLM that throws
    const { llm } = createMockLLM([]); // no responses → will fail

    await compactContext(ctx, llm);
    // Fallback summary is generated + preserved messages remain
    // At least some messages should exist (summary + preserved)
    expect(ctx.history.length).toBeGreaterThan(0);
  });
});
