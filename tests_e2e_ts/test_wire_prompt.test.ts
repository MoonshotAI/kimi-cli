/**
 * Wire prompt E2E tests — corresponds to Python tests_e2e/test_wire_prompt.py
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  buildSetTodoCall,
  buildShellToolCall,
  buildApprovalResponse,
  cleanupTmpDir,
  collectUntilRequest,
  collectUntilResponse,
  makeTmpDir,
  makeHomeDir,
  makeWorkDir,
  normalizeResponse,
  readResponse,
  resetPathReplacements,
  sendInitialize,
  startWire,
  summarizeMessages,
  writeScriptedConfig,
} from "./wire_helpers";

function findEvent(
  messages: Array<Record<string, unknown>>,
  eventType: string,
): Record<string, unknown> {
  for (const msg of messages) {
    if (msg.method !== "event") continue;
    const params = msg.params as Record<string, unknown> | undefined;
    if (params?.type === eventType) return params;
  }
  throw new Error(`Missing event ${eventType}`);
}

describe("wire prompt", () => {
  let tmpPath: string;

  beforeAll(() => {
    resetPathReplacements();
    tmpPath = makeTmpDir();
  });

  afterAll(() => {
    cleanupTmpDir(tmpPath);
  });

  it("test_basic_prompt_events", async () => {
    const script = [
      "id: scripted-1",
      'usage: {"input_other": 5, "output": 2}',
      "text: Hello wire",
    ].join("\n");
    const configPath = writeScriptedConfig(tmpPath, [script]);
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);

    const wire = startWire({ configPath, workDir, homeDir, yolo: true });
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
      expect(summarizeMessages(messages)).toEqual([
        {
          method: "event",
          type: "TurnBegin",
          payload: { user_input: "hi" },
        },
        { method: "event", type: "StepBegin", payload: { n: 1 } },
        {
          method: "event",
          type: "ContentPart",
          payload: { type: "text", text: "Hello wire" },
        },
        {
          method: "event",
          type: "StatusUpdate",
          payload: {
            context_usage: 5e-5,
            context_tokens: 5,
            max_context_tokens: 100000,
            token_usage: {
              input_other: 5,
              output: 2,
              input_cache_read: 0,
              input_cache_creation: 0,
            },
            message_id: "scripted-1",
            plan_mode: false,
            mcp_status: null,
          },
        },
        { method: "event", type: "TurnEnd", payload: {} },
      ]);
    } finally {
      await wire.close();
    }
  });

  it("test_multiline_prompt", async () => {
    const configPath = writeScriptedConfig(tmpPath, ["text: ok"]);
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);

    const wire = startWire({ configPath, workDir, homeDir, yolo: true });
    try {
      await sendInitialize(wire);
      const userInput = "line1\nline2";
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "prompt-1",
        method: "prompt",
        params: { user_input: userInput },
      });
      const [resp, messages] = await collectUntilResponse(wire, "prompt-1");
      expect((resp.result as Record<string, unknown>)?.status).toBe("finished");
      const turnBegin = findEvent(messages, "TurnBegin");
      const payload = turnBegin.payload as Record<string, unknown>;
      expect(payload.user_input).toBe(userInput);
    } finally {
      await wire.close();
    }
  });

  it("test_content_part_prompt", async () => {
    const configPath = writeScriptedConfig(tmpPath, ["text: ok"], {
      capabilities: ["image_in", "video_in"],
    });
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);

    const contentParts = [
      { type: "text", text: "hello" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
      { type: "audio_url", audio_url: { url: "data:audio/aac;base64,AAA" } },
      { type: "video_url", video_url: { url: "data:video/mp4;base64,AAA" } },
    ];

    const wire = startWire({ configPath, workDir, homeDir, yolo: true });
    try {
      await sendInitialize(wire);
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "prompt-1",
        method: "prompt",
        params: { user_input: contentParts },
      });
      const [resp, messages] = await collectUntilResponse(wire, "prompt-1");
      expect((resp.result as Record<string, unknown>)?.status).toBe("finished");
      const turnBegin = findEvent(messages, "TurnBegin");
      const payload = turnBegin.payload as Record<string, unknown>;
      const ui = payload.user_input as Array<Record<string, unknown>>;
      expect(ui).toBeInstanceOf(Array);
      expect(ui[0]).toEqual({ type: "text", text: "hello" });
      // image_url, audio_url, video_url should have id: null added
      expect(ui[1]).toEqual({
        type: "image_url",
        image_url: { url: "data:image/png;base64,AAA", id: null },
      });
      expect(ui[2]).toEqual({
        type: "audio_url",
        audio_url: { url: "data:audio/aac;base64,AAA", id: null },
      });
      expect(ui[3]).toEqual({
        type: "video_url",
        video_url: { url: "data:video/mp4;base64,AAA", id: null },
      });
    } finally {
      await wire.close();
    }
  });

  it("test_max_steps_reached", async () => {
    const todoLine = buildSetTodoCall("tc-1", [
      { title: "x", status: "pending" },
    ]);
    const script = ["text: start", todoLine].join("\n");
    const configPath = writeScriptedConfig(tmpPath, [script]);
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);

    const wire = startWire({
      configPath,
      workDir,
      homeDir,
      extraArgs: ["--max-steps-per-turn", "1"],
      yolo: true,
    });
    try {
      await sendInitialize(wire);
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "prompt-1",
        method: "prompt",
        params: { user_input: "run" },
      });
      const [resp, messages] = await collectUntilResponse(wire, "prompt-1");
      expect((resp.result as Record<string, unknown>)?.status).toBe(
        "max_steps_reached",
      );
      expect(normalizeResponse(resp)).toEqual({
        result: { status: "max_steps_reached", steps: 1 },
      });
      expect(summarizeMessages(messages)).toEqual([
        {
          method: "event",
          type: "TurnBegin",
          payload: { user_input: "run" },
        },
        { method: "event", type: "StepBegin", payload: { n: 1 } },
        {
          method: "event",
          type: "ContentPart",
          payload: { type: "text", text: "start" },
        },
        {
          method: "event",
          type: "ToolCall",
          payload: {
            type: "function",
            id: "tc-1",
            function: {
              name: "SetTodoList",
              arguments: '{"todos":[{"title":"x","status":"pending"}]}',
            },
            extras: null,
          },
        },
        {
          method: "event",
          type: "StatusUpdate",
          payload: {
            context_usage: null,
            context_tokens: null,
            max_context_tokens: null,
            token_usage: null,
            message_id: null,
            plan_mode: false,
            mcp_status: null,
          },
        },
        {
          method: "event",
          type: "ToolResult",
          payload: {
            tool_call_id: "tc-1",
            return_value: {
              is_error: false,
              output: "Todo list updated",
              message: "Todo list updated",
              display: [
                {
                  type: "todo",
                  items: [{ title: "x", status: "pending" }],
                },
              ],
              extras: null,
            },
          },
        },
        {
          method: "event",
          type: "TurnEnd",
          payload: {},
        },
      ]);
    } finally {
      await wire.close();
    }
  });

  it("test_status_update_fields", async () => {
    const script = [
      "id: scripted-1",
      'usage: {"input_other": 5, "output": 2}',
      "text: hello",
    ].join("\n");
    const configPath = writeScriptedConfig(tmpPath, [script]);
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);

    const wire = startWire({ configPath, workDir, homeDir, yolo: true });
    try {
      await sendInitialize(wire);
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "prompt-1",
        method: "prompt",
        params: { user_input: "hi" },
      });
      const [, messages] = await collectUntilResponse(wire, "prompt-1");
      const status = findEvent(messages, "StatusUpdate");
      const payload = status.payload as Record<string, unknown>;
      expect(typeof payload.token_usage).toBe("object");
      expect(status).toEqual({
        type: "StatusUpdate",
        payload: {
          context_usage: 5e-5,
          context_tokens: 5,
          max_context_tokens: 100000,
          token_usage: {
            input_other: 5,
            output: 2,
            input_cache_read: 0,
            input_cache_creation: 0,
          },
          message_id: "scripted-1",
          plan_mode: false,
          mcp_status: null,
        },
      });
    } finally {
      await wire.close();
    }
  });

  it("test_concurrent_prompt_error", async () => {
    const scripts = [
      ["text: step1", buildShellToolCall("tc-1", "echo hi")].join("\n"),
      "text: done",
    ];
    const configPath = writeScriptedConfig(tmpPath, scripts);
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);

    const wire = startWire({
      configPath,
      workDir,
      homeDir,
      yolo: false,
    });
    try {
      await sendInitialize(wire);
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "prompt-1",
        method: "prompt",
        params: { user_input: "run" },
      });
      const [requestMsg] = await collectUntilRequest(wire);

      // Send second prompt while first is blocked on approval
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "prompt-2",
        method: "prompt",
        params: { user_input: "second" },
      });
      const prompt2Resp = normalizeResponse(await readResponse(wire, "prompt-2"));
      expect(prompt2Resp).toEqual({
        error: {
          code: -32000,
          message: "An agent turn is already in progress",
          data: null,
        },
      });

      // Approve and finish
      await wire.sendJson(buildApprovalResponse(requestMsg, "approve"));
      const [prompt1Resp] = await collectUntilResponse(wire, "prompt-1");
      expect((prompt1Resp.result as Record<string, unknown>)?.status).toBe(
        "finished",
      );
    } finally {
      await wire.close();
    }
  });
});
