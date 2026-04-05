/**
 * Tests for AskUserQuestion tool.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { createTempDir, removeTempDir, createTestToolContext } from "../conftest.ts";
import { AskUserQuestion } from "../../src/kimi_cli_ts/tools/ask_user/index.ts";

let tempDir: string;
let tool: AskUserQuestion;
let ctx: ReturnType<typeof createTestToolContext>;

beforeEach(() => {
  tempDir = createTempDir();
  tool = new AskUserQuestion();
  ctx = createTestToolContext(tempDir);
});

afterEach(() => {
  removeTempDir(tempDir);
});

describe("AskUserQuestion", () => {
  test("basic question returns response", async () => {
    const result = await tool.execute(
      {
        questions: [
          {
            question: "Which approach do you prefer?",
            header: "Approach",
            options: [
              { label: "Option A", description: "First option" },
              { label: "Option B", description: "Second option" },
            ],
            multi_select: false,
          },
        ],
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    // Stub returns a JSON payload
    expect(result.output).toBeTruthy();
    const parsed = JSON.parse(result.output);
    expect(parsed).toHaveProperty("answers");
  });

  test("multiple questions", async () => {
    const result = await tool.execute(
      {
        questions: [
          {
            question: "Question 1?",
            header: "Q1",
            options: [
              { label: "A", description: "a" },
              { label: "B", description: "b" },
            ],
            multi_select: false,
          },
          {
            question: "Question 2?",
            header: "Q2",
            options: [
              { label: "C", description: "c" },
              { label: "D", description: "d" },
            ],
            multi_select: true,
          },
        ],
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.output).toBeTruthy();
  });

  test("toDefinition returns valid schema", () => {
    const def = tool.toDefinition();
    expect(def.name).toBe("AskUserQuestion");
    expect(def.description).toBeTruthy();
    expect(def.parameters).toBeDefined();
  });
});
