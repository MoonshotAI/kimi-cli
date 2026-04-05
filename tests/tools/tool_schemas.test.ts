/**
 * Tests for all tool Zod schemas and toDefinition().
 * Corresponds to Python tests/tools/test_tool_schemas.py
 */

import { test, expect, describe } from "bun:test";
import { ReadFile } from "../../src/kimi_cli_ts/tools/file/read.ts";
import { WriteFile } from "../../src/kimi_cli_ts/tools/file/write.ts";
import { StrReplaceFile } from "../../src/kimi_cli_ts/tools/file/replace.ts";
import { Glob } from "../../src/kimi_cli_ts/tools/file/glob.ts";
import { Grep } from "../../src/kimi_cli_ts/tools/file/grep.ts";
import { Shell } from "../../src/kimi_cli_ts/tools/shell/index.ts";
import { FetchURL } from "../../src/kimi_cli_ts/tools/web/fetch.ts";
import { Think } from "../../src/kimi_cli_ts/tools/think/index.ts";
import { AskUserQuestion } from "../../src/kimi_cli_ts/tools/ask_user/index.ts";
import { SetTodoList } from "../../src/kimi_cli_ts/tools/todo/index.ts";

describe("Tool Schemas", () => {
  describe("ReadFile schema", () => {
    const tool = new ReadFile();

    test("valid params parse successfully", () => {
      const result = tool.schema.safeParse({ path: "/tmp/test.txt" });
      expect(result.success).toBe(true);
    });

    test("defaults are applied", () => {
      const result = tool.schema.safeParse({ path: "/tmp/test.txt" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.line_offset).toBe(1);
        expect(result.data.n_lines).toBe(1000);
      }
    });

    test("missing path fails", () => {
      const result = tool.schema.safeParse({});
      expect(result.success).toBe(false);
    });

    test("toDefinition returns valid definition", () => {
      const def = tool.toDefinition();
      expect(def.name).toBe("ReadFile");
      expect(def.description).toBeTruthy();
      expect(typeof def.parameters).toBe("object");
    });
  });

  describe("WriteFile schema", () => {
    const tool = new WriteFile();

    test("valid params parse successfully", () => {
      const result = tool.schema.safeParse({ path: "/tmp/test.txt", content: "hello" });
      expect(result.success).toBe(true);
    });

    test("defaults are applied", () => {
      const result = tool.schema.safeParse({ path: "/tmp/test.txt", content: "hello" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.mode).toBe("overwrite");
      }
    });

    test("missing content fails", () => {
      const result = tool.schema.safeParse({ path: "/tmp/test.txt" });
      expect(result.success).toBe(false);
    });

    test("toDefinition returns valid definition", () => {
      const def = tool.toDefinition();
      expect(def.name).toBe("WriteFile");
      expect(def.description).toBeTruthy();
      expect(typeof def.parameters).toBe("object");
    });
  });

  describe("StrReplaceFile schema", () => {
    const tool = new StrReplaceFile();

    test("single edit parses successfully", () => {
      const result = tool.schema.safeParse({
        path: "/tmp/test.txt",
        edit: { old: "hello", new: "world" },
      });
      expect(result.success).toBe(true);
    });

    test("array of edits parses successfully", () => {
      const result = tool.schema.safeParse({
        path: "/tmp/test.txt",
        edit: [
          { old: "hello", new: "world" },
          { old: "foo", new: "bar", replace_all: true },
        ],
      });
      expect(result.success).toBe(true);
    });

    test("missing edit fails", () => {
      const result = tool.schema.safeParse({ path: "/tmp/test.txt" });
      expect(result.success).toBe(false);
    });

    test("toDefinition returns valid definition", () => {
      const def = tool.toDefinition();
      expect(def.name).toBe("StrReplaceFile");
      expect(def.description).toBeTruthy();
      expect(typeof def.parameters).toBe("object");
    });
  });

  describe("Glob schema", () => {
    const tool = new Glob();

    test("valid params parse successfully", () => {
      const result = tool.schema.safeParse({ pattern: "*.ts" });
      expect(result.success).toBe(true);
    });

    test("missing pattern fails", () => {
      const result = tool.schema.safeParse({});
      expect(result.success).toBe(false);
    });

    test("toDefinition returns valid definition", () => {
      const def = tool.toDefinition();
      expect(def.name).toBe("Glob");
      expect(def.description).toBeTruthy();
      expect(typeof def.parameters).toBe("object");
    });
  });

  describe("Grep schema", () => {
    const tool = new Grep();

    test("valid params parse successfully", () => {
      const result = tool.schema.safeParse({ pattern: "test" });
      expect(result.success).toBe(true);
    });

    test("defaults are applied", () => {
      const result = tool.schema.safeParse({ pattern: "test" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.output_mode).toBe("files_with_matches");
        expect(result.data["-n"]).toBe(true);
        expect(result.data["-i"]).toBe(false);
        expect(result.data.head_limit).toBe(250);
        expect(result.data.offset).toBe(0);
        expect(result.data.multiline).toBe(false);
      }
    });

    test("missing pattern fails", () => {
      const result = tool.schema.safeParse({});
      expect(result.success).toBe(false);
    });

    test("toDefinition returns valid definition", () => {
      const def = tool.toDefinition();
      expect(def.name).toBe("Grep");
      expect(def.description).toBeTruthy();
      expect(typeof def.parameters).toBe("object");
    });
  });

  describe("Shell schema", () => {
    const tool = new Shell();

    test("valid params parse successfully", () => {
      const result = tool.schema.safeParse({ command: "echo test" });
      expect(result.success).toBe(true);
    });

    test("defaults are applied", () => {
      const result = tool.schema.safeParse({ command: "echo test" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.timeout).toBe(60);
        expect(result.data.run_in_background).toBe(false);
      }
    });

    test("missing command fails", () => {
      const result = tool.schema.safeParse({});
      expect(result.success).toBe(false);
    });

    test("toDefinition returns valid definition", () => {
      const def = tool.toDefinition();
      expect(def.name).toBe("Shell");
      expect(def.description).toBeTruthy();
      expect(typeof def.parameters).toBe("object");
    });
  });

  describe("FetchURL schema", () => {
    const tool = new FetchURL();

    test("valid params parse successfully", () => {
      const result = tool.schema.safeParse({ url: "https://example.com" });
      expect(result.success).toBe(true);
    });

    test("missing url fails", () => {
      const result = tool.schema.safeParse({});
      expect(result.success).toBe(false);
    });

    test("toDefinition returns valid definition", () => {
      const def = tool.toDefinition();
      expect(def.name).toBe("FetchURL");
      expect(def.description).toBeTruthy();
      expect(typeof def.parameters).toBe("object");
    });
  });

  describe("Think schema", () => {
    const tool = new Think();

    test("valid params parse successfully", () => {
      const result = tool.schema.safeParse({ thought: "thinking..." });
      expect(result.success).toBe(true);
    });

    test("missing thought fails", () => {
      const result = tool.schema.safeParse({});
      expect(result.success).toBe(false);
    });

    test("toDefinition returns valid definition", () => {
      const def = tool.toDefinition();
      expect(def.name).toBe("Think");
      expect(def.description).toBeTruthy();
      expect(typeof def.parameters).toBe("object");
    });
  });

  describe("AskUserQuestion schema", () => {
    const tool = new AskUserQuestion();

    test("valid params parse successfully", () => {
      const result = tool.schema.safeParse({
        questions: [
          {
            question: "Which?",
            header: "Choice",
            options: [
              { label: "A", description: "opt A" },
              { label: "B", description: "opt B" },
            ],
            multi_select: false,
          },
        ],
      });
      expect(result.success).toBe(true);
    });

    test("empty questions array fails (min 1)", () => {
      const result = tool.schema.safeParse({ questions: [] });
      expect(result.success).toBe(false);
    });

    test("toDefinition returns valid definition", () => {
      const def = tool.toDefinition();
      expect(def.name).toBe("AskUserQuestion");
      expect(def.description).toBeTruthy();
      expect(typeof def.parameters).toBe("object");
    });
  });

  describe("SetTodoList schema", () => {
    const tool = new SetTodoList();

    test("valid params parse successfully", () => {
      const result = tool.schema.safeParse({
        todos: [{ title: "Test", status: "pending" }],
      });
      expect(result.success).toBe(true);
    });

    test("invalid status fails", () => {
      const result = tool.schema.safeParse({
        todos: [{ title: "Test", status: "invalid" }],
      });
      expect(result.success).toBe(false);
    });

    test("empty title fails", () => {
      const result = tool.schema.safeParse({
        todos: [{ title: "", status: "pending" }],
      });
      expect(result.success).toBe(false);
    });

    test("toDefinition returns valid definition", () => {
      const def = tool.toDefinition();
      expect(def.name).toBe("SetTodoList");
      expect(def.description).toBeTruthy();
      expect(typeof def.parameters).toBe("object");
    });
  });
});
