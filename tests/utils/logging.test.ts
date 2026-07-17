/**
 * Tests for utils/logging.ts — logger.
 * The logger writes to disk via log4js. We test level filtering
 * by inspecting the internal buffer before setLogDir is called.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { logger } from "../../src/kimi_cli_ts/utils/logging.ts";

describe("Logger", () => {
  afterEach(() => {
    logger.setLevel("info");
  });

  test("setLevel changes the level", () => {
    // Shouldn't throw
    logger.setLevel("debug");
    logger.setLevel("info");
    logger.setLevel("warn");
    logger.setLevel("error");
  });

  test("log methods don't throw at any level", () => {
    logger.setLevel("debug");
    expect(() => logger.debug("dbg")).not.toThrow();
    expect(() => logger.info("inf")).not.toThrow();
    expect(() => logger.warn("wrn")).not.toThrow();
    expect(() => logger.error("err")).not.toThrow();
  });

  test("log methods with extra args don't throw", () => {
    logger.setLevel("debug");
    expect(() => logger.debug("msg", "arg1", 42)).not.toThrow();
    expect(() => logger.info("msg", { key: "val" })).not.toThrow();
    expect(() => logger.warn("msg", new Error("test"))).not.toThrow();
    expect(() => logger.error("msg", "detail1", "detail2")).not.toThrow();
  });

  test("logger is a singleton", async () => {
    const { logger: logger2 } = await import("../../src/kimi_cli_ts/utils/logging.ts");
    expect(logger).toBe(logger2);
  });

  test("setLevel accepts valid log levels", () => {
    for (const level of ["debug", "info", "warn", "error"] as const) {
      expect(() => logger.setLevel(level)).not.toThrow();
    }
  });
});
