/**
 * Wire sessions E2E tests — corresponds to Python tests_e2e/test_wire_sessions.py
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  cleanupTmpDir,
  collectUntilResponse,
  makeTmpDir,
  makeHomeDir,
  makeWorkDir,
  normalizeResponse,
  readResponse,
  resetPathReplacements,
  sendInitialize,
  shareDir,
  startWire,
  summarizeMessages,
  writeScriptedConfig,
} from "./wire_helpers";

function sessionDir(
  homeDir: string,
  workDir: string,
  sessionId: string,
): string {
  const digest = crypto
    .createHash("md5")
    .update(workDir)
    .digest("hex");
  return path.join(shareDir(homeDir), "sessions", digest, sessionId);
}

function countLines(filePath: string): number {
  const content = fs.readFileSync(filePath, "utf-8");
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0).length;
}

function readRoles(filePath: string): string[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const roles: string[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.role) {
        roles.push(obj.role);
      }
    } catch {
      // skip
    }
  }
  return roles;
}

describe("wire sessions", () => {
  let tmpPath: string;

  beforeAll(() => {
    resetPathReplacements();
    tmpPath = makeTmpDir();
  });

  afterAll(() => {
    cleanupTmpDir(tmpPath);
  });

  it("test_session_files_created", async () => {
    const configPath = writeScriptedConfig(tmpPath, ["text: hello"]);
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);

    const wire = startWire({
      configPath,
      workDir,
      homeDir,
      extraArgs: ["--session", "e2e-session"],
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
      const [resp] = await collectUntilResponse(wire, "prompt-1");
      expect((resp.result as Record<string, unknown>)?.status).toBe("finished");
    } finally {
      await wire.close();
    }

    const sd = sessionDir(homeDir, workDir, "e2e-session");
    expect(fs.existsSync(path.join(sd, "context.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(sd, "wire.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(sd, "state.json"))).toBe(true);
  });

  it("test_continue_session_appends", async () => {
    const scripts = ["text: first", "text: second"];
    const configPath = writeScriptedConfig(tmpPath, scripts);
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);
    const sid = "continue-session";

    // First turn
    let wire = startWire({
      configPath,
      workDir,
      homeDir,
      extraArgs: ["--session", sid],
      yolo: true,
    });
    try {
      await sendInitialize(wire);
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "prompt-1",
        method: "prompt",
        params: { user_input: "hello first" },
      });
      const [resp] = await collectUntilResponse(wire, "prompt-1");
      expect((resp.result as Record<string, unknown>)?.status).toBe("finished");
    } finally {
      await wire.close();
    }

    const sd = sessionDir(homeDir, workDir, sid);
    const contextFile = path.join(sd, "context.jsonl");
    const wireFile = path.join(sd, "wire.jsonl");
    const contextBefore = countLines(contextFile);
    const wireBefore = countLines(wireFile);

    // Second turn (continue)
    const scripts2 = ["text: continued"];
    const configPath2 = writeScriptedConfig(tmpPath, scripts2);
    wire = startWire({
      configPath: configPath2,
      workDir,
      homeDir,
      extraArgs: ["--session", sid, "--continue"],
      yolo: true,
    });
    try {
      await sendInitialize(wire);
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "prompt-2",
        method: "prompt",
        params: { user_input: "hello second" },
      });
      const [resp] = await collectUntilResponse(wire, "prompt-2");
      expect((resp.result as Record<string, unknown>)?.status).toBe("finished");
    } finally {
      await wire.close();
    }

    const contextAfter = countLines(contextFile);
    const wireAfter = countLines(wireFile);
    expect(contextAfter).toBeGreaterThan(contextBefore);
    expect(wireAfter).toBeGreaterThan(wireBefore);
  });

  it("test_clear_context_rotates", async () => {
    const scripts = ["text: before clear", "text: after clear"];
    const configPath = writeScriptedConfig(tmpPath, scripts);
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);
    const sid = "clear-session";

    // First turn
    let wire = startWire({
      configPath,
      workDir,
      homeDir,
      extraArgs: ["--session", sid],
      yolo: true,
    });
    try {
      await sendInitialize(wire);
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "prompt-1",
        method: "prompt",
        params: { user_input: "before" },
      });
      await collectUntilResponse(wire, "prompt-1");

      // Send /clear
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "clear-1",
        method: "prompt",
        params: { user_input: "/clear" },
      });
      await collectUntilResponse(wire, "clear-1");
    } finally {
      await wire.close();
    }

    const sd = sessionDir(homeDir, workDir, sid);
    // The old context should be rotated
    expect(fs.existsSync(path.join(sd, "context_1.jsonl"))).toBe(true);
    // The main context should have only system prompt
    const roles = readRoles(path.join(sd, "context.jsonl"));
    expect(roles).toEqual(["_system_prompt"]);
  });

  it("test_manual_compact", async () => {
    const script = [
      "id: scripted-1",
      'usage: {"input_other": 100, "output": 18}',
      "text: " + "x".repeat(200),
    ].join("\n");
    const scripts = [script, "text: compacted"];
    const configPath = writeScriptedConfig(tmpPath, scripts);
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
      // First prompt to build context
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "prompt-1",
        method: "prompt",
        params: { user_input: "fill context" },
      });
      await collectUntilResponse(wire, "prompt-1");

      // Send /compact
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "compact-1",
        method: "prompt",
        params: { user_input: "/compact" },
      });
      const [resp, messages] = await collectUntilResponse(wire, "compact-1");
      expect((resp.result as Record<string, unknown>)?.status).toBe("finished");

      const summary = summarizeMessages(messages);
      expect(summary.some((m) => m.type === "CompactionBegin")).toBe(true);
      expect(summary.some((m) => m.type === "CompactionEnd")).toBe(true);
    } finally {
      await wire.close();
    }
  });

  it("test_manual_compact_with_usage", async () => {
    const makeScript = (n: number) =>
      [
        `id: scripted-${n}`,
        `usage: {"input_other": ${50 * n}, "output": 10}`,
        `text: response ${n}`,
      ].join("\n");

    const scripts = [
      makeScript(1),
      makeScript(2),
      makeScript(3),
      "text: after compact",
    ];
    const configPath = writeScriptedConfig(tmpPath, scripts);
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

      // Three turns to build up usage
      for (let i = 1; i <= 3; i++) {
        await wire.sendJson({
          jsonrpc: "2.0",
          id: `prompt-${i}`,
          method: "prompt",
          params: { user_input: `message ${i}` },
        });
        await collectUntilResponse(wire, `prompt-${i}`);
      }

      // Compact
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "compact-1",
        method: "prompt",
        params: { user_input: "/compact" },
      });
      const [resp, messages] = await collectUntilResponse(wire, "compact-1");
      expect((resp.result as Record<string, unknown>)?.status).toBe("finished");
      const summary = summarizeMessages(messages);
      expect(summary.some((m) => m.type === "CompactionBegin")).toBe(true);
      expect(summary.some((m) => m.type === "CompactionEnd")).toBe(true);
    } finally {
      await wire.close();
    }
  });

  it("test_replay_streams_wire_history", async () => {
    const configPath = writeScriptedConfig(tmpPath, ["text: replay me"]);
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);
    const sid = "replay-session";

    // First, create a session with some history
    let wire = startWire({
      configPath,
      workDir,
      homeDir,
      extraArgs: ["--session", sid],
      yolo: true,
    });
    try {
      await sendInitialize(wire);
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "prompt-1",
        method: "prompt",
        params: { user_input: "create history" },
      });
      await collectUntilResponse(wire, "prompt-1");
    } finally {
      await wire.close();
    }

    // Now replay
    const scripts2 = ["text: unused"];
    const configPath2 = writeScriptedConfig(tmpPath, scripts2);
    wire = startWire({
      configPath: configPath2,
      workDir,
      homeDir,
      extraArgs: ["--session", sid, "--continue"],
      yolo: true,
    });
    try {
      await sendInitialize(wire);
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "replay-1",
        method: "replay",
        params: {},
      });
      const resp = await readResponse(wire, "replay-1");
      const result = resp.result as Record<string, unknown>;
      expect(result.status).toBe("finished");
      expect(typeof result.events).toBe("number");
      expect((result.events as number)).toBeGreaterThan(0);
    } finally {
      await wire.close();
    }
  });
});
