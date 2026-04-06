/**
 * Tests for Grep tool.
 * Corresponds to Python tests/tools/test_grep.py
 */

import { test, expect, describe, beforeEach, afterEach, beforeAll } from "bun:test";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { createTempDir, removeTempDir, createTestToolContext } from "../conftest.ts";
import { Grep } from "../../src/kimi_cli_ts/tools/file/grep.ts";

// Check if rg (ripgrep) is available — use the same search logic as the Grep tool:
// 1. ~/.kimi/bin/rg  2. <source>/deps/bin/rg  3. System PATH
let rgAvailable = false;
try {
  // First try the bundled binary in deps/bin/rg (development mode)
  const currentDir = import.meta.dir;
  const projectRoot = join(currentDir, "..", "..");
  const localDep = join(projectRoot, "src", "kimi_cli", "deps", "bin", "rg");
  const { existsSync } = await import("node:fs");
  if (existsSync(localDep)) {
    const proc = Bun.spawnSync([localDep, "--version"]);
    rgAvailable = proc.exitCode === 0;
  }
  // Fallback to system PATH
  if (!rgAvailable) {
    const proc = Bun.spawnSync(["rg", "--version"]);
    rgAvailable = proc.exitCode === 0;
  }
} catch {
  rgAvailable = false;
}

let tempDir: string;
let tool: Grep;
let ctx: ReturnType<typeof createTestToolContext>;

beforeEach(() => {
  tempDir = createTempDir();
  tool = new Grep();
  ctx = createTestToolContext(tempDir);
});

afterEach(() => {
  removeTempDir(tempDir);
});

async function setupTestFiles(): Promise<string> {
  await Bun.write(
    join(tempDir, "test1.py"),
    `def hello_world():
    print("Hello, World!")
    return "hello"

class TestClass:
    def __init__(self):
        self.message = "hello there"
`,
  );

  await Bun.write(
    join(tempDir, "test2.js"),
    `function helloWorld() {
    console.log("Hello, World!");
    return "hello";
}

class TestClass {
    constructor() {
        this.message = "hello there";
    }
}
`,
  );

  await Bun.write(
    join(tempDir, "readme.txt"),
    `This is a readme file.
It contains some text.
Hello world example is here.
`,
  );

  mkdirSync(join(tempDir, "subdir"), { recursive: true });
  await Bun.write(join(tempDir, "subdir", "subtest.py"), "def sub_hello():\n    return 'hello from subdir'\n");

  return tempDir;
}

// Use test.skipIf for tests requiring rg binary
const rgTest = rgAvailable ? test : test.skip;

