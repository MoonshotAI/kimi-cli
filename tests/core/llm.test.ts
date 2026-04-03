/**
 * Tests for llm.ts — LLM abstraction layer.
 */
import { test, expect, describe } from "bun:test";
import {
  LLM,
  createLLM,
  estimateTokenCount,
  estimateMessagesTokenCount,
  deriveModelCapabilities,
  modelDisplayName,
  augmentProviderWithEnvVars,
  type LLMProviderConfig,
  type LLMModelConfig,
} from "../../src/kimi_cli_ts/llm.ts";
import { createMockLLM } from "../conftest.ts";

describe("estimateTokenCount", () => {
  test("estimates ~4 chars per token", () => {
    expect(estimateTokenCount("abcd")).toBe(1);
    expect(estimateTokenCount("abcdefgh")).toBe(2);
    expect(estimateTokenCount("a")).toBe(1); // ceil(1/4)
  });

  test("empty string is 0 tokens", () => {
    expect(estimateTokenCount("")).toBe(0);
  });
});

describe("estimateMessagesTokenCount", () => {
  test("estimates tokens for string messages", () => {
    const count = estimateMessagesTokenCount([
      { role: "user", content: "hello world" }, // ~3 + 4 overhead
    ]);
    expect(count).toBeGreaterThan(0);
  });

  test("estimates tokens for content part messages", () => {
    const count = estimateMessagesTokenCount([
      {
        role: "user",
        content: [{ type: "text" as const, text: "hello world" }],
      },
    ]);
    expect(count).toBeGreaterThan(0);
  });

  test("empty messages array returns 0", () => {
    expect(estimateMessagesTokenCount([])).toBe(0);
  });
});

describe("deriveModelCapabilities", () => {
  test("model with thinking in name gets thinking capabilities", () => {
    const caps = deriveModelCapabilities({
      model: "gpt-4-thinking",
      provider: "openai",
      maxContextSize: 128000,
    });
    expect(caps.has("thinking")).toBe(true);
    expect(caps.has("always_thinking")).toBe(true);
  });

  test("model with reason in name gets thinking capabilities", () => {
    const caps = deriveModelCapabilities({
      model: "deepseek-reasoner",
      provider: "openai",
      maxContextSize: 128000,
    });
    expect(caps.has("thinking")).toBe(true);
  });

  test("kimi-for-coding gets image, video, thinking", () => {
    const caps = deriveModelCapabilities({
      model: "kimi-for-coding",
      provider: "kimi",
      maxContextSize: 200000,
    });
    expect(caps.has("thinking")).toBe(true);
    expect(caps.has("image_in")).toBe(true);
    expect(caps.has("video_in")).toBe(true);
  });

  test("explicit capabilities are preserved", () => {
    const caps = deriveModelCapabilities({
      model: "generic-model",
      provider: "openai",
      maxContextSize: 128000,
      capabilities: ["image_in"],
    });
    expect(caps.has("image_in")).toBe(true);
    expect(caps.has("thinking")).toBe(false);
  });
});

describe("modelDisplayName", () => {
  test("null returns empty string", () => {
    expect(modelDisplayName(null)).toBe("");
  });

  test("kimi-for-coding gets powered by suffix", () => {
    expect(modelDisplayName("kimi-for-coding")).toContain("kimi-k2.5");
  });

  test("regular model name returned as-is", () => {
    expect(modelDisplayName("gpt-4")).toBe("gpt-4");
  });
});

describe("createLLM", () => {
  test("returns null for empty base_url", () => {
    const result = createLLM(
      { type: "kimi", baseUrl: "", apiKey: "key" },
      { model: "test", provider: "p", maxContextSize: 100000 },
    );
    expect(result).toBeNull();
  });

  test("returns null for empty model name", () => {
    const result = createLLM(
      { type: "kimi", baseUrl: "https://api.example.com", apiKey: "key" },
      { model: "", provider: "p", maxContextSize: 100000 },
    );
    expect(result).toBeNull();
  });

  test("creates LLM with valid config", () => {
    const llm = createLLM(
      { type: "kimi", baseUrl: "https://api.example.com", apiKey: "key" },
      { model: "kimi-for-coding", provider: "p", maxContextSize: 200000 },
    );
    expect(llm).not.toBeNull();
    expect(llm!.modelName).toBe("kimi-for-coding");
    expect(llm!.maxContextSize).toBe(200000);
    expect(llm!.hasCapability("thinking")).toBe(true);
  });

  test("_echo provider type allows empty base_url", () => {
    const llm = createLLM(
      { type: "_echo", baseUrl: "", apiKey: "" },
      { model: "echo", provider: "p", maxContextSize: 100000 },
    );
    expect(llm).not.toBeNull();
  });
});

describe("LLM class", () => {
  test("hasCapability checks capability set", () => {
    const { llm } = createMockLLM([], { capabilities: ["image_in", "thinking"] });
    expect(llm.hasCapability("image_in")).toBe(true);
    expect(llm.hasCapability("thinking")).toBe(true);
    expect(llm.hasCapability("video_in")).toBe(false);
  });

  test("modelName delegates to provider", () => {
    const { llm } = createMockLLM();
    expect(llm.modelName).toBe("mock-model");
  });
});

describe("augmentProviderWithEnvVars", () => {
  test("KIMI env vars override provider settings", () => {
    const origKey = process.env.KIMI_API_KEY;
    const origUrl = process.env.KIMI_BASE_URL;
    try {
      process.env.KIMI_API_KEY = "test-key";
      process.env.KIMI_BASE_URL = "https://override.example.com";

      const provider: LLMProviderConfig = {
        type: "kimi",
        baseUrl: "https://original.example.com",
        apiKey: "original-key",
      };
      const model: LLMModelConfig = {
        model: "test",
        provider: "p",
        maxContextSize: 100000,
      };

      const applied = augmentProviderWithEnvVars(provider, model);
      expect(provider.baseUrl).toBe("https://override.example.com");
      expect(provider.apiKey).toBe("test-key");
      expect(applied).toHaveProperty("KIMI_API_KEY");
      expect(applied).toHaveProperty("KIMI_BASE_URL");
    } finally {
      if (origKey === undefined) delete process.env.KIMI_API_KEY;
      else process.env.KIMI_API_KEY = origKey;
      if (origUrl === undefined) delete process.env.KIMI_BASE_URL;
      else process.env.KIMI_BASE_URL = origUrl;
    }
  });
});
