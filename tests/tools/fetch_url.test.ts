/**
 * Tests for FetchURL tool.
 * Corresponds to Python tests/tools/test_fetch_url.py
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { createTempDir, removeTempDir, createTestToolContext } from "../conftest.ts";
import { FetchURL } from "../../src/kimi_cli_ts/tools/web/fetch.ts";

let tempDir: string;
let tool: FetchURL;
let ctx: ReturnType<typeof createTestToolContext>;

beforeEach(() => {
  tempDir = createTempDir();
  tool = new FetchURL();
  ctx = createTestToolContext(tempDir);
});

afterEach(() => {
  removeTempDir(tempDir);
});

describe("FetchURL", () => {
  test("fetch from local HTTP server", async () => {
    // Start a simple local server using Bun.serve
    const server = Bun.serve({
      port: 0, // random port
      fetch() {
        return new Response("<html><body><h1>Hello Test</h1><p>Test content here.</p></body></html>", {
          headers: { "Content-Type": "text/html" },
        });
      },
    });

    try {
      const result = await tool.execute({ url: `http://localhost:${server.port}/` }, ctx);

      expect(result.isError).toBe(false);
      expect(result.output).toContain("Hello Test");
      expect(result.output).toContain("Test content");
    } finally {
      server.stop();
    }
  });

  test("fetch plain text content", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("# Title\n\nThis is plain markdown content.", {
          headers: { "Content-Type": "text/plain" },
        });
      },
    });

    try {
      const result = await tool.execute({ url: `http://localhost:${server.port}/` }, ctx);

      expect(result.isError).toBe(false);
      expect(result.output).toContain("# Title");
      expect(result.output).toContain("plain markdown content");
      expect(result.message).toContain("full content of the page");
    } finally {
      server.stop();
    }
  });

  test("fetch markdown content", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("# Markdown\n\nHello world.", {
          headers: { "Content-Type": "text/markdown; charset=utf-8" },
        });
      },
    });

    try {
      const result = await tool.execute({ url: `http://localhost:${server.port}/` }, ctx);

      expect(result.isError).toBe(false);
      expect(result.output).toContain("# Markdown");
      expect(result.message).toContain("full content of the page");
    } finally {
      server.stop();
    }
  });

  test("fetch returns 404 error", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("Not Found", { status: 404 });
      },
    });

    try {
      const result = await tool.execute({ url: `http://localhost:${server.port}/` }, ctx);

      expect(result.isError).toBe(true);
      expect(result.message).toContain("Status: 404");
    } finally {
      server.stop();
    }
  });

  test("fetch invalid URL", async () => {
    const result = await tool.execute(
      { url: "https://this-domain-definitely-does-not-exist-12345.com/" },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.message).toContain("Failed to fetch URL");
  });

  test("fetch empty URL", async () => {
    const result = await tool.execute({ url: "" }, ctx);

    expect(result.isError).toBe(true);
  });

  test("fetch malformed URL", async () => {
    const result = await tool.execute({ url: "not-a-valid-url" }, ctx);

    expect(result.isError).toBe(true);
    expect(result.message).toContain("Failed to fetch URL");
  });

  test("toDefinition returns valid schema", () => {
    const def = tool.toDefinition();
    expect(def.name).toBe("FetchURL");
    expect(def.description).toBeTruthy();
    expect(def.parameters).toBeDefined();
  });
});
