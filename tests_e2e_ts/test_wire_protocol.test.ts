/**
 * Wire protocol E2E tests — corresponds to Python tests_e2e/test_wire_protocol.py
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  buildToolResultResponse,
  cleanupTmpDir,
  collectUntilResponse,
  makeTmpDir,
  makeHomeDir,
  makeWorkDir,
  normalizeResponse,
  resetPathReplacements,
  sendInitialize,
  startWire,
  summarizeMessages,
  writeScriptedConfig,
} from "./wire_helpers";

describe("wire protocol", () => {
  let tmpPath: string;

  beforeAll(() => {
    resetPathReplacements();
    tmpPath = makeTmpDir();
  });

  afterAll(() => {
    cleanupTmpDir(tmpPath);
  });

  it("test_initialize_handshake", async () => {
    const configPath = writeScriptedConfig(tmpPath, ["text: hello"]);
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);

    const wire = startWire({ configPath, workDir, homeDir, yolo: true });
    try {
      const resp = await sendInitialize(wire);
      const normalized = normalizeResponse(resp);
      const result = normalized.result as Record<string, unknown>;
      expect(result.protocol_version).toBe("1.8");

      const server = result.server as Record<string, unknown>;
      expect(server.name).toBe("Kimi Code CLI");
      expect(server.version).toBe("<VERSION>");

      // Check slash_commands
      const slashCommands = result.slash_commands as Array<Record<string, unknown>>;
      expect(slashCommands).toBeInstanceOf(Array);
      const commandNames = slashCommands.map((c) => c.name);
      expect(commandNames).toContain("init");
      expect(commandNames).toContain("compact");
      expect(commandNames).toContain("clear");
      expect(commandNames).toContain("yolo");
      expect(commandNames).toContain("plan");

      // Check hooks
      const hooks = result.hooks as Record<string, unknown>;
      expect(hooks).toBeDefined();
      const supportedEvents = hooks.supported_events as string[];
      expect(supportedEvents).toBeInstanceOf(Array);
      expect(supportedEvents.length).toBeGreaterThanOrEqual(10);

      // Check capabilities
      const capabilities = result.capabilities as Record<string, unknown>;
      expect(capabilities).toBeDefined();
      expect(capabilities.supports_question).toBe(true);
    } finally {
      await wire.close();
    }
  });

  it("test_initialize_external_tool_conflict", async () => {
    const configPath = writeScriptedConfig(tmpPath, ["text: hello"]);
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);

    const wire = startWire({ configPath, workDir, homeDir, yolo: true });
    try {
      const resp = await sendInitialize(wire, {
        externalTools: [
          {
            name: "Shell",
            description: "conflicting shell",
            input_schema: { type: "object", properties: {} },
          },
        ],
      });
      const normalized = normalizeResponse(resp);
      const result = normalized.result as Record<string, unknown>;
      const rejected = result.rejected_tools as Array<Record<string, unknown>>;
      expect(rejected).toBeInstanceOf(Array);
      expect(rejected.length).toBeGreaterThanOrEqual(1);
      const shellRejected = rejected.find((t) => t.name === "Shell");
      expect(shellRejected).toBeDefined();
      expect(shellRejected!.reason).toBe("conflicts with builtin tool");
    } finally {
      await wire.close();
    }
  });

  it("test_external_tool_call", async () => {
    const toolArgs = JSON.stringify({ query: "test" });
    const toolCall = JSON.stringify({
      id: "tc-ext-1",
      name: "MyExtTool",
      arguments: toolArgs,
    });
    const scripts = [
      ["text: calling ext", `tool_call: ${toolCall}`].join("\n"),
      "text: got result",
    ];
    const configPath = writeScriptedConfig(tmpPath, scripts);
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);

    const wire = startWire({ configPath, workDir, homeDir, yolo: true });
    try {
      await sendInitialize(wire, {
        externalTools: [
          {
            name: "MyExtTool",
            description: "an external tool",
            input_schema: {
              type: "object",
              properties: { query: { type: "string" } },
            },
          },
        ],
      });
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "prompt-1",
        method: "prompt",
        params: { user_input: "use ext tool" },
      });

      const requestHandler = (msg: Record<string, unknown>) => {
        const params = msg.params as Record<string, unknown> | undefined;
        if (params?.type === "ToolCallRequest") {
          return buildToolResultResponse(msg, { output: "ext result" });
        }
        // Default: should not happen
        return buildToolResultResponse(msg, { output: "unknown", isError: true });
      };

      const [resp, messages] = await collectUntilResponse(wire, "prompt-1", {
        requestHandler,
      });
      expect((resp.result as Record<string, unknown>)?.status).toBe("finished");
      const summary = summarizeMessages(messages);
      const toolResult = summary.find((m) => m.type === "ToolResult");
      expect(toolResult).toBeDefined();
    } finally {
      await wire.close();
    }
  });

  it("test_prompt_without_initialize", async () => {
    const configPath = writeScriptedConfig(tmpPath, ["text: no init"]);
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);

    const wire = startWire({ configPath, workDir, homeDir, yolo: true });
    try {
      // Send prompt without initialize
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
        (contentPart?.payload as Record<string, unknown>)?.text,
      ).toBe("no init");
    } finally {
      await wire.close();
    }
  });
});
