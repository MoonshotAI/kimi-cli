/**
 * Tests for config.ts — configuration loading and validation.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import {
  Config,
  ConfigError,
  getDefaultConfig,
  loadConfig,
  loadConfigFromString,
  saveConfig,
  LoopControl,
  HookDef,
  LLMModel,
  LLMProvider as LLMProviderSchema,
} from "../../src/kimi_cli_ts/config.ts";
import { createTempDir, removeTempDir } from "../conftest.ts";

describe("Config", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  // ── Default config ───────────────────────────────────

  test("getDefaultConfig returns valid config with defaults", () => {
    const cfg = getDefaultConfig();
    expect(cfg.default_model).toBe("");
    expect(cfg.default_thinking).toBe(false);
    expect(cfg.default_yolo).toBe(false);
    expect(cfg.theme).toBe("dark");
    // Zod fills in nested object defaults
    expect(cfg.loop_control.max_steps_per_turn).toBe(100);
    expect(cfg.loop_control.compaction_trigger_ratio).toBe(0.85);
    expect(cfg.background.max_running_tasks).toBe(4);
    expect(cfg.hooks).toEqual([]);
  });

  // ── Zod schema validation ────────────────────────────

  test("Config.parse with empty object returns defaults", () => {
    const cfg = Config.parse({});
    expect(cfg.default_model).toBe("");
    expect(cfg.loop_control.max_steps_per_turn).toBe(100);
  });

  test("Config.parse rejects invalid compaction_trigger_ratio", () => {
    expect(() =>
      Config.parse({
        loop_control: { compaction_trigger_ratio: 1.5 },
      }),
    ).toThrow();
  });

  test("Config.parse rejects default_model not in models", () => {
    expect(() =>
      Config.parse({
        default_model: "nonexistent",
        models: {},
      }),
    ).toThrow();
  });

  test("Config.parse rejects model with unknown provider", () => {
    expect(() =>
      Config.parse({
        models: {
          m1: { provider: "p1", model: "test", max_context_size: 1000 },
        },
        providers: {},
      }),
    ).toThrow();
  });

  test("Config.parse accepts valid model/provider pair", () => {
    const cfg = Config.parse({
      default_model: "m1",
      models: {
        m1: { provider: "p1", model: "test-model", max_context_size: 100000 },
      },
      providers: {
        p1: { type: "kimi", base_url: "https://api.example.com", api_key: "key" },
      },
    });
    expect(cfg.default_model).toBe("m1");
    expect(cfg.models.m1.model).toBe("test-model");
  });

  // ── LoopControl defaults ─────────────────────────────

  test("LoopControl schema fills defaults", () => {
    const lc = LoopControl.parse({});
    expect(lc.max_steps_per_turn).toBe(100);
    expect(lc.max_retries_per_step).toBe(3);
    expect(lc.reserved_context_size).toBe(50_000);
    expect(lc.compaction_trigger_ratio).toBe(0.85);
  });

  // ── HookDef schema ──────────────────────────────────

  test("HookDef schema parses with defaults", () => {
    const hook = HookDef.parse({ event: "PreToolUse", command: "echo hi" });
    expect(hook.event).toBe("PreToolUse");
    expect(hook.command).toBe("echo hi");
    expect(hook.matcher).toBe("");
    expect(hook.timeout).toBe(30);
  });

  test("HookDef rejects unknown event type", () => {
    expect(() =>
      HookDef.parse({ event: "BadEvent", command: "echo" }),
    ).toThrow();
  });

  // ── loadConfig / saveConfig ──────────────────────────

  test("loadConfig creates default when file missing", async () => {
    const configPath = join(tempDir, "config.toml");
    const { config, meta } = await loadConfig(configPath);
    expect(config.default_model).toBe("");
    expect(meta.sourceFile).toBe(configPath);
    // Should have written the file
    const exists = await Bun.file(configPath).exists();
    expect(exists).toBe(true);
  });

  test("saveConfig and loadConfig roundtrip", async () => {
    const configPath = join(tempDir, "roundtrip.toml");
    const original = getDefaultConfig();
    await saveConfig(original, configPath);
    const { config } = await loadConfig(configPath);
    expect(config.default_yolo).toBe(original.default_yolo);
    expect(config.default_model).toBe(original.default_model);
  });

  // ── loadConfigFromString ─────────────────────────────

  test("loadConfigFromString parses JSON", async () => {
    const { config } = await loadConfigFromString(
      JSON.stringify({ default_yolo: true }),
    );
    expect(config.default_yolo).toBe(true);
  });

  test("loadConfigFromString rejects empty text", async () => {
    await expect(loadConfigFromString("")).rejects.toThrow(ConfigError);
  });

  test("loadConfigFromString rejects invalid TOML/JSON", async () => {
    await expect(loadConfigFromString("{{{bad")).rejects.toThrow(ConfigError);
  });

  // ── Environment variable override ────────────────────

  test("KIMI_MODEL_NAME env var overrides default_model in loadConfig", async () => {
    const configPath = join(tempDir, "env.toml");
    await saveConfig(getDefaultConfig(), configPath);
    const origEnv = process.env.KIMI_MODEL_NAME;
    try {
      process.env.KIMI_MODEL_NAME = "env-model";
      const { config } = await loadConfig(configPath);
      expect(config.default_model).toBe("env-model");
    } finally {
      if (origEnv === undefined) {
        delete process.env.KIMI_MODEL_NAME;
      } else {
        process.env.KIMI_MODEL_NAME = origEnv;
      }
    }
  });
});
