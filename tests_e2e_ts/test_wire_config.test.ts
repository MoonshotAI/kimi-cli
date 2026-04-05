/**
 * Wire config E2E tests — corresponds to Python tests_e2e/test_wire_config.py
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  cleanupTmpDir,
  collectUntilResponse,
  makeTmpDir,
  makeHomeDir,
  makeWorkDir,
  resetPathReplacements,
  sendInitialize,
  startWire,
  summarizeMessages,
  writeScriptedConfig,
  writeScriptsFile,
} from "./wire_helpers";

describe("wire config", () => {
  let tmpPath: string;

  beforeAll(() => {
    resetPathReplacements();
    tmpPath = makeTmpDir();
  });

  afterAll(() => {
    cleanupTmpDir(tmpPath);
  });

  it("test_config_string", async () => {
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);
    const scriptsPath = writeScriptsFile(tmpPath, ["text: from config string"]);

    const configText = JSON.stringify({
      default_model: "scripted",
      models: {
        scripted: {
          provider: "sp",
          model: "scripted_echo",
          max_context_size: 100000,
        },
      },
      providers: {
        sp: {
          type: "_scripted_echo",
          base_url: "",
          api_key: "",
          env: { KIMI_SCRIPTED_ECHO_SCRIPTS: scriptsPath },
        },
      },
    });

    const wire = startWire({
      configText,
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
      const [resp, messages] = await collectUntilResponse(wire, "prompt-1");
      expect((resp.result as Record<string, unknown>)?.status).toBe("finished");
      const summary = summarizeMessages(messages);
      // Verify we get the expected text back
      const contentPart = summary.find((m) => m.type === "ContentPart");
      expect(
        ((contentPart?.payload as Record<string, unknown>)?.text),
      ).toBe("from config string");
    } finally {
      await wire.close();
    }
  });

  it("test_model_override", async () => {
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);

    // Create two script files for two different providers
    const scriptsPath1 = writeScriptsFile(
      tmpPath,
      ["text: from default"],
      "scripts_default.json",
    );
    const scriptsPath2 = writeScriptsFile(
      tmpPath,
      ["text: from override"],
      "scripts_override.json",
    );

    const configData = {
      default_model: "default_model",
      models: {
        default_model: {
          provider: "sp_default",
          model: "scripted_echo",
          max_context_size: 100000,
        },
        override_model: {
          provider: "sp_override",
          model: "scripted_echo",
          max_context_size: 100000,
        },
      },
      providers: {
        sp_default: {
          type: "_scripted_echo",
          base_url: "",
          api_key: "",
          env: { KIMI_SCRIPTED_ECHO_SCRIPTS: scriptsPath1 },
        },
        sp_override: {
          type: "_scripted_echo",
          base_url: "",
          api_key: "",
          env: { KIMI_SCRIPTED_ECHO_SCRIPTS: scriptsPath2 },
        },
      },
    };

    const fs = await import("node:fs");
    const path = await import("node:path");
    const configPath = path.join(tmpPath, "config_override.json");
    fs.writeFileSync(configPath, JSON.stringify(configData), "utf-8");

    const wire = startWire({
      configPath,
      workDir,
      homeDir,
      extraArgs: ["--model", "override_model"],
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
      const [resp, messages] = await collectUntilResponse(wire, "prompt-1");
      expect((resp.result as Record<string, unknown>)?.status).toBe("finished");
      const summary = summarizeMessages(messages);
      const contentPart = summary.find((m) => m.type === "ContentPart");
      expect(
        ((contentPart?.payload as Record<string, unknown>)?.text),
      ).toBe("from override");
    } finally {
      await wire.close();
    }
  });
});
