/**
 * Wire approvals & tools E2E tests — corresponds to Python tests_e2e/test_wire_approvals_tools.py
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildApprovalResponse,
  buildSetTodoCall,
  buildShellToolCall,
  cleanupTmpDir,
  collectUntilRequest,
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
import type { WireProcess } from "./wire_helpers";

function toolCallLine(
  toolCallId: string,
  name: string,
  args: Record<string, unknown>,
): string {
  const payload = {
    id: toolCallId,
    name,
    arguments: JSON.stringify(args),
  };
  return `tool_call: ${JSON.stringify(payload)}`;
}

function extractRequestPayload(
  messages: Array<Record<string, unknown>>,
): Record<string, unknown> {
  for (const msg of messages) {
    if (msg.method === "request") {
      const params = msg.params as Record<string, unknown> | undefined;
      return (params?.payload ?? {}) as Record<string, unknown>;
    }
  }
  throw new Error("No request found in messages");
}

function displayTypes(payload: Record<string, unknown>): string[] {
  const display = payload.display as Array<Record<string, unknown>> | undefined;
  if (!display) return [];
  return display.map((d) => d.type as string);
}

describe("wire approvals & tools", () => {
  let tmpPath: string;

  beforeAll(() => {
    resetPathReplacements();
    tmpPath = makeTmpDir();
  });

  afterAll(() => {
    cleanupTmpDir(tmpPath);
  });

  it("test_shell_approval_approve", async () => {
    const scripts = [
      ["text: running", buildShellToolCall("tc-1", "echo hi")].join("\n"),
      "text: done",
    ];
    const configPath = writeScriptedConfig(tmpPath, scripts);
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);

    const wire = startWire({ configPath, workDir, homeDir, yolo: false });
    try {
      await sendInitialize(wire);
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "prompt-1",
        method: "prompt",
        params: { user_input: "run" },
      });
      const [requestMsg, messagesBefore] = await collectUntilRequest(wire);
      await wire.sendJson(buildApprovalResponse(requestMsg, "approve"));
      const [resp, messagesAfter] = await collectUntilResponse(wire, "prompt-1");
      expect((resp.result as Record<string, unknown>)?.status).toBe("finished");

      const allMessages = [...messagesBefore, ...messagesAfter];
      const summary = summarizeMessages(allMessages);
      // Should have ApprovalResponse and ToolResult
      expect(summary.some((m) => m.type === "ApprovalResponse")).toBe(true);
      expect(summary.some((m) => m.type === "ToolResult")).toBe(true);
    } finally {
      await wire.close();
    }
  });

  it("test_shell_approval_reject", async () => {
    const scripts = [
      ["text: running", buildShellToolCall("tc-1", "echo hi")].join("\n"),
      "text: rejected",
    ];
    const configPath = writeScriptedConfig(tmpPath, scripts);
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);

    const wire = startWire({ configPath, workDir, homeDir, yolo: false });
    try {
      await sendInitialize(wire);
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "prompt-1",
        method: "prompt",
        params: { user_input: "run" },
      });
      const [requestMsg] = await collectUntilRequest(wire);
      await wire.sendJson(buildApprovalResponse(requestMsg, "reject"));
      const [resp, messagesAfter] = await collectUntilResponse(wire, "prompt-1");
      expect((resp.result as Record<string, unknown>)?.status).toBe("finished");

      const summary = summarizeMessages(messagesAfter);
      const toolResult = summary.find((m) => m.type === "ToolResult");
      expect(toolResult).toBeDefined();
      const rv = (toolResult!.payload as Record<string, unknown>)
        ?.return_value as Record<string, unknown>;
      expect(rv?.is_error).toBe(true);
    } finally {
      await wire.close();
    }
  });

  it("test_approve_for_session", async () => {
    const scripts = [
      ["text: first", buildShellToolCall("tc-1", "echo one")].join("\n"),
      "text: done1",
      ["text: second", buildShellToolCall("tc-2", "echo two")].join("\n"),
      "text: done2",
    ];
    const configPath = writeScriptedConfig(tmpPath, scripts);
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);

    const wire = startWire({ configPath, workDir, homeDir, yolo: false });
    try {
      await sendInitialize(wire);

      // First prompt - approve for session
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "prompt-1",
        method: "prompt",
        params: { user_input: "run first" },
      });
      const [requestMsg] = await collectUntilRequest(wire);
      await wire.sendJson(
        buildApprovalResponse(requestMsg, "approve_for_session"),
      );
      const [resp1] = await collectUntilResponse(wire, "prompt-1");
      expect((resp1.result as Record<string, unknown>)?.status).toBe("finished");

      // Second prompt - should auto-approve (no request)
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "prompt-2",
        method: "prompt",
        params: { user_input: "run second" },
      });
      const [resp2, messages2] = await collectUntilResponse(wire, "prompt-2");
      expect((resp2.result as Record<string, unknown>)?.status).toBe("finished");
      // No request messages expected
      const requests = messages2.filter((m) => m.method === "request");
      expect(requests.length).toBe(0);
    } finally {
      await wire.close();
    }
  });

  it("test_yolo_skips_approval", async () => {
    const scripts = [
      ["text: running", buildShellToolCall("tc-1", "echo hi")].join("\n"),
      "text: done",
    ];
    const configPath = writeScriptedConfig(tmpPath, scripts);
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);

    const wire = startWire({ configPath, workDir, homeDir, yolo: true });
    try {
      await sendInitialize(wire);
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "prompt-1",
        method: "prompt",
        params: { user_input: "run" },
      });
      const [resp, messages] = await collectUntilResponse(wire, "prompt-1");
      expect((resp.result as Record<string, unknown>)?.status).toBe("finished");
      const requests = messages.filter((m) => m.method === "request");
      expect(requests.length).toBe(0);
    } finally {
      await wire.close();
    }
  });

  it("test_display_block_shell", async () => {
    const scripts = [
      ["text: cmd", buildShellToolCall("tc-1", "echo hi")].join("\n"),
      "text: done",
    ];
    const configPath = writeScriptedConfig(tmpPath, scripts);
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);

    const wire = startWire({ configPath, workDir, homeDir, yolo: false });
    try {
      await sendInitialize(wire);
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "prompt-1",
        method: "prompt",
        params: { user_input: "run" },
      });
      const [requestMsg, messages] = await collectUntilRequest(wire);
      const payload = extractRequestPayload(messages);
      expect(displayTypes(payload)).toEqual(["shell"]);

      await wire.sendJson(buildApprovalResponse(requestMsg, "approve"));
      await collectUntilResponse(wire, "prompt-1");
    } finally {
      await wire.close();
    }
  });

  it("test_display_block_diff_write_file", async () => {
    const scripts = [
      [
        "text: writing",
        toolCallLine("tc-1", "WriteFile", {
          path: "test.txt",
          content: "hello",
        }),
      ].join("\n"),
      "text: done",
    ];
    const configPath = writeScriptedConfig(tmpPath, scripts);
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);

    const wire = startWire({ configPath, workDir, homeDir, yolo: false });
    try {
      await sendInitialize(wire);
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "prompt-1",
        method: "prompt",
        params: { user_input: "write" },
      });
      const [requestMsg, messages] = await collectUntilRequest(wire);
      const payload = extractRequestPayload(messages);
      expect(displayTypes(payload)).toEqual(["diff"]);

      const display = (payload.display as Array<Record<string, unknown>>)[0];
      expect(display.old_text).toBe("");
      expect(display.new_text).toBe("hello");

      await wire.sendJson(buildApprovalResponse(requestMsg, "approve"));
      await collectUntilResponse(wire, "prompt-1");
    } finally {
      await wire.close();
    }
  });

  it("test_display_block_diff_str_replace", async () => {
    const workDir = makeWorkDir(tmpPath);
    // Create the file that will be edited
    fs.writeFileSync(path.join(workDir, "file.txt"), "hello", "utf-8");

    const scripts = [
      [
        "text: replacing",
        toolCallLine("tc-1", "StrReplaceFile", {
          path: "file.txt",
          edit: { old: "hello", new: "world", replace_all: false },
        }),
      ].join("\n"),
      "text: done",
    ];
    const configPath = writeScriptedConfig(tmpPath, scripts);
    const homeDir = makeHomeDir(tmpPath);

    const wire = startWire({ configPath, workDir, homeDir, yolo: false });
    try {
      await sendInitialize(wire);
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "prompt-1",
        method: "prompt",
        params: { user_input: "replace" },
      });
      const [requestMsg, messages] = await collectUntilRequest(wire);
      const payload = extractRequestPayload(messages);
      expect(displayTypes(payload)).toEqual(["diff"]);

      await wire.sendJson(buildApprovalResponse(requestMsg, "approve"));
      await collectUntilResponse(wire, "prompt-1");
    } finally {
      await wire.close();
    }
  });

  it("test_display_block_todo", async () => {
    const scripts = [
      [
        "text: todos",
        buildSetTodoCall("tc-1", [
          { title: "task 1", status: "pending" },
          { title: "task 2", status: "done" },
        ]),
      ].join("\n"),
      "text: done",
    ];
    const configPath = writeScriptedConfig(tmpPath, scripts);
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);

    const wire = startWire({ configPath, workDir, homeDir, yolo: true });
    try {
      await sendInitialize(wire);
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "prompt-1",
        method: "prompt",
        params: { user_input: "todos" },
      });
      const [resp, messages] = await collectUntilResponse(wire, "prompt-1");
      expect((resp.result as Record<string, unknown>)?.status).toBe("finished");
      const summary = summarizeMessages(messages);
      const toolResult = summary.find((m) => m.type === "ToolResult");
      expect(toolResult).toBeDefined();
      const rv = (toolResult!.payload as Record<string, unknown>)
        ?.return_value as Record<string, unknown>;
      const display = rv?.display as Array<Record<string, unknown>>;
      expect(display).toBeInstanceOf(Array);
      expect(display[0]?.type).toBe("todo");
    } finally {
      await wire.close();
    }
  });

  it("test_tool_call_part_streaming", async () => {
    const argsStr = JSON.stringify({ command: "echo hi" });
    const parts = [argsStr.slice(0, 5), argsStr.slice(5), null];
    const toolCallParts = parts.map((p) => {
      const payload = {
        id: "tc-1",
        name: "Shell",
        arguments_part: p,
      };
      return `tool_call_part: ${JSON.stringify(payload)}`;
    });

    const scripts = [
      ["text: streaming", ...toolCallParts].join("\n"),
      "text: done",
    ];
    const configPath = writeScriptedConfig(tmpPath, scripts);
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);

    const wire = startWire({ configPath, workDir, homeDir, yolo: false });
    try {
      await sendInitialize(wire);
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "prompt-1",
        method: "prompt",
        params: { user_input: "stream" },
      });
      const [requestMsg, messages] = await collectUntilRequest(wire);
      const summary = summarizeMessages(messages);
      const toolCallParts2 = summary.filter((m) => m.type === "ToolCallPart");
      expect(toolCallParts2.length).toBeGreaterThanOrEqual(1);

      await wire.sendJson(buildApprovalResponse(requestMsg, "approve"));
      await collectUntilResponse(wire, "prompt-1");
    } finally {
      await wire.close();
    }
  });

  it("test_default_agent_missing_tool", async () => {
    const scripts = [
      [
        "text: calling",
        toolCallLine("tc-1", "SendDMail", { to: "x", body: "hi" }),
      ].join("\n"),
      "text: done",
    ];
    const configPath = writeScriptedConfig(tmpPath, scripts);
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);

    const wire = startWire({ configPath, workDir, homeDir, yolo: true });
    try {
      await sendInitialize(wire);
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "prompt-1",
        method: "prompt",
        params: { user_input: "send" },
      });
      const [resp, messages] = await collectUntilResponse(wire, "prompt-1");
      expect((resp.result as Record<string, unknown>)?.status).toBe("finished");
      const summary = summarizeMessages(messages);
      const toolResult = summary.find((m) => m.type === "ToolResult");
      expect(toolResult).toBeDefined();
      const rv = (toolResult!.payload as Record<string, unknown>)
        ?.return_value as Record<string, unknown>;
      expect(rv?.is_error).toBe(true);
      expect(String(rv?.output)).toContain("Tool `SendDMail` not found");
    } finally {
      await wire.close();
    }
  });

  it("test_custom_agent_exclude_tool", async () => {
    const agentYaml = [
      "version: 1",
      "agent:",
      "  name: test-agent",
      "  extend: default",
      "  exclude_tools:",
      "    - Shell",
    ].join("\n");

    const agentDir = path.join(tmpPath, "agent_exclude");
    fs.mkdirSync(agentDir, { recursive: true });
    const agentFile = path.join(agentDir, "agent.yaml");
    fs.writeFileSync(agentFile, agentYaml, "utf-8");

    const scripts = [
      ["text: cmd", buildShellToolCall("tc-1", "echo hi")].join("\n"),
      "text: done",
    ];
    const configPath = writeScriptedConfig(tmpPath, scripts);
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);

    const wire = startWire({
      configPath,
      workDir,
      homeDir,
      agentFile,
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
      expect((resp.result as Record<string, unknown>)?.status).toBe("finished");
      const summary = summarizeMessages(messages);
      const toolResult = summary.find((m) => m.type === "ToolResult");
      expect(toolResult).toBeDefined();
      const rv = (toolResult!.payload as Record<string, unknown>)
        ?.return_value as Record<string, unknown>;
      expect(rv?.is_error).toBe(true);
      expect(String(rv?.output)).toContain("Shell");
    } finally {
      await wire.close();
    }
  });
});
