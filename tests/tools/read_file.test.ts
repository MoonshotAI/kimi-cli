/**
 * Tests for ReadFile tool.
 * Corresponds to Python tests/tools/test_read_file.py
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { createTempDir, removeTempDir, createTestToolContext } from "../conftest.ts";
import { ReadFile } from "../../src/kimi_cli_ts/tools/file/read.ts";

let tempDir: string;
let tool: ReadFile;
let ctx: ReturnType<typeof createTestToolContext>;

beforeEach(() => {
  tempDir = createTempDir();
  tool = new ReadFile();
  ctx = createTestToolContext(tempDir);
});

afterEach(() => {
  removeTempDir(tempDir);
});

const sampleContent = `Line 1: Hello World
Line 2: This is a test file
Line 3: With multiple lines
Line 4: For testing purposes
Line 5: End of file`;

async function createSampleFile(name = "sample.txt", content = sampleContent): Promise<string> {
  const filePath = join(tempDir, name);
  await Bun.write(filePath, content);
  return filePath;
}

describe("ReadFile", () => {
  test("read entire file", async () => {
    const filePath = await createSampleFile();
    const result = await tool.execute({ path: filePath, line_offset: 1, n_lines: 1000 }, ctx);

    expect(result.isError).toBe(false);
    expect(result.output).toContain("Line 1: Hello World");
    expect(result.output).toContain("Line 5: End of file");
    expect(result.message).toContain("5 lines read from file starting from line 1");
    expect(result.message).toContain("Total lines in file: 5.");
    expect(result.message).toContain("End of file reached");
  });

  test("read with line offset", async () => {
    const filePath = await createSampleFile();
    const result = await tool.execute({ path: filePath, line_offset: 3, n_lines: 1000 }, ctx);

    expect(result.isError).toBe(false);
    expect(result.output).toContain("Line 3: With multiple lines");
    expect(result.output).toContain("Line 5: End of file");
    expect(result.output).not.toContain("Line 1: Hello World");
    expect(result.message).toContain("3 lines read from file starting from line 3");
  });

  test("read with n_lines limit", async () => {
    const filePath = await createSampleFile();
    const result = await tool.execute({ path: filePath, line_offset: 1, n_lines: 2 }, ctx);

    expect(result.isError).toBe(false);
    expect(result.output).toContain("Line 1: Hello World");
    expect(result.output).toContain("Line 2: This is a test file");
    expect(result.output).not.toContain("Line 3");
    expect(result.message).toContain("2 lines read from file starting from line 1");
  });

  test("read with line offset and n_lines combined", async () => {
    const filePath = await createSampleFile();
    const result = await tool.execute({ path: filePath, line_offset: 2, n_lines: 2 }, ctx);

    expect(result.isError).toBe(false);
    expect(result.output).toContain("Line 2: This is a test file");
    expect(result.output).toContain("Line 3: With multiple lines");
    expect(result.output).not.toContain("Line 1");
    expect(result.output).not.toContain("Line 4");
    expect(result.message).toContain("2 lines read from file starting from line 2");
  });

  test("read nonexistent file", async () => {
    const nonexistent = join(tempDir, "nonexistent.txt");
    const result = await tool.execute({ path: nonexistent, line_offset: 1, n_lines: 1000 }, ctx);

    expect(result.isError).toBe(true);
    expect(result.message).toContain("does not exist");
  });

  test("read with relative path", async () => {
    await createSampleFile();
    const result = await tool.execute({ path: "sample.txt", line_offset: 1, n_lines: 1000 }, ctx);

    expect(result.isError).toBe(false);
    expect(result.output).toContain("Line 1: Hello World");
    expect(result.message).toContain("5 lines read from file starting from line 1");
  });

  test("read empty file", async () => {
    const filePath = await createSampleFile("empty.txt", "");
    const result = await tool.execute({ path: filePath, line_offset: 1, n_lines: 1000 }, ctx);

    expect(result.isError).toBe(false);
    expect(result.output).toBe("");
    expect(result.message).toContain("No lines read from file.");
    expect(result.message).toContain("Total lines in file: 0.");
  });

  test("read with line offset beyond file length", async () => {
    const filePath = await createSampleFile();
    const result = await tool.execute({ path: filePath, line_offset: 100, n_lines: 1000 }, ctx);

    expect(result.isError).toBe(false);
    expect(result.output).toBe("");
    expect(result.message).toContain("No lines read from file");
  });

  test("cat -n format line numbers", async () => {
    const filePath = await createSampleFile();
    const result = await tool.execute({ path: filePath, line_offset: 1, n_lines: 1000 }, ctx);

    expect(result.isError).toBe(false);
    // cat -n format: right-aligned line number, then tab, then content
    expect(result.output).toMatch(/\s+1\t/);
    expect(result.output).toMatch(/\s+5\t/);
  });

  test("read unicode file", async () => {
    const filePath = await createSampleFile("unicode.txt", "Hello 世界 🌍\nUnicode test: café, naïve, résumé");
    const result = await tool.execute({ path: filePath, line_offset: 1, n_lines: 1000 }, ctx);

    expect(result.isError).toBe(false);
    expect(result.output).toContain("Hello 世界 🌍");
    expect(result.output).toContain("café");
    expect(result.message).toContain("2 lines read from file starting from line 1");
  });

  test("line truncation for long lines", async () => {
    const longContent = "A".repeat(2500) + " This should be truncated";
    const filePath = await createSampleFile("long.txt", longContent);
    const result = await tool.execute({ path: filePath, line_offset: 1, n_lines: 1000 }, ctx);

    expect(result.isError).toBe(false);
    // Should be truncated with "..."
    expect(result.output).toContain("...");
    expect(result.message).toContain("Lines [1] were truncated");
  });

  test("max lines boundary", async () => {
    // Create file with > 1000 lines
    const lines = Array.from({ length: 1010 }, (_, i) => `Line ${i + 1}`).join("\n");
    const filePath = await createSampleFile("large.txt", lines);
    const result = await tool.execute({ path: filePath, line_offset: 1, n_lines: 1005 }, ctx);

    expect(result.isError).toBe(false);
    expect(result.message).toContain("Max 1000 lines reached");
  });

  test("max bytes boundary", async () => {
    // Create file with lines that exceed 100KB total
    const lineContent = "A".repeat(1000);
    const numLines = 110; // 110 * 1000 = 110KB > 100KB
    const content = Array.from({ length: numLines }, () => lineContent).join("\n");
    const filePath = await createSampleFile("large_bytes.txt", content);
    const result = await tool.execute({ path: filePath, line_offset: 1, n_lines: 1000 }, ctx);

    expect(result.isError).toBe(false);
    expect(result.message).toContain("Max 102400 bytes reached");
  });

  test("empty path returns error", async () => {
    const result = await tool.execute({ path: "", line_offset: 1, n_lines: 1000 }, ctx);
    expect(result.isError).toBe(true);
    expect(result.message).toContain("cannot be empty");
  });

  test("toDefinition returns valid schema", () => {
    const def = tool.toDefinition();
    expect(def.name).toBe("ReadFile");
    expect(def.description).toBeTruthy();
    expect(def.parameters).toBeDefined();
    expect(typeof def.parameters).toBe("object");
  });

  // ── Tests for totalLines and tail (negative offset) ──────────────────────

  test("totalLines included in positive offset reads", async () => {
    const filePath = await createSampleFile();
    const result = await tool.execute({ path: filePath, line_offset: 3, n_lines: 1 }, ctx);

    expect(result.isError).toBe(false);
    expect(result.output).toContain("Line 3: With multiple lines");
    expect(result.output).not.toContain("Line 1:");
    expect(result.output).not.toContain("Line 4:");
    expect(result.message).toContain("Total lines in file: 5.");
  });

  test("totalLines for empty file", async () => {
    const filePath = await createSampleFile("empty_total.txt", "");
    const result = await tool.execute({ path: filePath, line_offset: 1, n_lines: 1000 }, ctx);

    expect(result.isError).toBe(false);
    expect(result.message).toContain("Total lines in file: 0.");
  });

  test("tail mode basic - negative line_offset", async () => {
    const filePath = await createSampleFile();
    const result = await tool.execute({ path: filePath, line_offset: -3, n_lines: 1000 }, ctx);

    expect(result.isError).toBe(false);
    expect(result.output).toContain("Line 3: With multiple lines");
    expect(result.output).toContain("Line 4: For testing purposes");
    expect(result.output).toContain("Line 5: End of file");
    expect(result.output).not.toContain("Line 1:");
    expect(result.output).not.toContain("Line 2:");
    expect(result.message).toContain("Total lines in file: 5.");
  });

  test("tail mode with n_lines limit", async () => {
    const filePath = await createSampleFile();
    const result = await tool.execute({ path: filePath, line_offset: -5, n_lines: 2 }, ctx);

    expect(result.isError).toBe(false);
    expect(result.output).toContain("Line 1: Hello World");
    expect(result.output).toContain("Line 2: This is a test file");
    expect(result.output).not.toContain("Line 3:");
    expect(result.message).toContain("Total lines in file: 5.");
  });

  test("tail mode exceeds file length returns entire file", async () => {
    const filePath = await createSampleFile();
    const result = await tool.execute({ path: filePath, line_offset: -100, n_lines: 1000 }, ctx);

    expect(result.isError).toBe(false);
    expect(result.output).toContain("Line 1: Hello World");
    expect(result.output).toContain("Line 5: End of file");
    expect(result.message).toContain("Total lines in file: 5.");
  });

  test("tail mode on empty file", async () => {
    const filePath = await createSampleFile("empty_tail.txt", "");
    const result = await tool.execute({ path: filePath, line_offset: -10, n_lines: 1000 }, ctx);

    expect(result.isError).toBe(false);
    expect(result.output).toBe("");
    expect(result.message).toContain("Total lines in file: 0.");
  });

  test("tail mode last line only", async () => {
    const filePath = await createSampleFile();
    const result = await tool.execute({ path: filePath, line_offset: -1, n_lines: 1000 }, ctx);

    expect(result.isError).toBe(false);
    expect(result.output).toContain("5\tLine 5: End of file");
    expect(result.message).toContain("1 lines read from file starting from line 5.");
    expect(result.message).toContain("Total lines in file: 5.");
    expect(result.message).toContain("End of file reached.");
  });

  test("tail mode line_offset=0 returns error", async () => {
    const filePath = await createSampleFile();
    const result = await tool.execute({ path: filePath, line_offset: 0, n_lines: 1000 }, ctx);

    expect(result.isError).toBe(true);
    expect(result.message).toContain("line_offset cannot be 0");
  });

  test("tail mode line_offset too negative returns error", async () => {
    const filePath = await createSampleFile();
    const result = await tool.execute({ path: filePath, line_offset: -1001, n_lines: 1000 }, ctx);

    expect(result.isError).toBe(true);
    expect(result.message).toContain("line_offset cannot be less than -1000");
  });

  test("tail mode line truncation", async () => {
    const shortLine = "Short line";
    const longLine = "X".repeat(2500); // Exceeds MAX_LINE_LENGTH=2000
    const content = `${shortLine}\n${longLine}\n${shortLine}\n${longLine}\n${shortLine}`;
    const filePath = await createSampleFile("tail_trunc.txt", content);

    // Read last 3 lines (lines 3, 4, 5)
    const result = await tool.execute({ path: filePath, line_offset: -3, n_lines: 1000 }, ctx);

    expect(result.isError).toBe(false);
    expect(result.message).toContain("Total lines in file: 5.");
    expect(result.message).toContain("Lines [4] were truncated.");
    expect(result.output).toContain("...");
  });
});
