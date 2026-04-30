/**
 * MCP CLI E2E tests — corresponds to Python tests_e2e/test_mcp_cli.py
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  baseCommand,
  cleanupTmpDir,
  makeTmpDir,
  makeEnv,
  makeHomeDir,
  normalizeValue,
  repoRoot,
  resetPathReplacements,
  shareDir,
} from "./wire_helpers";

function normalizeCLIOutput(
  text: string,
  replace?: Record<string, string>,
): string {
  let normalized = text;
  if (replace) {
    for (const [old, newVal] of Object.entries(replace)) {
      if (old && normalized.includes(old)) {
        normalized = normalized.split(old).join(newVal);
      }
    }
  }
  normalized = normalizeValue(normalized) as string;
  normalized = normalized.replace(/kimi-agent mcp/g, "<cmd> mcp");
  normalized = normalized.replace(/kimi mcp/g, "<cmd> mcp");
  return normalized;
}

function runCLI(
  args: string[],
  env: Record<string, string>,
): { stdout: string; stderr: string; exitCode: number } {
  const cmd = baseCommand();
  const result = Bun.spawnSync([...cmd, ...args], {
    cwd: repoRoot(),
    env,
  });
  return {
    stdout: result.stdout.toString("utf-8"),
    stderr: result.stderr.toString("utf-8"),
    exitCode: result.exitCode,
  };
}

function mcpConfigPath(homeDir: string): string {
  return path.join(shareDir(homeDir), "mcp.json");
}

function loadMCPConfig(
  homeDir: string,
  replacements?: Record<string, string>,
): Record<string, unknown> {
  const configPath = mcpConfigPath(homeDir);
  expect(fs.existsSync(configPath)).toBe(true);
  const data = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  const normalized = normalizeValue(data, replacements);
  return normalized as Record<string, unknown>;
}

describe("MCP CLI", () => {
  let tmpPath: string;

  beforeAll(() => {
    resetPathReplacements();
    tmpPath = makeTmpDir();
  });

  afterAll(() => {
    cleanupTmpDir(tmpPath);
  });

  it("test_mcp_stdio_management", () => {
    const homeDir = makeHomeDir(tmpPath);
    const env = makeEnv(homeDir);

    const serverPath = path.join(tmpPath, "mcp_server.py");
    fs.writeFileSync(
      serverPath,
      [
        'from fastmcp.server import FastMCP',
        '',
        'server = FastMCP("test-mcp")',
        '',
        '@server.tool',
        'def ping(text: str) -> str:',
        '    """pong the input text"""',
        '    return f"pong:{text}"',
        '',
        'if __name__ == "__main__":',
        '    server.run(transport="stdio", show_banner=False)',
      ].join("\n") + "\n",
      "utf-8",
    );

    const replacements: Record<string, string> = {
      [process.execPath]: "<bun>",
      [serverPath]: "<server>",
    };

    // Add
    const add = runCLI(
      [
        "mcp",
        "add",
        "--transport",
        "stdio",
        "test",
        "--",
        "python3",
        serverPath,
      ],
      env,
    );
    expect(add.exitCode).toBe(0);
    expect(normalizeCLIOutput(add.stdout, replacements)).toContain(
      "Added MCP server 'test'",
    );

    // List
    const listed = runCLI(["mcp", "list"], env);
    expect(listed.exitCode).toBe(0);
    expect(normalizeCLIOutput(listed.stdout, replacements)).toContain("test");

    // Remove
    const removed = runCLI(["mcp", "remove", "test"], env);
    expect(removed.exitCode).toBe(0);
    expect(normalizeCLIOutput(removed.stdout, replacements)).toContain(
      "Removed MCP server 'test'",
    );

    // List empty
    const listedEmpty = runCLI(["mcp", "list"], env);
    expect(listedEmpty.exitCode).toBe(0);
    expect(normalizeCLIOutput(listedEmpty.stdout, replacements)).toContain(
      "No MCP servers configured",
    );
  });

  it("test_mcp_http_management_and_auth_errors", () => {
    const homeDir = makeHomeDir(tmpPath);
    const env = makeEnv(homeDir);

    // Add HTTP
    const addHttp = runCLI(
      [
        "mcp",
        "add",
        "--transport",
        "http",
        "remote",
        "https://example.com/mcp",
        "--header",
        "X-Test: 1",
      ],
      env,
    );
    expect(addHttp.exitCode).toBe(0);
    expect(normalizeCLIOutput(addHttp.stdout)).toContain(
      "Added MCP server 'remote'",
    );

    // Add OAuth
    const addOauth = runCLI(
      [
        "mcp",
        "add",
        "--transport",
        "http",
        "--auth",
        "oauth",
        "oauth",
        "https://example.com/oauth",
      ],
      env,
    );
    expect(addOauth.exitCode).toBe(0);
    expect(normalizeCLIOutput(addOauth.stdout)).toContain(
      "Added MCP server 'oauth'",
    );

    // List
    const listHttp = runCLI(["mcp", "list"], env);
    expect(listHttp.exitCode).toBe(0);
    const listOutput = normalizeCLIOutput(listHttp.stdout);
    expect(listOutput).toContain("remote");
    expect(listOutput).toContain("oauth");

    // Auth on non-oauth server
    const authHttp = runCLI(["mcp", "auth", "remote"], env);
    expect(authHttp.exitCode).not.toBe(0);

    // Reset auth on non-remote
    const addStdio = runCLI(
      [
        "mcp",
        "add",
        "--transport",
        "stdio",
        "local",
        "--",
        "python3",
        "-c",
        "print('noop')",
      ],
      env,
    );
    expect(addStdio.exitCode).toBe(0);

    const authStdio = runCLI(["mcp", "auth", "local"], env);
    expect(authStdio.exitCode).not.toBe(0);

    // Remove missing
    const removeMissing = runCLI(["mcp", "remove", "missing"], env);
    expect(removeMissing.exitCode).not.toBe(0);
  });
});