describe("Grep", () => {
  rgTest("files_with_matches mode", async () => {
    await setupTestFiles();
    const result = await tool.execute(
      {
        pattern: "Hello",
        path: tempDir,
        output_mode: "files_with_matches",
        "-B": null,
        "-A": null,
        "-C": null,
        "-n": true,
        "-i": false,
        glob: null,
        type: null,
        head_limit: 250,
        offset: 0,
        multiline: false,
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("test1.py");
    expect(result.output).toContain("test2.js");
    expect(result.output).toContain("readme.txt");
  });

  rgTest("content mode", async () => {
    await setupTestFiles();
    const result = await tool.execute(
      {
        pattern: "hello",
        path: tempDir,
        output_mode: "content",
        "-B": null,
        "-A": null,
        "-C": null,
        "-n": true,
        "-i": true,
        glob: null,
        type: null,
        head_limit: 250,
        offset: 0,
        multiline: false,
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.output.toLowerCase()).toContain("hello");
    // Content mode should have colons (file:linenum:content)
    expect(result.output).toContain(":");
  });

  rgTest("case insensitive search", async () => {
    await setupTestFiles();
    const result = await tool.execute(
      {
        pattern: "HELLO",
        path: tempDir,
        output_mode: "files_with_matches",
        "-B": null,
        "-A": null,
        "-C": null,
        "-n": true,
        "-i": true,
        glob: null,
        type: null,
        head_limit: 250,
        offset: 0,
        multiline: false,
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("test1.py");
  });

  rgTest("context lines with -C", async () => {
    await setupTestFiles();
    const result = await tool.execute(
      {
        pattern: "TestClass",
        path: tempDir,
        output_mode: "content",
        "-B": null,
        "-A": null,
        "-C": 1,
        "-n": true,
        "-i": false,
        glob: null,
        type: null,
        head_limit: 250,
        offset: 0,
        multiline: false,
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    const lines = result.output.split("\n");
    // Should have more than just the matching lines (context added)
    expect(lines.length).toBeGreaterThan(2);
  });

  rgTest("count_matches mode", async () => {
    await setupTestFiles();
    const result = await tool.execute(
      {
        pattern: "hello",
        path: tempDir,
        output_mode: "count_matches",
        "-B": null,
        "-A": null,
        "-C": null,
        "-n": true,
        "-i": true,
        glob: null,
        type: null,
        head_limit: 250,
        offset: 0,
        multiline: false,
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("test1.py");
    expect(result.output).toContain("test2.js");
    // Message should contain summary
    expect(result.message).toContain("Found");
    expect(result.message).toContain("total occurrences");
  });

  rgTest("glob filter", async () => {
    await setupTestFiles();
    const result = await tool.execute(
      {
        pattern: "hello",
        path: tempDir,
        output_mode: "files_with_matches",
        "-B": null,
        "-A": null,
        "-C": null,
        "-n": true,
        "-i": true,
        glob: "*.py",
        type: null,
        head_limit: 250,
        offset: 0,
        multiline: false,
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("test1.py");
    expect(result.output).toContain("subtest.py");
    expect(result.output).not.toContain("test2.js");
    expect(result.output).not.toContain("readme.txt");
  });

  rgTest("type filter", async () => {
    await setupTestFiles();
    const result = await tool.execute(
      {
        pattern: "hello",
        path: tempDir,
        output_mode: "files_with_matches",
        "-B": null,
        "-A": null,
        "-C": null,
        "-n": true,
        "-i": true,
        glob: null,
        type: "py",
        head_limit: 250,
        offset: 0,
        multiline: false,
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("test1.py");
    expect(result.output).not.toContain("test2.js");
    expect(result.output).not.toContain("readme.txt");
  });

  rgTest("head_limit truncation", async () => {
    await setupTestFiles();
    const result = await tool.execute(
      {
        pattern: "hello",
        path: tempDir,
        output_mode: "files_with_matches",
        "-B": null,
        "-A": null,
        "-C": null,
        "-n": true,
        "-i": true,
        glob: null,
        type: null,
        head_limit: 2,
        offset: 0,
        multiline: false,
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    const lines = result.output.split("\n").filter((l: string) => l.trim());
    expect(lines.length).toBeLessThanOrEqual(2);
    expect(result.message).toContain("Results truncated to 2 lines");
  });

  rgTest("no matches", async () => {
    await Bun.write(join(tempDir, "empty.py"), "# No matching content\n");

    const result = await tool.execute(
      {
        pattern: "nonexistent_pattern",
        path: tempDir,
        output_mode: "files_with_matches",
        "-B": null,
        "-A": null,
        "-C": null,
        "-n": true,
        "-i": false,
        glob: null,
        type: null,
        head_limit: 250,
        offset: 0,
        multiline: false,
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.message).toContain("No matches found");
  });

  rgTest("multiline mode", async () => {
    await Bun.write(
      join(tempDir, "multiline.py"),
      `def function():
    '''This is a
    multiline docstring'''
    pass
`,
    );

    const result = await tool.execute(
      {
        pattern: "This is a\\n    multiline",
        path: tempDir,
        output_mode: "content",
        "-B": null,
        "-A": null,
        "-C": null,
        "-n": false,
        "-i": false,
        glob: null,
        type: null,
        head_limit: 250,
        offset: 0,
        multiline: true,
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("This is a");
    expect(result.output).toContain("multiline");
  });

  rgTest("hidden files are searchable", async () => {
    await Bun.write(join(tempDir, ".hidden_config"), "SECRET_KEY=abc123\n");
    await Bun.write(join(tempDir, "visible.txt"), "SECRET_KEY=xyz\n");

    const result = await tool.execute(
      {
        pattern: "SECRET_KEY",
        path: tempDir,
        output_mode: "files_with_matches",
        "-B": null,
        "-A": null,
        "-C": null,
        "-n": true,
        "-i": false,
        glob: null,
        type: null,
        head_limit: 250,
        offset: 0,
        multiline: false,
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain(".hidden_config");
    expect(result.output).toContain("visible.txt");
  });

  rgTest(".git directory is excluded", async () => {
    mkdirSync(join(tempDir, ".git"), { recursive: true });
    await Bun.write(join(tempDir, ".git", "config"), "vcs_marker\n");
    await Bun.write(join(tempDir, "real.txt"), "vcs_marker\n");

    const result = await tool.execute(
      {
        pattern: "vcs_marker",
        path: tempDir,
        output_mode: "files_with_matches",
        "-B": null,
        "-A": null,
        "-C": null,
        "-n": true,
        "-i": false,
        glob: null,
        type: null,
        head_limit: 250,
        offset: 0,
        multiline: false,
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("real.txt");
    expect(result.output).not.toContain(".git");
  });

  rgTest("offset pagination", async () => {
    // Create a file with many matching lines
    const lines = Array.from({ length: 10 }, (_, i) => `line${i} word`).join("\n") + "\n";
    await Bun.write(join(tempDir, "data.txt"), lines);

    // Page 1: first 3
    const r1 = await tool.execute(
      {
        pattern: "word",
        path: tempDir,
        output_mode: "content",
        "-B": null,
        "-A": null,
        "-C": null,
        "-n": false,
        "-i": false,
        glob: null,
        type: null,
        head_limit: 3,
        offset: 0,
        multiline: false,
      },
      ctx,
    );

    expect(r1.isError).toBe(false);
    const lines1 = r1.output.split("\n").filter((l: string) => l.trim());
    expect(lines1.length).toBe(3);
    expect(r1.message).toContain("Use offset=3 to see more");

    // Page 2: next 3
    const r2 = await tool.execute(
      {
        pattern: "word",
        path: tempDir,
        output_mode: "content",
        "-B": null,
        "-A": null,
        "-C": null,
        "-n": false,
        "-i": false,
        glob: null,
        type: null,
        head_limit: 3,
        offset: 3,
        multiline: false,
      },
      ctx,
    );

    expect(r2.isError).toBe(false);
    const lines2 = r2.output.split("\n").filter((l: string) => l.trim());
    expect(lines2.length).toBe(3);
  });

  test("toDefinition returns valid schema", () => {
    const def = tool.toDefinition();
    expect(def.name).toBe("Grep");
    expect(def.description).toBeTruthy();
    expect(def.parameters).toBeDefined();
  });
});
