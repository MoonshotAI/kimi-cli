/**
 * Tests for the sensitive file detection module.
 * Corresponds to Python tests/utils/test_sensitive.py
 */

import { describe, test, expect } from "bun:test";
import { isSensitiveFile, sensitiveFileWarning } from "../../src/kimi_cli_ts/utils/sensitive.ts";

describe("isSensitiveFile", () => {
  test.each([".env", "/app/.env", "project/.env"])(
    "detects .env files: %s",
    (path) => {
      expect(isSensitiveFile(path)).toBe(true);
    },
  );

  test.each([".env.local", ".env.production", "/app/.env.staging"])(
    "detects .env variants: %s",
    (path) => {
      expect(isSensitiveFile(path)).toBe(true);
    },
  );

  test.each([
    "id_rsa",
    "id_ed25519",
    "id_ecdsa",
    "/home/user/.ssh/id_rsa",
    "/home/user/.ssh/id_ed25519",
  ])("detects SSH keys: %s", (path) => {
    expect(isSensitiveFile(path)).toBe(true);
  });

  test.each([
    "/home/user/.aws/credentials",
    "/home/user/.gcp/credentials",
    ".aws/credentials",
    ".gcp/credentials",
    "credentials",
  ])("detects cloud credentials: %s", (path) => {
    expect(isSensitiveFile(path)).toBe(true);
  });

  test.each([
    "app.py",
    "config.yml",
    "README.md",
    "package.json",
    "server.key.example",
    "id_rsa.pub",
    "credentials.json",
    ".envrc",
    "environment.py",
    ".env_example",
    ".env.example",
    ".env.sample",
    ".env.template",
    "/app/.env.example",
  ])("allows normal files: %s", (path) => {
    expect(isSensitiveFile(path)).toBe(false);
  });
});

describe("sensitiveFileWarning", () => {
  test("single file warning", () => {
    const warning = sensitiveFileWarning([".env"]);
    expect(warning).toContain("1 sensitive file(s)");
    expect(warning).toContain(".env");
    expect(warning).toContain("protect secrets");
  });

  test("multiple file warning", () => {
    const warning = sensitiveFileWarning([".env", ".env.local", "id_rsa"]);
    expect(warning).toContain("3 sensitive file(s)");
    expect(warning).toContain(".env");
    expect(warning).toContain("id_rsa");
  });
});
