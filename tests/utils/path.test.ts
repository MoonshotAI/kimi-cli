/**
 * Tests for utils/path.ts — path utilities.
 */
import { test, expect, describe } from "bun:test";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import {
  expandHome,
  resolvePath,
  shortPath,
  isInsideDir,
} from "../../src/kimi_cli_ts/utils/path.ts";

describe("expandHome", () => {
  test("expands ~ to home directory", () => {
    const result = expandHome("~/Documents");
    expect(result).toBe(join(homedir(), "Documents"));
  });

  test("expands lone ~", () => {
    const result = expandHome("~");
    expect(result).toBe(homedir());
  });

  test("does not expand paths without ~", () => {
    const result = expandHome("/usr/local");
    expect(result).toBe("/usr/local");
  });

  test("does not expand ~ in the middle", () => {
    const result = expandHome("/home/~user");
    expect(result).toBe("/home/~user");
  });
});

describe("resolvePath", () => {
  test("resolves relative path from base", () => {
    const result = resolvePath("/base", "sub/file.txt");
    expect(result).toBe(resolve("/base", "sub/file.txt"));
  });

  test("resolves absolute path ignoring base", () => {
    const result = resolvePath("/base", "/absolute/path");
    expect(result).toBe("/absolute/path");
  });

  test("resolves ~ path", () => {
    const result = resolvePath("/base", "~/file.txt");
    expect(result).toBe(resolve(join(homedir(), "file.txt")));
  });
});

describe("shortPath", () => {
  test("returns relative path when shorter", () => {
    const base = "/Users/test/projects/myapp";
    const p = "/Users/test/projects/myapp/src/index.ts";
    const result = shortPath(base, p);
    expect(result).toBe("src/index.ts");
  });

  test("returns absolute path when relative is longer", () => {
    const base = "/a";
    const p = "/b";
    const result = shortPath(base, p);
    // "../b" is longer than "/b"
    expect(result).toBe("/b");
  });
});

describe("isInsideDir", () => {
  test("file inside directory", () => {
    expect(isInsideDir("/home/user", "/home/user/file.txt")).toBe(true);
  });

  test("deeply nested file", () => {
    expect(isInsideDir("/home/user", "/home/user/a/b/c.txt")).toBe(true);
  });

  test("directory itself counts as inside", () => {
    expect(isInsideDir("/home/user", "/home/user")).toBe(true);
  });

  test("sibling directory is not inside", () => {
    expect(isInsideDir("/home/user", "/home/other/file.txt")).toBe(false);
  });

  test("parent directory is not inside", () => {
    expect(isInsideDir("/home/user/sub", "/home/user")).toBe(false);
  });

  test("path prefix that is not a directory boundary", () => {
    // /home/username should NOT be inside /home/user
    expect(isInsideDir("/home/user", "/home/username")).toBe(false);
  });
});
