/**
 * Wire error E2E tests — corresponds to Python tests_e2e/test_wire_errors.py
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  cleanupTmpDir,
  makeTmpDir,
  makeHomeDir,
  makeWorkDir,
  normalizeResponse,
  readResponse,
  resetPathReplacements,
  sendInitialize,
  startWire,
  writeScriptedConfig,
  WireProcess,
} from "./wire_helpers";

describe("wire errors", () => {
  let tmpPath: string;

  beforeAll(() => {
    resetPathReplacements();
    tmpPath = makeTmpDir();
  });

  afterAll(() => {
    cleanupTmpDir(tmpPath);
  });

  it("test_invalid_json_request", async () => {
    const configPath = writeScriptedConfig(tmpPath, ["text: hello"]);
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);

    const wire = startWire({
      configPath,
      workDir,
      homeDir,
      yolo: true,
    });
    try {
      await sendInitialize(wire);
      await wire.sendRaw("{not-json}");
      const resp = await wire.readJson();
      const normalized = normalizeResponse(resp);
      expect((normalized.error as Record<string, unknown>)?.code).toBe(-32700);
      expect((normalized.error as Record<string, unknown>)?.message).toBe(
        "Invalid JSON format",
      );
    } finally {
      await wire.close();
    }
  });

  it("test_invalid_request", async () => {
    const configPath = writeScriptedConfig(tmpPath, ["text: hello"]);
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);

    const wire = startWire({
      configPath,
      workDir,
      homeDir,
      yolo: true,
    });
    try {
      await sendInitialize(wire);
      await wire.sendJson({
        jsonrpc: "2.1",
        id: "bad-1",
        method: "prompt",
        params: { user_input: "hi" },
      });
      const resp = normalizeResponse(await wire.readJson());
      expect((resp.error as Record<string, unknown>)?.code).toBe(-32600);
      expect((resp.error as Record<string, unknown>)?.message).toBe(
        "Invalid request",
      );
    } finally {
      await wire.close();
    }
  });

  it("test_unknown_method", async () => {
    const configPath = writeScriptedConfig(tmpPath, ["text: hello"]);
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);

    const wire = startWire({
      configPath,
      workDir,
      homeDir,
      yolo: true,
    });
    try {
      await sendInitialize(wire);
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "unk-1",
        method: "nope",
        params: {},
      });
      const resp = normalizeResponse(await readResponse(wire, "unk-1"));
      expect((resp.error as Record<string, unknown>)?.code).toBe(-32601);
      expect((resp.error as Record<string, unknown>)?.message).toBe(
        "Unexpected method received: nope",
      );
    } finally {
      await wire.close();
    }
  });

  it("test_invalid_params", async () => {
    const configPath = writeScriptedConfig(tmpPath, ["text: hello"]);
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);

    const wire = startWire({
      configPath,
      workDir,
      homeDir,
      yolo: true,
    });
    try {
      await sendInitialize(wire);
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "inv-1",
        method: "prompt",
        params: {},
      });
      const resp = normalizeResponse(await readResponse(wire, "inv-1"));
      expect((resp.error as Record<string, unknown>)?.code).toBe(-32602);
      expect((resp.error as Record<string, unknown>)?.message).toBe(
        "Invalid parameters for method `prompt`",
      );
    } finally {
      await wire.close();
    }
  });

  it("test_cancel_without_prompt", async () => {
    const configPath = writeScriptedConfig(tmpPath, ["text: hello"]);
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);

    const wire = startWire({
      configPath,
      workDir,
      homeDir,
      yolo: true,
    });
    try {
      await sendInitialize(wire);
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "cancel-1",
        method: "cancel",
        params: {},
      });
      const resp = normalizeResponse(await readResponse(wire, "cancel-1"));
      expect((resp.error as Record<string, unknown>)?.code).toBe(-32000);
      expect((resp.error as Record<string, unknown>)?.message).toBe(
        "No agent turn is in progress",
      );
    } finally {
      await wire.close();
    }
  });

  it("test_llm_not_supported", async () => {
    const configPath = writeScriptedConfig(tmpPath, ["text: hello"], {
      capabilities: [],
    });
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);

    const wire = startWire({
      configPath,
      workDir,
      homeDir,
      yolo: true,
    });
    try {
      await sendInitialize(wire);
      const contentParts = [
        { type: "text", text: "hello" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
      ];
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "prompt-1",
        method: "prompt",
        params: { user_input: contentParts },
      });
      const resp = normalizeResponse(await readResponse(wire, "prompt-1"));
      expect((resp.error as Record<string, unknown>)?.code).toBe(-32002);
    } finally {
      await wire.close();
    }
  });

  it("test_llm_not_set", async () => {
    const configPath = writeScriptedConfig(tmpPath, ["text: hello"], {
      modelName: "empty",
      providerName: "kimi_provider",
    });
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);

    // Override config to have kimi provider with empty model
    const configData = {
      default_model: "empty",
      models: {
        empty: {
          provider: "kimi_provider",
          model: "",
          max_context_size: 100000,
        },
      },
      providers: {
        kimi_provider: {
          type: "kimi",
          base_url: "",
          api_key: "",
        },
      },
    };
    const fs = await import("node:fs");
    const configFilePath = configPath;
    fs.writeFileSync(configFilePath, JSON.stringify(configData), "utf-8");

    const wire = startWire({
      configPath: configFilePath,
      workDir,
      homeDir,
      yolo: true,
    });
    try {
      await sendInitialize(wire);
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "prompt-1",
        method: "prompt",
        params: { user_input: "hi" },
      });
      const resp = normalizeResponse(await readResponse(wire, "prompt-1"));
      expect((resp.error as Record<string, unknown>)?.code).toBe(-32001);
      expect((resp.error as Record<string, unknown>)?.message).toBe(
        "LLM is not set",
      );
    } finally {
      await wire.close();
    }
  });

  it("test_llm_provider_error", async () => {
    const configPath = writeScriptedConfig(tmpPath, [
      "bad line without colon",
    ]);
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);

    const wire = startWire({
      configPath,
      workDir,
      homeDir,
      yolo: true,
    });
    try {
      await sendInitialize(wire);
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "prompt-1",
        method: "prompt",
        params: { user_input: "hi" },
      });
      const resp = normalizeResponse(await readResponse(wire, "prompt-1"));
      expect((resp.error as Record<string, unknown>)?.code).toBe(-32003);
      expect((resp.error as Record<string, unknown>)?.message).toBe(
        "Invalid echo DSL at line 1: 'bad line without colon'",
      );
    } finally {
      await wire.close();
    }
  });
});
