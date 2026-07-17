/**
 * Basic E2E test — create a mock conversation round.
 * Corresponds to Python tests/e2e/test_basic_e2e.py
 *
 * Note: Full E2E with scripted echo provider is not yet ported.
 * This tests the basic building blocks: mock LLM, context, session.
 */

import { test, expect, describe, afterEach } from "bun:test";
import {
  TestContext,
  createMockLLM,
  createTestSession,
  createTestContext,
  textChunks,
} from "../conftest";

describe("basic E2E with mock LLM", () => {
  let ctx: TestContext;

  afterEach(() => {
    ctx?.cleanup();
  });

  test("mock LLM returns scripted text response", async () => {
    ctx = new TestContext();
    const { llm, provider } = createMockLLM([textChunks("Hello from mock!")]);

    const chunks: string[] = [];
    for await (const chunk of llm.chat([{ role: "user", content: "hi" }])) {
      if (chunk.type === "text") {
        chunks.push(chunk.text);
      }
    }

    expect(chunks.join("")).toBe("Hello from mock!");
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].messages[0].content).toBe("hi");
  });

  test("mock LLM tracks multiple calls", async () => {
    ctx = new TestContext();
    const { llm, provider } = createMockLLM([
      textChunks("Response 1"),
      textChunks("Response 2"),
    ]);

    // First call
    const chunks1: string[] = [];
    for await (const chunk of llm.chat([{ role: "user", content: "first" }])) {
      if (chunk.type === "text") chunks1.push(chunk.text);
    }

    // Second call
    const chunks2: string[] = [];
    for await (const chunk of llm.chat([{ role: "user", content: "second" }])) {
      if (chunk.type === "text") chunks2.push(chunk.text);
    }

    expect(chunks1.join("")).toBe("Response 1");
    expect(chunks2.join("")).toBe("Response 2");
    expect(provider.calls).toHaveLength(2);
  });

  test("session is created with correct properties", () => {
    ctx = new TestContext();
    const session = createTestSession(ctx.workDir, ctx.shareDir);
    expect(session.id).toBe("test-session");
    expect(session.title).toBe("Test Session");
  });

  test("context can be created", () => {
    ctx = new TestContext();
    const context = createTestContext(ctx.shareDir);
    expect(context).toBeDefined();
  });

  test("LLM reports capabilities", () => {
    ctx = new TestContext();
    const { llm } = createMockLLM([], {
      capabilities: ["image_in", "thinking"],
    });
    expect(llm.hasCapability("image_in")).toBe(true);
    expect(llm.hasCapability("thinking")).toBe(true);
  });
});
