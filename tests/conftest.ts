/**
 * Test fixtures and helpers — corresponds to Python tests/conftest.py
 * Shared utilities for all test files.
 */

import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import type { Config } from "../src/kimi_cli_ts/config.ts";
import { type LLM, type LLMProvider, type StreamChunk, type ChatOptions } from "../src/kimi_cli_ts/llm.ts";
import type { Message, TokenUsage, ModelCapability } from "../src/kimi_cli_ts/types.ts";
import { Session, SessionState } from "../src/kimi_cli_ts/session.ts";
import { Approval, ApprovalState } from "../src/kimi_cli_ts/soul/approval.ts";
import { HookEngine } from "../src/kimi_cli_ts/hooks/engine.ts";
import { Runtime, type BuiltinSystemPromptArgs } from "../src/kimi_cli_ts/soul/agent.ts";
import { Context } from "../src/kimi_cli_ts/soul/context.ts";
import type { ToolContext, ToolResult } from "../src/kimi_cli_ts/tools/types.ts";

// ── Temp directory helper ───────────────────────────

export function createTempDir(prefix = "kimi-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// ── Test context that sets up and tears down ────────

export class TestContext {
  readonly tempDir: string;
  readonly workDir: string;
  readonly shareDir: string;

  constructor() {
    this.tempDir = createTempDir();
    this.workDir = join(this.tempDir, "work");
    this.shareDir = join(this.tempDir, "share");
    Bun.spawnSync(["mkdir", "-p", this.workDir, this.shareDir]);
  }

  cleanup(): void {
    removeTempDir(this.tempDir);
  }
}

// ── Mock LLM Provider ───────────────────────────────

export class MockChatProvider implements LLMProvider {
  readonly modelName: string;
  private responses: StreamChunk[][];
  private callIndex = 0;
  readonly calls: { messages: Message[]; options?: ChatOptions }[] = [];

  constructor(responses: StreamChunk[][] = [], modelName = "mock-model") {
    this.responses = responses;
    this.modelName = modelName;
  }

  async *chat(
    messages: Message[],
    options?: ChatOptions,
  ): AsyncIterable<StreamChunk> {
    this.calls.push({ messages, options });
    const chunks = this.responses[this.callIndex] ?? [];
    this.callIndex++;
    for (const chunk of chunks) {
      yield chunk;
    }
  }
}

/**
 * Create a mock LLM that returns scripted responses.
 */
export function createMockLLM(
  responses: StreamChunk[][] = [],
  opts?: { maxContextSize?: number; capabilities?: ModelCapability[] },
): { llm: LLM; provider: MockChatProvider } {
  const provider = new MockChatProvider(responses);
  const llm: LLM = {
    provider,
    maxContextSize: opts?.maxContextSize ?? 100_000,
    capabilities: new Set<ModelCapability>(
      opts?.capabilities ?? ["image_in", "thinking"],
    ),
    modelConfig: null,
    providerConfig: null,
    get modelName() {
      return provider.modelName;
    },
    hasCapability(cap: ModelCapability) {
      return this.capabilities.has(cap);
    },
    chat(messages: Message[], options?: ChatOptions) {
      return provider.chat(messages, options);
    },
  };
  return { llm, provider };
}

// ── Default Config ──────────────────────────────────

export function createTestConfig(overrides?: Partial<Config>): Config {
  return {
    default_model: "",
    default_thinking: false,
    default_yolo: false,
    default_editor: "",
    theme: "dark",
    models: {},
    providers: {},
    loop_control: {
      max_steps_per_turn: 10,
      max_retries_per_step: 3,
      max_ralph_iterations: 0,
      reserved_context_size: 5000,
      compaction_trigger_ratio: 0.85,
    },
    background: {
      max_running_tasks: 4,
      read_max_bytes: 30000,
      notification_tail_lines: 20,
      notification_tail_chars: 3000,
      wait_poll_interval_ms: 500,
      worker_heartbeat_interval_ms: 5000,
      worker_stale_after_ms: 15000,
      kill_grace_period_ms: 2000,
      keep_alive_on_exit: false,
      agent_task_timeout_s: 900,
    },
    notifications: { claim_stale_after_ms: 15000 },
    services: {},
    mcp: { client: { tool_call_timeout_ms: 60000 } },
    hooks: [],
    ...overrides,
  } as Config;
}

// ── Default Builtin Args ────────────────────────────

export function createTestBuiltinArgs(
  workDir: string,
): BuiltinSystemPromptArgs {
  return {
    KIMI_NOW: "1970-01-01T00:00:00+00:00",
    KIMI_WORK_DIR: workDir,
    KIMI_WORK_DIR_LS: "test ls content",
    KIMI_AGENTS_MD: "",
    KIMI_SKILLS: "No skills found.",
    KIMI_ADDITIONAL_DIRS_INFO: "",
    KIMI_OS: "macOS",
    KIMI_SHELL: "bash",
  };
}

// ── Session helper ──────────────────────────────────

export function createTestSession(workDir: string, shareDir: string): Session {
  const sessionsDir = join(shareDir, "sessions");
  Bun.spawnSync(["mkdir", "-p", join(sessionsDir, "test-session")]);

  const contextFile = join(sessionsDir, "test-session", "context.jsonl");
  const wireFile = join(sessionsDir, "test-session", "wire.jsonl");

  // Create empty files
  Bun.spawnSync(["touch", contextFile, wireFile]);

  return new Session({
    id: "test-session",
    workDir: resolve(workDir),
    sessionsDir,
    contextFile,
    wireFile,
    state: SessionState.parse({}),
    title: "Test Session",
    updatedAt: 0,
  });
}

// ── Approval helper ─────────────────────────────────

export function createTestApproval(yolo = true): Approval {
  return new Approval({ yolo });
}

// ── Runtime helper ──────────────────────────────────

export function createTestRuntime(
  ctx: TestContext,
  opts?: { llm?: LLM; yolo?: boolean; config?: Config },
): Runtime {
  const config = opts?.config ?? createTestConfig();
  const { llm } = opts?.llm
    ? { llm: opts.llm }
    : createMockLLM();
  const session = createTestSession(ctx.workDir, ctx.shareDir);
  const approval = createTestApproval(opts?.yolo ?? true);
  const hookEngine = new HookEngine({ cwd: ctx.workDir });
  const builtinArgs = createTestBuiltinArgs(ctx.workDir);

  return new Runtime({
    config,
    llm,
    session,
    approval,
    hookEngine,
    builtinArgs,
  });
}

// ── Context helper ──────────────────────────────────

export function createTestContext(shareDir: string): Context {
  const contextFile = join(shareDir, "test-context.jsonl");
  return new Context(contextFile);
}

// ── Tool Context helper ─────────────────────────────

export function createTestToolContext(
  workDir: string,
  opts?: { yolo?: boolean },
): ToolContext {
  return {
    workingDir: workDir,
    signal: new AbortController().signal,
    approval: async () => ({ decision: opts?.yolo !== false ? "approve" as const : "reject" as const, feedback: "" }),
    wireEmit: () => {},
  };
}

// ── Stream chunk builders ───────────────────────────

export function textChunks(text: string): StreamChunk[] {
  return [
    { type: "text", text },
    {
      type: "usage",
      usage: { inputTokens: 100, outputTokens: text.length },
    },
    { type: "done" },
  ];
}

export function toolCallChunks(
  name: string,
  args: Record<string, unknown>,
  id = "tc-1",
): StreamChunk[] {
  return [
    {
      type: "tool_call",
      id,
      name,
      arguments: JSON.stringify(args),
    },
    {
      type: "usage",
      usage: { inputTokens: 100, outputTokens: 50 },
    },
    { type: "done" },
  ];
}

export function textAndToolChunks(
  text: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
  toolId = "tc-1",
): StreamChunk[] {
  return [
    { type: "text", text },
    {
      type: "tool_call",
      id: toolId,
      name: toolName,
      arguments: JSON.stringify(toolArgs),
    },
    {
      type: "usage",
      usage: { inputTokens: 100, outputTokens: text.length + 50 },
    },
    { type: "done" },
  ];
}
