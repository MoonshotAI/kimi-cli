/**
 * Tests for Glob tool.
 * Corresponds to Python tests/tools/test_glob.py
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { createTempDir, removeTempDir, createTestToolContext } from "../conftest.ts";
import { Glob } from "../../src/kimi_cli_ts/tools/file/glob.ts";

let tempDir: string;
let tool: Glob;
let ctx: ReturnType<typeof createTestToolContext>;

beforeEach(() => {
  tempDir = createTempDir();
  tool = new Glob();
  ctx = createTestToolContext(tempDir);
});

afterEach(() => {
  removeTempDir(tempDir);
});

async function setupTestFiles(): Promise<string> {
  // Create directory structure
  mkdirSync(join(tempDir, "src", "main"), { recursive: true });
  mkdirSync(join(tempDir, "src", "test"), { recursive: true });
  mkdirSync(join(tempDir, "docs"), { recursive: true });

  // Create test files
  await Bun.write(join(tempDir, "README.md"), "# README");
  await Bun.write(join(tempDir, "setup.py"), "setup");
  await Bun.write(join(tempDir, "src", "main.py"), "main");
  await Bun.write(join(tempDir, "src", "utils.py"), "utils");
  await Bun.write(join(tempDir, "src", "main", "app.py"), "app");
  await Bun.write(join(tempDir, "src", "main", "config.py"), "config");
  await Bun.write(join(tempDir, "src", "test", "test_app.py"), "test app");
  await Bun.write(join(tempDir, "src", "test", "test_config.py"), "test config");
  await Bun.write(join(tempDir, "docs", "guide.md"), "guide");
  await Bun.write(join(tempDir, "docs", "api.md"), "api");

  return tempDir;
}

describe("Glob", () => {
  test("simple pattern matching", async () => {
    await setupTestFiles();
    const result = await tool.execute(
      { pattern: "*.py", directory: tempDir, include_dirs: true },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("setup.py");
  });

  test("recursive pattern with prefix (allowed)", async () => {
    await setupTestFiles();
    const result = await tool.execute(
      { pattern: "src/**/*.py", directory: tempDir, include_dirs: true },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("src/main.py");
    expect(result.output).toContain("src/utils.py");
    expect(result.output).toContain("src/main/app.py");
    expect(result.output).toContain("src/main/config.py");
    expect(result.output).toContain("src/test/test_app.py");
    expect(result.output).toContain("src/test/test_config.py");
    expect(result.message).toContain("Found 6 matches");
  });

  test("** at start is prohibited", async () => {
    await setupTestFiles();
    const result = await tool.execute(
      { pattern: "**/*.py", directory: tempDir, include_dirs: true },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.message).toContain("starts with '**' which is not allowed");
  });

  test("specific directory search", async () => {
    await setupTestFiles();
    const srcDir = join(tempDir, "src");
    const result = await tool.execute(
      { pattern: "*.py", directory: srcDir, include_dirs: true },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("main.py");
    expect(result.output).toContain("utils.py");
    expect(result.message).toContain("Found 2 matches");
  });

  test("recursive in subdirectory", async () => {
    await setupTestFiles();
    const srcDir = join(tempDir, "src");
    const result = await tool.execute(
      { pattern: "main/**/*.py", directory: srcDir, include_dirs: true },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("main/app.py");
    expect(result.output).toContain("main/config.py");
    expect(result.message).toContain("Found 2 matches");
  });

  test("no matches", async () => {
    await setupTestFiles();
    const result = await tool.execute(
      { pattern: "*.xyz", directory: tempDir, include_dirs: true },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.output).toBe("");
    expect(result.message).toContain("No matches found");
  });

  test("relative path rejected", async () => {
    const result = await tool.execute(
      { pattern: "*.py", directory: "relative/path", include_dirs: true },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.message).toContain("not an absolute path");
  });

  test("character class pattern", async () => {
    await Bun.write(join(tempDir, "file1.py"), "content1");
    await Bun.write(join(tempDir, "file2.py"), "content2");
    await Bun.write(join(tempDir, "file3.txt"), "content3");

    const result = await tool.execute(
      { pattern: "file[1-2].py", directory: tempDir, include_dirs: true },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("file1.py");
    expect(result.output).toContain("file2.py");
    expect(result.output).not.toContain("file3.txt");
  });

  test("exclude directories with include_dirs=false", async () => {
    await Bun.write(join(tempDir, "test_file.txt"), "content");
    mkdirSync(join(tempDir, "test_dir"));

    const result = await tool.execute(
      { pattern: "test_*", directory: tempDir, include_dirs: false },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("test_file.txt");
    expect(result.output).not.toContain("test_dir");
  });

  test("test files pattern", async () => {
    await setupTestFiles();
    const result = await tool.execute(
      { pattern: "src/**/*test*.py", directory: tempDir, include_dirs: true },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("src/test/test_app.py");
    expect(result.output).toContain("src/test/test_config.py");
    expect(result.message).toContain("Found 2 matches");
  });

  test("toDefinition returns valid schema", () => {
    const def = tool.toDefinition();
    expect(def.name).toBe("Glob");
    expect(def.description).toBeTruthy();
    expect(def.parameters).toBeDefined();
  });
});
