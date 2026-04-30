/**
 * E2E tests for CLI entry point — version, help, invalid options.
 * Corresponds to Python tests/e2e/test_cli_error_output.py
 */

import { test, expect, describe } from "bun:test";
import { resolve } from "node:path";

const PROJECT_ROOT = resolve(import.meta.dir, "../..");
const ENTRY = resolve(PROJECT_ROOT, "src/kimi_cli_ts/index.ts");

function runCli(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["bun", "run", ENTRY, ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, NODE_ENV: "test" },
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("CLI --version", () => {
  test("outputs version number", () => {
    const { stdout, exitCode } = runCli(["--version"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/\d+\.\d+\.\d+/);
  });
});

describe("CLI --help", () => {
  test("outputs help information", () => {
    const { stdout, exitCode } = runCli(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("kimi");
    expect(stdout).toContain("--help");
  });

  test("help mentions model option", () => {
    const { stdout } = runCli(["--help"]);
    expect(stdout).toContain("--model");
  });
});

describe("CLI invalid options", () => {
  test("unknown option produces error", () => {
    const { exitCode, stderr } = runCli(["--nonexistent-flag-xyz"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("unknown option");
  });
});
