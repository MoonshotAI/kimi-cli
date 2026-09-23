/**
 * Tests for WriteFile tool.
 * Corresponds to Python tests/tools/test_write_file.py
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { createTempDir, removeTempDir, createTestToolContext } from "../conftest.ts";
import { WriteFile } from "../../src/kimi_cli_ts/tools/file/write.ts";

let tempDir: string;
let tool: WriteFile;
let ctx: ReturnType<typeof createTestToolContext>;

beforeEach(() => {
  tempDir = createTempDir();
  tool = new WriteFile();
  ctx = createTestToolContext(tempDir);
});

afterEach(() => {
  removeTempDir(tempDir);
});

describe("WriteFile", () => {
  test("write new file", async () => {
    const filePath = join(tempDir, "new_file.txt");
    const content = "Hello, World!";

    const result = await tool.execute({ path: filePath, content, mode: "overwrite" }, ctx);

    expect(result.isError).toBe(false);
    expect(result.message).toContain("successfully");
    const written = await Bun.file(filePath).text();
    expect(written).toBe(content);
  });

  test("overwrite existing file", async () => {
    const filePath = join(tempDir, "existing.txt");
    await Bun.write(filePath, "Original content");

    const newContent = "New content";
    const result = await tool.execute({ path: filePath, content: newContent, mode: "overwrite" }, ctx);

    expect(result.isError).toBe(false);
    expect(result.message).toContain("overwritten");
    const written = await Bun.file(filePath).text();
    expect(written).toBe(newContent);
  });

  test("append to existing file", async () => {
    const filePath = join(tempDir, "append_test.txt");
    const original = "First line\n";
    await Bun.write(filePath, original);

    const appendContent = "Second line\n";
    const result = await tool.execute({ path: filePath, content: appendContent, mode: "append" }, ctx);

    expect(result.isError).toBe(false);
    expect(result.message).toContain("appended");
    const written = await Bun.file(filePath).text();
    expect(written).toBe(original + appendContent);
  });

  test("write unicode content", async () => {
    const filePath = join(tempDir, "unicode.txt");
    const content = "Hello 世界 🌍\nUnicode: café, naïve, résumé";

    const result = await tool.execute({ path: filePath, content, mode: "overwrite" }, ctx);

    expect(result.isError).toBe(false);
    const written = await Bun.file(filePath).text();
    expect(written).toBe(content);
  });

  test("write empty content", async () => {
    const filePath = join(tempDir, "empty.txt");

    const result = await tool.execute({ path: filePath, content: "", mode: "overwrite" }, ctx);

    expect(result.isError).toBe(false);
    const written = await Bun.file(filePath).text();
    expect(written).toBe("");
  });

  test("write multiline content", async () => {
    const filePath = join(tempDir, "multiline.txt");
    const content = "Line 1\nLine 2\nLine 3\n";

    const result = await tool.execute({ path: filePath, content, mode: "overwrite" }, ctx);

    expect(result.isError).toBe(false);
    const written = await Bun.file(filePath).text();
    expect(written).toBe(content);
  });

  test("write with relative path", async () => {
    const subDir = join(tempDir, "relative", "path");
    mkdirSync(subDir, { recursive: true });

    const result = await tool.execute(
      { path: "relative/path/file.txt", content: "content", mode: "overwrite" },
      ctx,
    );

    expect(result.isError).toBe(false);
    const written = await Bun.file(join(tempDir, "relative/path/file.txt")).text();
    expect(written).toBe("content");
  });

  test("create intermediate directories via Bun.write", async () => {
    // Bun.write auto-creates parent directories
    const filePath = join(tempDir, "deep", "nested", "dir", "file.txt");

    const result = await tool.execute(
      { path: filePath, content: "deep content", mode: "overwrite" },
      ctx,
    );

    // Bun.write creates parent dirs automatically
    expect(result.isError).toBe(false);
    const written = await Bun.file(filePath).text();
    expect(written).toBe("deep content");
  });

  test("write large content", async () => {
    const filePath = join(tempDir, "large.txt");
    const content = "Large content line\n".repeat(1000);

    const result = await tool.execute({ path: filePath, content, mode: "overwrite" }, ctx);

    expect(result.isError).toBe(false);
    const written = await Bun.file(filePath).text();
    expect(written).toBe(content);
  });

  test("empty path returns error", async () => {
    const result = await tool.execute({ path: "", content: "test", mode: "overwrite" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.message).toContain("cannot be empty");
  });

  test("rejection from approval", async () => {
    const rejectCtx = createTestToolContext(tempDir, { yolo: false });
    const filePath = join(tempDir, "rejected.txt");

    const result = await tool.execute({ path: filePath, content: "test", mode: "overwrite" }, rejectCtx);

    expect(result.isError).toBe(true);
    expect(result.message).toContain("rejected");
  });

  test("toDefinition returns valid schema", () => {
    const def = tool.toDefinition();
    expect(def.name).toBe("WriteFile");
    expect(def.description).toBeTruthy();
    expect(def.parameters).toBeDefined();
  });
});
