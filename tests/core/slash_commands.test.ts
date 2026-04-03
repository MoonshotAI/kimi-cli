/**
 * Tests for soul/slash.ts — slash command registry.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import {
  SlashCommandRegistry,
  createDefaultRegistry,
} from "../../src/kimi_cli_ts/soul/slash.ts";

describe("SlashCommandRegistry", () => {
  let registry: SlashCommandRegistry;
  let executedArgs: string[];

  beforeEach(() => {
    registry = new SlashCommandRegistry();
    executedArgs = [];
  });

  test("register and get command", () => {
    registry.register({
      name: "test",
      description: "A test command",
      handler: async () => {},
    });
    expect(registry.get("test")).toBeDefined();
    expect(registry.get("test")!.name).toBe("test");
  });

  test("has returns true for registered command", () => {
    registry.register({
      name: "test",
      description: "Test",
      handler: async () => {},
    });
    expect(registry.has("test")).toBe(true);
    expect(registry.has("nonexistent")).toBe(false);
  });

  test("aliases resolve to original command", () => {
    registry.register({
      name: "test",
      description: "Test",
      aliases: ["t", "tst"],
      handler: async () => {},
    });
    expect(registry.has("t")).toBe(true);
    expect(registry.has("tst")).toBe(true);
    expect(registry.get("t")!.name).toBe("test");
    expect(registry.get("tst")!.name).toBe("test");
  });

  test("list returns all registered commands", () => {
    registry.register({ name: "a", description: "A", handler: async () => {} });
    registry.register({ name: "b", description: "B", handler: async () => {} });
    const cmds = registry.list();
    expect(cmds.length).toBe(2);
    expect(cmds.map((c) => c.name).sort()).toEqual(["a", "b"]);
  });

  test("execute dispatches to handler", async () => {
    registry.register({
      name: "greet",
      description: "Greet",
      handler: async (args) => {
        executedArgs.push(args);
      },
    });

    const result = await registry.execute("/greet world");
    expect(result).toBe(true);
    expect(executedArgs).toEqual(["world"]);
  });

  test("execute with no args passes empty string", async () => {
    registry.register({
      name: "ping",
      description: "Ping",
      handler: async (args) => {
        executedArgs.push(args);
      },
    });

    await registry.execute("/ping");
    expect(executedArgs).toEqual([""]);
  });

  test("execute returns false for unknown command", async () => {
    const result = await registry.execute("/unknown");
    expect(result).toBe(false);
  });

  test("execute returns false for non-slash input", async () => {
    const result = await registry.execute("hello");
    expect(result).toBe(false);
  });

  test("execute resolves alias", async () => {
    registry.register({
      name: "help",
      description: "Help",
      aliases: ["?"],
      handler: async (args) => {
        executedArgs.push(args);
      },
    });

    const result = await registry.execute("/?");
    expect(result).toBe(true);
    expect(executedArgs.length).toBe(1);
  });
});

describe("createDefaultRegistry", () => {
  test("contains built-in commands", () => {
    const reg = createDefaultRegistry();
    expect(reg.has("clear")).toBe(true);
    expect(reg.has("compact")).toBe(true);
    expect(reg.has("yolo")).toBe(true);
    expect(reg.has("plan")).toBe(true);
    expect(reg.has("model")).toBe(true);
    expect(reg.has("help")).toBe(true);
    expect(reg.has("init")).toBe(true);
    expect(reg.has("add-dir")).toBe(true);
  });

  test("yolo has auto-approve alias", () => {
    const reg = createDefaultRegistry();
    expect(reg.has("auto-approve")).toBe(true);
    expect(reg.get("auto-approve")!.name).toBe("yolo");
  });

  test("help has ? alias", () => {
    const reg = createDefaultRegistry();
    expect(reg.has("?")).toBe(true);
    expect(reg.get("?")!.name).toBe("help");
  });
});
