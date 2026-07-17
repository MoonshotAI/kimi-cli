/**
 * Tests for Shell tool.
 * Corresponds to Python tests/tools/test_shell_bash.py
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { createTempDir, removeTempDir, createTestToolContext } from "../conftest.ts";
import { Shell } from "../../src/kimi_cli_ts/tools/shell/index.ts";

let tempDir: string;
let tool: Shell;
let ctx: ReturnType<typeof createTestToolContext>;

beforeEach(() => {
  tempDir = createTempDir();
  tool = new Shell();
  ctx = createTestToolContext(tempDir);
});

afterEach(() => {
  removeTempDir(tempDir);
});

describe("Shell", () => {
  test("simple echo command", async () => {
    const result = await tool.execute(
      { command: "echo 'Hello World'", timeout: 60, run_in_background: false, description: "" },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("Hello World");
    expect(result.message).toContain("Command executed successfully");
  });

  test("command with error", async () => {
    const result = await tool.execute(
      { command: "ls /nonexistent/directory", timeout: 60, run_in_background: false, description: "" },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("No such file or directory");
    expect(result.message).toContain("Command failed with exit code");
  });

  test("command chaining with &&", async () => {
    const result = await tool.execute(
      { command: "echo 'First' && echo 'Second'", timeout: 60, run_in_background: false, description: "" },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("First");
    expect(result.output).toContain("Second");
  });

  test("sequential commands with ;", async () => {
    const result = await tool.execute(
      { command: "echo 'One'; echo 'Two'", timeout: 60, run_in_background: false, description: "" },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("One");
    expect(result.output).toContain("Two");
  });

  test("conditional execution with ||", async () => {
    const result = await tool.execute(
      { command: "false || echo 'Success'", timeout: 60, run_in_background: false, description: "" },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("Success");
  });

  test("piping commands", async () => {
    const result = await tool.execute(
      { command: "echo 'Hello World' | wc -w", timeout: 60, run_in_background: false, description: "" },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.output.trim()).toBe("2");
  });

  test("command with timeout parameter", async () => {
    const result = await tool.execute(
      { command: "sleep 0.1", timeout: 5, run_in_background: false, description: "" },
      ctx,
    );

    expect(result.isError).toBe(false);
  });

  test("command timeout expires", async () => {
    const result = await tool.execute(
      { command: "sleep 10", timeout: 1, run_in_background: false, description: "" },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.message).toContain("Command killed by timeout (1s)");
  });

  test("environment variables", async () => {
    const result = await tool.execute(
      {
        command: "export TEST_VAR='test_value' && echo $TEST_VAR",
        timeout: 60,
        run_in_background: false,
        description: "",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("test_value");
  });

  test("file operations", async () => {
    // Create a file
    const result1 = await tool.execute(
      {
        command: `echo 'Test content' > ${join(tempDir, "test_file.txt")}`,
        timeout: 60,
        run_in_background: false,
        description: "",
      },
      ctx,
    );
    expect(result1.isError).toBe(false);

    // Read the file
    const result2 = await tool.execute(
      {
        command: `cat ${join(tempDir, "test_file.txt")}`,
        timeout: 60,
        run_in_background: false,
        description: "",
      },
      ctx,
    );
    expect(result2.isError).toBe(false);
    expect(result2.output).toContain("Test content");
  });

  test("command substitution", async () => {
    const result = await tool.execute(
      {
        command: 'echo "Result: $(echo hello)"',
        timeout: 60,
        run_in_background: false,
        description: "",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("Result: hello");
  });

  test("arithmetic substitution", async () => {
    const result = await tool.execute(
      {
        command: 'echo "Answer: $((2 + 2))"',
        timeout: 60,
        run_in_background: false,
        description: "",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("Answer: 4");
  });

  test("empty command returns error", async () => {
    const result = await tool.execute(
      { command: "", timeout: 60, run_in_background: false, description: "" },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.message).toContain("Command cannot be empty");
  });

  test("rejection from approval", async () => {
    const rejectCtx = createTestToolContext(tempDir, { yolo: false });
    const result = await tool.execute(
      { command: "echo test", timeout: 60, run_in_background: false, description: "" },
      rejectCtx,
    );

    expect(result.isError).toBe(true);
    expect(result.message).toContain("rejected");
  });

  test("stdout and stderr capture", async () => {
    const result = await tool.execute(
      {
        command: "echo stdout_msg && echo stderr_msg >&2",
        timeout: 60,
        run_in_background: false,
        description: "",
      },
      ctx,
    );

    // Both stdout and stderr should be captured
    expect(result.output).toContain("stdout_msg");
    expect(result.output).toContain("stderr_msg");
  });

  test("toDefinition returns valid schema", () => {
    const def = tool.toDefinition();
    expect(def.name).toBe("Shell");
    expect(def.description).toBeTruthy();
    expect(def.parameters).toBeDefined();
  });
});
