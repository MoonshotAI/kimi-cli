/**
 * Tests for ui/print/index.ts — PrintMode event handling and classifyError.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { PrintMode, classifyError, type OutputFormat } from "../../src/kimi_cli_ts/ui/print/index";
import type { WireUIEvent } from "../../src/kimi_cli_ts/ui/shell/events";

// ── Capture stdout/stderr ───────────────────────────────

let stdoutChunks: string[];
let stderrChunks: string[];
let origStdoutWrite: typeof process.stdout.write;
let origStderrWrite: typeof process.stderr.write;

beforeEach(() => {
  stdoutChunks = [];
  stderrChunks = [];
  origStdoutWrite = process.stdout.write;
  origStderrWrite = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
});

// ── PrintMode text format ───────────────────────────────

describe("PrintMode text format", () => {
  test("text_delta prints directly in streaming mode", () => {
    const pm = new PrintMode({ outputFormat: "text", finalOnly: false });
    pm.handleEvent({ type: "text_delta", text: "hello" });
    expect(stdoutChunks.join("")).toBe("hello");
  });

  test("turn_end adds newline in streaming text mode", () => {
    const pm = new PrintMode({ outputFormat: "text", finalOnly: false });
    pm.handleEvent({ type: "text_delta", text: "hello" });
    pm.handleEvent({ type: "turn_end" });
    expect(stdoutChunks.join("")).toBe("hello\n");
  });

  test("finalOnly buffers and prints on turn_end", () => {
    const pm = new PrintMode({ outputFormat: "text", finalOnly: true });
    pm.handleEvent({ type: "text_delta", text: "part1" });
    pm.handleEvent({ type: "text_delta", text: "part2" });
    expect(stdoutChunks.join("")).toBe(""); // nothing yet

    pm.handleEvent({ type: "turn_end" });
    expect(stdoutChunks.join("")).toBe("part1part2\n");
  });
});

// ── PrintMode stream-json format ────────────────────────

describe("PrintMode stream-json format", () => {
  test("text_delta emits JSON line", () => {
    const pm = new PrintMode({ outputFormat: "stream-json", finalOnly: false });
    pm.handleEvent({ type: "text_delta", text: "hi" });
    const parsed = JSON.parse(stdoutChunks[0]);
    expect(parsed.type).toBe("text_delta");
    expect(parsed.text).toBe("hi");
  });

  test("tool_call emits JSON in stream-json mode", () => {
    const pm = new PrintMode({ outputFormat: "stream-json", finalOnly: false });
    pm.handleEvent({
      type: "tool_call",
      id: "tc-1",
      name: "ReadFile",
      arguments: '{"path":"f.ts"}',
    });
    const parsed = JSON.parse(stdoutChunks[0]);
    expect(parsed.type).toBe("tool_call");
    expect(parsed.name).toBe("ReadFile");
  });

  test("finalOnly stream-json emits final_text on turn_end", () => {
    const pm = new PrintMode({ outputFormat: "stream-json", finalOnly: true });
    pm.handleEvent({ type: "text_delta", text: "abc" });
    pm.handleEvent({ type: "turn_end" });
    const parsed = JSON.parse(stdoutChunks[0]);
    expect(parsed.type).toBe("final_text");
    expect(parsed.text).toBe("abc");
  });
});

// ── Error handling ──────────────────────────────────────

describe("PrintMode error handling", () => {
  test("error events write to stderr", () => {
    const pm = new PrintMode({ outputFormat: "text", finalOnly: false });
    pm.handleEvent({ type: "error", message: "something broke" });
    expect(stderrChunks.join("")).toContain("something broke");
  });
});

// ── Ignored events ──────────────────────────────────────

describe("PrintMode ignored events", () => {
  test("step_begin is silently ignored", () => {
    const pm = new PrintMode({ outputFormat: "text", finalOnly: false });
    pm.handleEvent({ type: "step_begin", n: 1 });
    expect(stdoutChunks).toHaveLength(0);
    expect(stderrChunks).toHaveLength(0);
  });
});

// ── classifyError ───────────────────────────────────────

describe("classifyError", () => {
  test("429 is retryable", () => {
    expect(classifyError(new Error("HTTP 429 rate limit"))).toBe("retryable");
  });

  test("timeout is retryable", () => {
    expect(classifyError(new Error("Request timeout"))).toBe("retryable");
  });

  test("connection error is retryable", () => {
    expect(classifyError(new Error("Connection refused"))).toBe("retryable");
  });

  test("500/502/503/504 are retryable", () => {
    for (const code of ["500", "502", "503", "504"]) {
      expect(classifyError(new Error(`HTTP ${code}`))).toBe("retryable");
    }
  });

  test("auth error is permanent", () => {
    expect(classifyError(new Error("Unauthorized 401"))).toBe("permanent");
  });

  test("non-Error is unknown", () => {
    expect(classifyError("string error")).toBe("unknown");
    expect(classifyError(42)).toBe("unknown");
  });
});
