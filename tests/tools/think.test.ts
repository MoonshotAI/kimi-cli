/**
 * Tests for Think tool.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { createTempDir, removeTempDir, createTestToolContext } from "../conftest.ts";
import { Think } from "../../src/kimi_cli_ts/tools/think/index.ts";

let tempDir: string;
let tool: Think;
let ctx: ReturnType<typeof createTestToolContext>;

beforeEach(() => {
  tempDir = createTempDir();
  tool = new Think();
  ctx = createTestToolContext(tempDir);
});

afterEach(() => {
  removeTempDir(tempDir);
});

describe("Think", () => {
  test("basic thought returns success", async () => {
    const result = await tool.execute({ thought: "I need to consider the approach." }, ctx);

    expect(result.isError).toBe(false);
    expect(result.output).toBe("");
    expect(result.message).toBe("Thought logged");
  });

  test("empty thought still succeeds", async () => {
    const result = await tool.execute({ thought: "" }, ctx);

    expect(result.isError).toBe(false);
  });

  test("long thought still succeeds", async () => {
    const longThought = "A".repeat(10000);
    const result = await tool.execute({ thought: longThought }, ctx);

    expect(result.isError).toBe(false);
    expect(result.message).toBe("Thought logged");
  });

  test("toDefinition returns valid schema", () => {
    const def = tool.toDefinition();
    expect(def.name).toBe("Think");
    expect(def.description).toBeTruthy();
    expect(typeof def.parameters).toBe("object");
  });
});
