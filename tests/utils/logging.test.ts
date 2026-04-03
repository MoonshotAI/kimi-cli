/**
 * Tests for utils/logging.ts — logger.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { logger } from "../../src/kimi_cli_ts/utils/logging.ts";

describe("Logger", () => {
  // Capture stderr writes
  const originalWrite = process.stderr.write;
  let stderrOutput: string[];

  beforeEach(() => {
    stderrOutput = [];
    process.stderr.write = ((data: string | Uint8Array) => {
      stderrOutput.push(typeof data === "string" ? data : new TextDecoder().decode(data));
      return true;
    }) as any;
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
    // Reset to info
    logger.setLevel("info");
  });

  test("info level logs info, warn, error but not debug", () => {
    logger.setLevel("info");
    logger.debug("dbg");
    logger.info("inf");
    logger.warn("wrn");
    logger.error("err");

    const output = stderrOutput.join("");
    expect(output).not.toContain("[DEBUG]");
    expect(output).toContain("[INFO]");
    expect(output).toContain("[WARN]");
    expect(output).toContain("[ERROR]");
  });

  test("debug level logs everything", () => {
    logger.setLevel("debug");
    logger.debug("dbg");
    logger.info("inf");
    logger.warn("wrn");
    logger.error("err");

    const output = stderrOutput.join("");
    expect(output).toContain("[DEBUG]");
    expect(output).toContain("[INFO]");
    expect(output).toContain("[WARN]");
    expect(output).toContain("[ERROR]");
  });

  test("error level only logs errors", () => {
    logger.setLevel("error");
    logger.debug("dbg");
    logger.info("inf");
    logger.warn("wrn");
    logger.error("err");

    const output = stderrOutput.join("");
    expect(output).not.toContain("[DEBUG]");
    expect(output).not.toContain("[INFO]");
    expect(output).not.toContain("[WARN]");
    expect(output).toContain("[ERROR]");
  });

  test("warn level logs warn and error", () => {
    logger.setLevel("warn");
    logger.debug("dbg");
    logger.info("inf");
    logger.warn("wrn");
    logger.error("err");

    const output = stderrOutput.join("");
    expect(output).not.toContain("[DEBUG]");
    expect(output).not.toContain("[INFO]");
    expect(output).toContain("[WARN]");
    expect(output).toContain("[ERROR]");
  });

  test("log messages have level prefix", () => {
    logger.setLevel("debug");
    logger.debug("test message");
    expect(stderrOutput.join("")).toContain("[DEBUG] test message");

    stderrOutput = [];
    logger.info("test message");
    expect(stderrOutput.join("")).toContain("[INFO] test message");
  });
});
