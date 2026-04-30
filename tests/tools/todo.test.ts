/**
 * Tests for SetTodoList tool.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { createTempDir, removeTempDir, createTestToolContext } from "../conftest.ts";
import { SetTodoList } from "../../src/kimi_cli_ts/tools/todo/index.ts";

let tempDir: string;
let tool: SetTodoList;
let ctx: ReturnType<typeof createTestToolContext>;

beforeEach(() => {
  tempDir = createTempDir();
  tool = new SetTodoList();
  ctx = createTestToolContext(tempDir);
});

afterEach(() => {
  removeTempDir(tempDir);
});

describe("SetTodoList", () => {
  test("basic todo list update", async () => {
    const result = await tool.execute(
      {
        todos: [
          { title: "Task 1", status: "pending" },
          { title: "Task 2", status: "in_progress" },
          { title: "Task 3", status: "done" },
        ],
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.message).toBe("Todo list updated");
    expect(result.display).toBeDefined();
    expect(result.display!.length).toBe(1);

    const todoBlock = result.display![0] as { type: string; items: Array<{ title: string; status: string }> };
    expect(todoBlock.type).toBe("todo");
    expect(todoBlock.items.length).toBe(3);
    expect(todoBlock.items[0].title).toBe("Task 1");
    expect(todoBlock.items[0].status).toBe("pending");
    expect(todoBlock.items[2].status).toBe("done");
  });

  test("empty todo list", async () => {
    const result = await tool.execute({ todos: [] }, ctx);

    expect(result.isError).toBe(false);
    expect(result.message).toBe("Todo list updated");
  });

  test("single item todo list", async () => {
    const result = await tool.execute(
      { todos: [{ title: "Only task", status: "in_progress" }] },
      ctx,
    );

    expect(result.isError).toBe(false);
    const todoBlock = result.display![0] as { type: string; items: Array<{ title: string; status: string }> };
    expect(todoBlock.items.length).toBe(1);
    expect(todoBlock.items[0].title).toBe("Only task");
  });

  test("toDefinition returns valid schema", () => {
    const def = tool.toDefinition();
    expect(def.name).toBe("SetTodoList");
    expect(def.description).toBeTruthy();
    expect(def.parameters).toBeDefined();
  });
});
