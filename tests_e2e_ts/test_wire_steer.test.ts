/**
 * Wire steer E2E tests — corresponds to Python tests_e2e/test_wire_steer.py
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  buildApprovalResponse,
  buildShellToolCall,
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
  writeScriptedConfig,
} from "./wire_helpers";

describe("wire steer", () => {
  let tmpPath: string;

  beforeAll(() => {
    resetPathReplacements();
    tmpPath = makeTmpDir();
  });

  afterAll(() => {
    cleanupTmpDir(tmpPath);
  });

  it("test_steer_no_active_turn", async () => {
    const configPath = writeScriptedConfig(tmpPath, ["text: hello"]);
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);

    const wire = startWire({ configPath, workDir, homeDir, yolo: true });
    try {
      await sendInitialize(wire);
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "steer-1",
        method: "steer",
        params: { user_input: "do something" },
      });
      const resp = normalizeResponse(await readResponse(wire, "steer-1"));
      expect(resp).toEqual({
        error: {
          code: -32000,
          message: "No agent turn is in progress",
          data: null,
        },
      });
    } finally {
      await wire.close();
    }
  });

  it("test_steer_during_active_turn", async () => {
    const scripts = [
      ["text: working", buildShellToolCall("tc-1", "echo hi")].join("\n"),
      "text: done after steer",
    ];
    const configPath = writeScriptedConfig(tmpPath, scripts);
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);

    const wire = startWire({ configPath, workDir, homeDir, yolo: false });
    try {
      await sendInitialize(wire);
      // Start a prompt that will block on tool approval
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "prompt-1",
        method: "prompt",
        params: { user_input: "run" },
      });
      const [requestMsg] = await collectUntilRequest(wire);

      // Send steer while the turn is active
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "steer-1",
        method: "steer",
        params: { user_input: "also do this" },
      });
      const steerResp = normalizeResponse(await readResponse(wire, "steer-1"));
      expect(steerResp).toEqual({ result: { status: "steered" } });

      // Approve the tool call to let the turn continue
      await wire.sendJson(buildApprovalResponse(requestMsg, "approve"));
      const [resp] = await collectUntilResponse(wire, "prompt-1");
      expect((resp.result as Record<string, unknown>)?.status).toBe("finished");
    } finally {
      await wire.close();
    }
  });

  it("test_steer_basic_lifecycle_completes", async () => {
    const scripts = ["text: first response", "text: steered response"];
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
        params: { user_input: "start" },
      });
      const [resp] = await collectUntilResponse(wire, "prompt-1");
      expect((resp.result as Record<string, unknown>)?.status).toBe("finished");
    } finally {
      await wire.close();
    }
  });
});
