/**
 * Wire question E2E tests — corresponds to Python tests_e2e/test_wire_question.py
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  buildApprovalResponse,
  buildAskUserToolCall,
  buildQuestionResponse,
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

function makeQuestion(
  question: string,
  options: string[],
  multiSelect = false,
): Record<string, unknown> {
  return {
    question,
    options: options.map((o) => ({ label: o, description: "" })),
    multi_select: multiSelect,
  };
}

describe("wire question", () => {
  let tmpPath: string;

  beforeAll(() => {
    resetPathReplacements();
    tmpPath = makeTmpDir();
  });

  afterAll(() => {
    cleanupTmpDir(tmpPath);
  });

  it("test_question_request_answer", async () => {
    const questions = [makeQuestion("Which option?", ["Alpha", "Beta"])];
    const askLine = buildAskUserToolCall("tc-1", questions);
    const scripts = [
      ["text: asking", askLine].join("\n"),
      "text: answered",
    ];
    const configPath = writeScriptedConfig(tmpPath, scripts);
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);

    const wire = startWire({ configPath, workDir, homeDir, yolo: true });
    try {
      await sendInitialize(wire, {
        capabilities: { supports_question: true },
      });
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "prompt-1",
        method: "prompt",
        params: { user_input: "ask" },
      });

      // The request handler routes QuestionRequest and ApprovalRequest
      const requestHandler = (msg: Record<string, unknown>) => {
        const params = msg.params as Record<string, unknown> | undefined;
        if (params?.type === "QuestionRequest") {
          return buildQuestionResponse(msg, {
            "Which option?": "Alpha",
          });
        }
        // ApprovalRequest
        return buildApprovalResponse(msg, "approve");
      };

      const [resp, messages] = await collectUntilResponse(wire, "prompt-1", {
        requestHandler,
      });
      expect((resp.result as Record<string, unknown>)?.status).toBe("finished");

      const summary = summarizeMessages(messages);
      const toolResult = summary.find((m) => m.type === "ToolResult");
      expect(toolResult).toBeDefined();
      const rv = (toolResult!.payload as Record<string, unknown>)
        ?.return_value as Record<string, unknown>;
      const output = rv?.output;
      // Output should be JSON with the answers
      if (typeof output === "string") {
        const parsed = JSON.parse(output);
        expect(parsed.answers["Which option?"]).toBe("Alpha");
      }
    } finally {
      await wire.close();
    }
  });

  it("test_question_request_error_response", async () => {
    const questions = [makeQuestion("Pick one", ["A", "B"])];
    const askLine = buildAskUserToolCall("tc-1", questions);
    const scripts = [
      ["text: asking", askLine].join("\n"),
      "text: handled",
    ];
    const configPath = writeScriptedConfig(tmpPath, scripts);
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);

    const wire = startWire({ configPath, workDir, homeDir, yolo: true });
    try {
      await sendInitialize(wire, {
        capabilities: { supports_question: true },
      });
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "prompt-1",
        method: "prompt",
        params: { user_input: "ask" },
      });

      const requestHandler = (msg: Record<string, unknown>) => {
        const params = msg.params as Record<string, unknown> | undefined;
        if (params?.type === "QuestionRequest") {
          // Send a JSON-RPC error instead of proper response
          return {
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -1, message: "dismissed" },
          };
        }
        return buildApprovalResponse(msg, "approve");
      };

      const [resp] = await collectUntilResponse(wire, "prompt-1", {
        requestHandler,
      });
      expect((resp.result as Record<string, unknown>)?.status).toBe("finished");
    } finally {
      await wire.close();
    }
  });

  it("test_question_capability_negotiation", async () => {
    const configPath = writeScriptedConfig(tmpPath, ["text: hello"]);
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);

    const wire = startWire({ configPath, workDir, homeDir, yolo: true });
    try {
      const resp = await sendInitialize(wire);
      const normalized = normalizeResponse(resp);
      const result = normalized.result as Record<string, unknown>;
      const capabilities = result.capabilities as Record<string, unknown>;
      expect(capabilities.supports_question).toBe(true);
    } finally {
      await wire.close();
    }
  });

  it("test_ask_user_tool_hidden_when_question_not_supported", async () => {
    const questions = [makeQuestion("Which?", ["A", "B"])];
    const askLine = buildAskUserToolCall("tc-1", questions);
    const scripts = [
      ["text: asking", askLine].join("\n"),
      "text: done",
    ];
    const configPath = writeScriptedConfig(tmpPath, scripts);
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);

    const wire = startWire({ configPath, workDir, homeDir, yolo: true });
    try {
      await sendInitialize(wire, {
        capabilities: { supports_question: false },
      });
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "prompt-1",
        method: "prompt",
        params: { user_input: "ask" },
      });
      const [resp, messages] = await collectUntilResponse(wire, "prompt-1");
      expect((resp.result as Record<string, unknown>)?.status).toBe("finished");

      // No QuestionRequest should have been sent
      const requests = messages.filter((m) => m.method === "request");
      expect(requests.length).toBe(0);

      // The tool result should contain error about not supporting questions
      const summary = summarizeMessages(messages);
      const toolResult = summary.find((m) => m.type === "ToolResult");
      expect(toolResult).toBeDefined();
      const rv = (toolResult!.payload as Record<string, unknown>)
        ?.return_value as Record<string, unknown>;
      expect(rv?.is_error).toBe(true);
      expect(String(rv?.message)).toContain(
        "does not support interactive questions",
      );
    } finally {
      await wire.close();
    }
  });
});
