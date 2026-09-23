/**
 * Wire skills & MCP E2E tests — corresponds to Python tests_e2e/test_wire_skills_mcp.py
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildApprovalResponse,
  cleanupTmpDir,
  collectUntilResponse,
  makeTmpDir,
  makeHomeDir,
  makeWorkDir,
  resetPathReplacements,
  sendInitialize,
  shareDir,
  startWire,
  summarizeMessages,
  writeScriptedConfig,
} from "./wire_helpers";

function sessionDirPath(
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

function readUserTexts(contextFile: string): string[] {
  const content = fs.readFileSync(contextFile, "utf-8");
  const texts: string[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const payload = JSON.parse(line);
      if (payload.role !== "user") continue;
      const c = payload.content;
      if (typeof c === "string") {
        texts.push(c);
      } else if (Array.isArray(c)) {
        const text = c
          .filter(
            (p: Record<string, unknown>) =>
              typeof p === "object" && p.type === "text",
          )
          .map((p: Record<string, unknown>) => p.text ?? "")
          .join("");
        texts.push(text);
      }
    } catch {
      // skip
    }
  }
  return texts;
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

describe("wire skills & MCP", () => {
  let tmpPath: string;

  beforeAll(() => {
    resetPathReplacements();
    tmpPath = makeTmpDir();
  });

  afterAll(() => {
    cleanupTmpDir(tmpPath);
  });

  it("test_skill_prompt_injects_skill_text", async () => {
    const skillDir = path.join(tmpPath, "skills");
    const skillPath = path.join(skillDir, "test-skill");
    fs.mkdirSync(skillPath, { recursive: true });

    const skillText = [
      "---",
      "name: test",
      "description: Test skill",
      "---",
      "",
      "Use this skill in wire tests.",
    ].join("\n");
    fs.writeFileSync(
      path.join(skillPath, "SKILL.md"),
      skillText + "\n",
      "utf-8",
    );

    const configPath = writeScriptedConfig(tmpPath, ["text: skill ok"]);
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);
    const sessionId = "skill-session";

    const wire = startWire({
      configPath,
      workDir,
      homeDir,
      skillsDirs: [skillDir],
      extraArgs: ["--session", sessionId],
      yolo: true,
    });
    try {
      await sendInitialize(wire);
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "prompt-1",
        method: "prompt",
        params: { user_input: "/skill:test" },
      });
      const [resp, messages] = await collectUntilResponse(wire, "prompt-1");
      expect((resp.result as Record<string, unknown>)?.status).toBe("finished");

      const summary = summarizeMessages(messages);
      expect(summary).toEqual([
        {
          method: "event",
          type: "TurnBegin",
          payload: { user_input: "/skill:test" },
        },
        { method: "event", type: "StepBegin", payload: { n: 1 } },
        {
          method: "event",
          type: "ContentPart",
          payload: { type: "text", text: "skill ok" },
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
        { method: "event", type: "TurnEnd", payload: {} },
      ]);
    } finally {
      await wire.close();
    }

    const contextFile = path.join(
      sessionDirPath(homeDir, workDir, sessionId),
      "context.jsonl",
    );
    const userTexts = readUserTexts(contextFile);
    expect(userTexts.length).toBeGreaterThan(0);
    const normalizedSkill = normalizeNewlines(skillText.trim());
    expect(
      userTexts.some((t) => normalizeNewlines(t) === normalizedSkill),
    ).toBe(true);
  });

  it("test_flow_skill", async () => {
    const skillDir = path.join(tmpPath, "skills");
    const flowDir = path.join(skillDir, "test-flow");
    fs.mkdirSync(flowDir, { recursive: true });

    fs.writeFileSync(
      path.join(flowDir, "SKILL.md"),
      [
        "---",
        "name: test-flow",
        "description: Test flow",
        "type: flow",
        "---",
        "",
        "```mermaid",
        "flowchart TD",
        "A([BEGIN]) --> B[Say hello]",
        "B --> C([END])",
        "```",
      ].join("\n"),
      "utf-8",
    );

    const configPath = writeScriptedConfig(tmpPath, ["text: flow done"]);
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);

    const wire = startWire({
      configPath,
      workDir,
      homeDir,
      skillsDirs: [skillDir],
      yolo: true,
    });
    try {
      await sendInitialize(wire);
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "prompt-1",
        method: "prompt",
        params: { user_input: "/flow:test-flow" },
      });
      const [resp, messages] = await collectUntilResponse(wire, "prompt-1");
      expect((resp.result as Record<string, unknown>)?.status).toBe("finished");

      const summary = summarizeMessages(messages);
      expect(summary).toEqual([
        {
          method: "event",
          type: "TurnBegin",
          payload: { user_input: "/flow:test-flow" },
        },
        {
          method: "event",
          type: "TurnBegin",
          payload: { user_input: "Say hello" },
        },
        { method: "event", type: "StepBegin", payload: { n: 1 } },
        {
          method: "event",
          type: "ContentPart",
          payload: { type: "text", text: "flow done" },
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
        { method: "event", type: "TurnEnd", payload: {} },
        { method: "event", type: "TurnEnd", payload: {} },
      ]);
    } finally {
      await wire.close();
    }
  });

  it("test_mcp_tool_call", { timeout: 30000 }, async () => {
    // Create a Python MCP server script
    const serverPath = path.join(tmpPath, "mcp_server.py");
    fs.writeFileSync(
      serverPath,
      [
        'from fastmcp.server import FastMCP',
        '',
        'server = FastMCP("test-mcp")',
        '',
        '@server.tool',
        'def ping(text: str) -> str:',
        '    return f"pong:{text}"',
        '',
        'if __name__ == "__main__":',
        '    server.run(transport="stdio", show_banner=False)',
      ].join("\n") + "\n",
      "utf-8",
    );

    const mcpConfig = {
      mcpServers: {
        test: {
          command: "python3",
          args: [serverPath],
        },
      },
    };
    const mcpConfigPath = path.join(tmpPath, "mcp.json");
    fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig), "utf-8");

    const toolArgs = JSON.stringify({ text: "hi" });
    const toolCall = JSON.stringify({
      id: "tc-1",
      name: "ping",
      arguments: toolArgs,
    });
    const scripts = [
      ["text: call mcp", `tool_call: ${toolCall}`].join("\n"),
      "text: done",
    ];
    const configPath = writeScriptedConfig(tmpPath, scripts);
    const workDir = makeWorkDir(tmpPath);
    const homeDir = makeHomeDir(tmpPath);

    const wire = startWire({
      configPath,
      workDir,
      homeDir,
      mcpConfigPath,
      yolo: false,
    });
    try {
      await sendInitialize(wire);
      await wire.sendJson({
        jsonrpc: "2.0",
        id: "prompt-1",
        method: "prompt",
        params: { user_input: "call mcp" },
      });

      const [resp, messages] = await collectUntilResponse(wire, "prompt-1", {
        requestHandler: (msg) => buildApprovalResponse(msg, "approve"),
        timeout: 15000,
      });
      expect((resp.result as Record<string, unknown>)?.status).toBe("finished");

      const summary = summarizeMessages(messages);
      // Should have MCP loading events
      expect(summary.some((m) => m.type === "MCPLoadingBegin")).toBe(true);
      expect(summary.some((m) => m.type === "MCPLoadingEnd")).toBe(true);
      // Should have ToolResult with pong
      const toolResult = summary.find((m) => m.type === "ToolResult");
      expect(toolResult).toBeDefined();
    } finally {
      await wire.close();
    }
  });
});
