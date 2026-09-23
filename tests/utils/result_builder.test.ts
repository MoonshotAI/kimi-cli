/**
 * Tests for tools/types.ts — ToolResultBuilder and helpers.
 */
import { test, expect, describe } from "bun:test";
import {
  ToolResultBuilder,
  ToolOk,
  ToolError,
} from "../../src/kimi_cli_ts/tools/types.ts";

describe("ToolOk / ToolError", () => {
  test("ToolOk creates successful result", () => {
    const result = ToolOk("output text", "message");
    expect(result.isError).toBe(false);
    expect(result.output).toBe("output text");
    expect(result.message).toBe("message");
  });

  test("ToolError creates error result", () => {
    const result = ToolError("something failed", "partial output");
    expect(result.isError).toBe(true);
    expect(result.output).toBe("partial output");
    expect(result.message).toBe("something failed");
  });

  test("ToolOk with display blocks", () => {
    const result = ToolOk("out", "msg", [{ type: "brief", brief: "hi" }]);
    expect(result.display).toEqual([{ type: "brief", brief: "hi" }]);
  });

  test("ToolOk with extras", () => {
    const result = ToolOk("out", undefined, undefined, { key: "value" });
    expect(result.extras).toEqual({ key: "value" });
  });
});

describe("ToolResultBuilder", () => {
  test("write adds text to buffer", () => {
    const b = new ToolResultBuilder();
    b.write("hello\n");
    b.write("world\n");
    const result = b.ok();
    expect(result.output).toBe("hello\nworld\n");
    expect(result.isError).toBe(false);
    expect(b.nLines).toBe(2);
    expect(b.nChars).toBe(12);
  });

  test("write truncates at maxChars", () => {
    const b = new ToolResultBuilder(10);
    b.write("12345\n");
    b.write("67890\n");
    b.write("abcde\n"); // should not fit
    expect(b.isFull).toBe(true);
    const result = b.ok();
    // First line (6 chars) fits, second line gets truncated marker + newline
    expect(result.output).toBe("12345\n[...truncated]\n");
    expect(result.message).toContain("truncated");
  });

  test("write truncates long lines", () => {
    const b = new ToolResultBuilder(50000, 10);
    b.write("a very long line that exceeds the max line length\n");
    const result = b.ok();
    // Line gets replaced by truncation marker [...truncated] which is longer than maxLineLength
    // The marker itself is the minimum output
    expect(result.output).toBe("[...truncated]\n");
    expect(result.message).toContain("truncated");
  });

  test("write returns 0 when full", () => {
    const b = new ToolResultBuilder(5);
    b.write("12345");
    expect(b.isFull).toBe(true);
    const written = b.write("more");
    expect(written).toBe(0);
  });

  test("ok message gets period appended", () => {
    const b = new ToolResultBuilder();
    b.write("content");
    const result = b.ok("Done");
    expect(result.message).toBe("Done.");
  });

  test("ok message with period is not doubled", () => {
    const b = new ToolResultBuilder();
    b.write("content");
    const result = b.ok("Done.");
    expect(result.message).toBe("Done.");
  });

  test("ok with empty message and no truncation returns undefined message", () => {
    const b = new ToolResultBuilder();
    b.write("content");
    const result = b.ok();
    expect(result.message).toBeUndefined();
  });

  test("ok with truncation adds truncation note", () => {
    const b = new ToolResultBuilder(5);
    b.write("1234567890");
    const result = b.ok();
    expect(result.message).toContain("truncated");
  });

  test("error includes message", () => {
    const b = new ToolResultBuilder();
    b.write("error output");
    const result = b.error("Something went wrong");
    expect(result.isError).toBe(true);
    expect(result.message).toBe("Something went wrong");
    expect(result.output).toBe("error output");
  });

  test("error with truncation appends truncation note", () => {
    const b = new ToolResultBuilder(5);
    b.write("1234567890");
    const result = b.error("Error");
    expect(result.message).toContain("truncated");
    expect(result.message).toContain("Error");
  });

  test("display blocks are passed through", () => {
    const b = new ToolResultBuilder();
    b.display({ type: "brief", brief: "info" });
    const result = b.ok();
    expect(result.display).toEqual([{ type: "brief", brief: "info" }]);
  });

  test("extras are passed through", () => {
    const b = new ToolResultBuilder();
    b.extras({ count: 42 });
    const result = b.ok();
    expect(result.extras).toEqual({ count: 42 });
  });

  test("extras merge multiple calls", () => {
    const b = new ToolResultBuilder();
    b.extras({ a: 1 });
    b.extras({ b: 2 });
    const result = b.ok();
    expect(result.extras).toEqual({ a: 1, b: 2 });
  });

  test("no display or extras returns undefined", () => {
    const b = new ToolResultBuilder();
    b.write("content");
    const result = b.ok();
    expect(result.display).toBeUndefined();
    expect(result.extras).toBeUndefined();
  });

  test("maxLineLength null disables line truncation", () => {
    const b = new ToolResultBuilder(50000, null);
    const longLine = "a".repeat(5000) + "\n";
    b.write(longLine);
    const result = b.ok();
    expect(result.output.length).toBe(5001); // 5000 chars + newline
  });
});
