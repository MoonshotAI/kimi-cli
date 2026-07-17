/**
 * Tests for StrReplaceFile tool.
 * Corresponds to Python tests/tools/test_str_replace_file.py
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { createTempDir, removeTempDir, createTestToolContext } from "../conftest.ts";
import { StrReplaceFile } from "../../src/kimi_cli_ts/tools/file/replace.ts";

let tempDir: string;
let tool: StrReplaceFile;
let ctx: ReturnType<typeof createTestToolContext>;

beforeEach(() => {
  tempDir = createTempDir();
  tool = new StrReplaceFile();
  ctx = createTestToolContext(tempDir);
});

afterEach(() => {
  removeTempDir(tempDir);
});

async function writeTestFile(name: string, content: string): Promise<string> {
  const filePath = join(tempDir, name);
  await Bun.write(filePath, content);
  return filePath;
}

describe("StrReplaceFile", () => {
  test("replace single occurrence", async () => {
    const filePath = await writeTestFile("test.txt", "Hello world! This is a test.");
    const result = await tool.execute(
      { path: filePath, edit: { old: "world", new: "universe", replace_all: false } },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.message).toContain("successfully edited");
    const content = await Bun.file(filePath).text();
    expect(content).toBe("Hello universe! This is a test.");
  });

  test("replace all occurrences", async () => {
    const filePath = await writeTestFile("test.txt", "apple banana apple cherry apple");
    const result = await tool.execute(
      { path: filePath, edit: { old: "apple", new: "fruit", replace_all: true } },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.message).toContain("successfully edited");
    const content = await Bun.file(filePath).text();
    expect(content).toBe("fruit banana fruit cherry fruit");
  });

  test("replace multiple edits", async () => {
    const filePath = await writeTestFile("test.txt", "Hello world! Goodbye world!");
    const result = await tool.execute(
      {
        path: filePath,
        edit: [
          { old: "Hello", new: "Hi", replace_all: false },
          { old: "Goodbye", new: "See you", replace_all: false },
        ],
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.message).toContain("successfully edited");
    const content = await Bun.file(filePath).text();
    expect(content).toBe("Hi world! See you world!");
  });

  test("replace multiline content", async () => {
    const filePath = await writeTestFile("test.txt", "Line 1\nLine 2\nLine 3\n");
    const result = await tool.execute(
      {
        path: filePath,
        edit: { old: "Line 2\nLine 3", new: "Modified line 2\nModified line 3", replace_all: false },
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    const content = await Bun.file(filePath).text();
    expect(content).toBe("Line 1\nModified line 2\nModified line 3\n");
  });

  test("replace unicode content", async () => {
    const filePath = await writeTestFile("test.txt", "Hello 世界! café");
    const result = await tool.execute(
      { path: filePath, edit: { old: "世界", new: "地球", replace_all: false } },
      ctx,
    );

    expect(result.isError).toBe(false);
    const content = await Bun.file(filePath).text();
    expect(content).toBe("Hello 地球! café");
  });

  test("no match returns error", async () => {
    const filePath = await writeTestFile("test.txt", "Hello world!");
    const result = await tool.execute(
      { path: filePath, edit: { old: "notfound", new: "replacement", replace_all: false } },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.message).toContain("No replacements were made");
    // Content should be unchanged
    const content = await Bun.file(filePath).text();
    expect(content).toBe("Hello world!");
  });

  test("nonexistent file returns error", async () => {
    const filePath = join(tempDir, "nonexistent.txt");
    const result = await tool.execute(
      { path: filePath, edit: { old: "old", new: "new", replace_all: false } },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.message).toContain("does not exist");
  });

  test("replace with relative path", async () => {
    const subDir = join(tempDir, "relative", "path");
    Bun.spawnSync(["mkdir", "-p", subDir]);
    await Bun.write(join(subDir, "file.txt"), "old content");

    const result = await tool.execute(
      { path: "relative/path/file.txt", edit: { old: "old", new: "new", replace_all: false } },
      ctx,
    );

    expect(result.isError).toBe(false);
    const content = await Bun.file(join(subDir, "file.txt")).text();
    expect(content).toBe("new content");
  });

  test("replace with empty new string (deletion)", async () => {
    const filePath = await writeTestFile("test.txt", "Hello world!");
    const result = await tool.execute(
      { path: filePath, edit: { old: "world", new: "", replace_all: false } },
      ctx,
    );

    expect(result.isError).toBe(false);
    const content = await Bun.file(filePath).text();
    expect(content).toBe("Hello !");
  });

  test("mixed multiple edits with different replace_all settings", async () => {
    const filePath = await writeTestFile("test.txt", "apple apple banana apple cherry");
    const result = await tool.execute(
      {
        path: filePath,
        edit: [
          { old: "apple", new: "fruit", replace_all: false }, // Only first
          { old: "banana", new: "tasty", replace_all: true }, // All (only one)
        ],
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    const content = await Bun.file(filePath).text();
    expect(content).toBe("fruit apple tasty apple cherry");
  });

  test("empty path returns error", async () => {
    const result = await tool.execute(
      { path: "", edit: { old: "old", new: "new", replace_all: false } },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.message).toContain("cannot be empty");
  });

  test("rejection from approval", async () => {
    const rejectCtx = createTestToolContext(tempDir, { yolo: false });
    const filePath = await writeTestFile("test.txt", "Hello world!");
    const result = await tool.execute(
      { path: filePath, edit: { old: "world", new: "universe", replace_all: false } },
      rejectCtx,
    );

    expect(result.isError).toBe(true);
    expect(result.message).toContain("rejected");
  });

  test("toDefinition returns valid schema", () => {
    const def = tool.toDefinition();
    expect(def.name).toBe("StrReplaceFile");
    expect(def.description).toBeTruthy();
    expect(def.parameters).toBeDefined();
  });
});
