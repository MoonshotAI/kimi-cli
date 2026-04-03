/**
 * Agent & Runtime — corresponds to Python soul/agent.py
 * Runtime execution environment and Agent loading.
 */

import type { Config, LoopControl } from "../config.ts";
import type { LLM } from "../llm.ts";
import type { Session } from "../session.ts";
import type { HookEngine } from "../hooks/engine.ts";
import type { ModelCapability } from "../types.ts";
import { Approval, ApprovalState } from "./approval.ts";
import { KimiToolset } from "./toolset.ts";
import { SlashCommandRegistry, createDefaultRegistry } from "./slash.ts";
import { Context } from "./context.ts";
import { logger } from "../utils/logging.ts";
import type { LaborMarket } from "../subagents/registry.ts";
import type { SubagentStore } from "../subagents/store.ts";
import type { ApprovalRuntime } from "../approval_runtime/index.ts";

// ── Built-in system prompt args ──────────────────────

export interface BuiltinSystemPromptArgs {
  KIMI_NOW: string;
  KIMI_WORK_DIR: string;
  KIMI_WORK_DIR_LS: string;
  KIMI_AGENTS_MD: string;
  KIMI_SKILLS: string;
  KIMI_ADDITIONAL_DIRS_INFO: string;
  KIMI_OS: string;
  KIMI_SHELL: string;
}

// ── Runtime ──────────────────────────────────────────

export class Runtime {
  config: Config;
  llm: LLM | null;
  session: Session;
  approval: Approval;
  hookEngine: HookEngine;
  builtinArgs: BuiltinSystemPromptArgs;
  role: "root" | "subagent";
  additionalDirs: string[];
  laborMarket: LaborMarket | null;
  subagentStore: SubagentStore | null;
  approvalRuntime: ApprovalRuntime | null;

  constructor(opts: {
    config: Config;
    llm: LLM | null;
    session: Session;
    approval: Approval;
    hookEngine: HookEngine;
    builtinArgs: BuiltinSystemPromptArgs;
    role?: "root" | "subagent";
    additionalDirs?: string[];
    laborMarket?: LaborMarket | null;
    subagentStore?: SubagentStore | null;
    approvalRuntime?: ApprovalRuntime | null;
  }) {
    this.config = opts.config;
    this.llm = opts.llm;
    this.session = opts.session;
    this.approval = opts.approval;
    this.hookEngine = opts.hookEngine;
    this.builtinArgs = opts.builtinArgs;
    this.role = opts.role ?? "root";
    this.additionalDirs = opts.additionalDirs ?? [];
    this.laborMarket = opts.laborMarket ?? null;
    this.subagentStore = opts.subagentStore ?? null;
    this.approvalRuntime = opts.approvalRuntime ?? null;
  }

  get loopControl(): LoopControl {
    return this.config.loop_control;
  }

  /** Create runtime with defaults. */
  static async create(opts: {
    config: Config;
    llm: LLM | null;
    session: Session;
    hookEngine: HookEngine;
  }): Promise<Runtime> {
    const workDir = opts.session.workDir;

    // Build system prompt args
    let workDirLs = "";
    try {
      const result = await Bun.$`ls -la ${workDir}`.quiet().text();
      workDirLs = result.trim();
    } catch {
      workDirLs = "(unable to list directory)";
    }

    const osType =
      process.platform === "darwin"
        ? "macOS"
        : process.platform === "win32"
          ? "Windows"
          : "Linux";

    const shell = process.env.SHELL ?? "/bin/bash";

    const builtinArgs: BuiltinSystemPromptArgs = {
      KIMI_NOW: new Date().toISOString(),
      KIMI_WORK_DIR: workDir,
      KIMI_WORK_DIR_LS: workDirLs,
      KIMI_AGENTS_MD: await loadAgentsMd(workDir) ?? "",
      KIMI_SKILLS: "", // TODO: list skills
      KIMI_ADDITIONAL_DIRS_INFO: opts.session.state.additional_dirs.length > 0
        ? `Additional directories: ${opts.session.state.additional_dirs.join(", ")}`
        : "",
      KIMI_OS: osType,
      KIMI_SHELL: shell,
    };

    // Restore additional directories from session state
    const additionalDirs = opts.session.state.additional_dirs.filter(
      (d: string) => {
        try {
          const { statSync } = require("node:fs");
          return statSync(d).isDirectory();
        } catch {
          return false;
        }
      },
    );

    // Restore approval state from session
    const approvalState = new ApprovalState({
      yolo:
        opts.config.default_yolo || opts.session.state.approval.yolo,
      autoApproveActions: new Set(
        opts.session.state.approval.auto_approve_actions,
      ),
    });

    const approval = new Approval({ state: approvalState });

    return new Runtime({
      config: opts.config,
      llm: opts.llm,
      session: opts.session,
      approval,
      hookEngine: opts.hookEngine,
      builtinArgs,
      additionalDirs,
    });
  }

  /** Create a copy for subagents with shared state. */
  copyForSubagent(): Runtime {
    return new Runtime({
      config: this.config,
      llm: this.llm,
      session: this.session,
      approval: this.approval.share(),
      hookEngine: this.hookEngine,
      builtinArgs: {
        ...this.builtinArgs,
        KIMI_NOW: new Date().toISOString(),
      },
      role: "subagent",
      // Share the same list reference so /add-dir mutations propagate to all agents
      additionalDirs: this.additionalDirs,
      laborMarket: this.laborMarket,
      subagentStore: this.subagentStore,
      approvalRuntime: this.approvalRuntime,
    });
  }
}

// ── Agent ──────────────────────────────────────────────

export class Agent {
  readonly name: string;
  readonly systemPrompt: string;
  readonly toolset: KimiToolset;
  readonly runtime: Runtime;
  readonly slashCommands: SlashCommandRegistry;

  constructor(opts: {
    name: string;
    systemPrompt: string;
    toolset: KimiToolset;
    runtime: Runtime;
    slashCommands?: SlashCommandRegistry;
  }) {
    this.name = opts.name;
    this.systemPrompt = opts.systemPrompt;
    this.toolset = opts.toolset;
    this.runtime = opts.runtime;
    this.slashCommands = opts.slashCommands ?? createDefaultRegistry();
  }

  get modelCapabilities(): Set<ModelCapability> | null {
    return this.runtime.llm?.capabilities ?? null;
  }

  get modelName(): string {
    return this.runtime.llm?.modelName ?? "unknown";
  }
}

// ── Agent loader ─────────────────────────────────────

/**
 * Load an agent with its toolset and system prompt.
 */
export async function loadAgent(opts: {
  runtime: Runtime;
  agentName?: string;
  systemPromptOverride?: string;
}): Promise<Agent> {
  const { runtime, agentName = "default" } = opts;

  // Load system prompt
  let systemPrompt = opts.systemPromptOverride ?? "";
  if (!systemPrompt) {
    systemPrompt = await loadSystemPrompt(agentName, runtime.builtinArgs);
  }

  // Create toolset
  const toolset = new KimiToolset({
    context: {
      workingDir: runtime.session.workDir,
      signal: new AbortController().signal,
      approval: async (toolName: string, _action: string, description: string) => {
        const result = await runtime.approval.request(
          toolName,
          toolName,
          description,
        );
        return result.approved ? "approve" : "reject";
      },
      wireEmit: () => {}, // Will be wired by KimiSoul
      serviceConfig: {
        moonshotSearch: runtime.config.services.moonshot_search
          ? {
              baseUrl: runtime.config.services.moonshot_search.base_url,
              apiKey: runtime.config.services.moonshot_search.api_key,
              customHeaders: runtime.config.services.moonshot_search.custom_headers,
            }
          : undefined,
        moonshotFetch: runtime.config.services.moonshot_fetch
          ? {
              baseUrl: runtime.config.services.moonshot_fetch.base_url,
              apiKey: runtime.config.services.moonshot_fetch.api_key,
              customHeaders: runtime.config.services.moonshot_fetch.custom_headers,
            }
          : undefined,
      },
      runtime,
    },
    hookEngine: runtime.hookEngine,
  });

  // Register built-in tools
  await registerBuiltinTools(toolset, runtime);

  return new Agent({
    name: agentName,
    systemPrompt,
    toolset,
    runtime,
  });
}

async function loadSystemPrompt(
  agentName: string,
  args: BuiltinSystemPromptArgs,
): Promise<string> {
  // Try to load from agents/default/system.md
  const paths = [
    `src/kimi_cli/agents/${agentName}/system.md`,
    `agents/${agentName}/system.md`,
  ];

  for (const p of paths) {
    const file = Bun.file(p);
    if (await file.exists()) {
      let template = await file.text();
      // Simple template substitution (${VAR} syntax)
      for (const [key, value] of Object.entries(args)) {
        template = template.replaceAll(`\${${key}}`, String(value));
      }
      return template;
    }
  }

  // Fallback system prompt
  return [
    "You are Kimi, an AI assistant running in a terminal.",
    `Current working directory: ${args.KIMI_WORK_DIR}`,
    `OS: ${args.KIMI_OS}, Shell: ${args.KIMI_SHELL}`,
    `Current date: ${args.KIMI_NOW}`,
    "",
    "You have access to tools for reading/writing files, running shell commands,",
    "and searching the web. Use them to help the user with their tasks.",
  ].join("\n");
}

async function registerBuiltinTools(toolset: KimiToolset, runtime: Runtime): Promise<void> {
  // Import and register all built-in tools
  const toolModules = [
    () => import("../tools/file/read.ts"),
    () => import("../tools/file/write.ts"),
    () => import("../tools/file/replace.ts"),
    () => import("../tools/file/glob.ts"),
    () => import("../tools/file/grep.ts"),
    () => import("../tools/shell/shell.ts"),
    () => import("../tools/web/fetch.ts"),
    () => import("../tools/web/search.ts"),
    () => import("../tools/think/think.ts"),
    () => import("../tools/ask_user/ask_user.ts"),
    () => import("../tools/todo/todo.ts"),
    () => import("../tools/plan/plan.ts"),
  ];

  for (const loadModule of toolModules) {
    try {
      const mod = await loadModule();
      // Find exported classes that look like tools
      for (const [_key, value] of Object.entries(mod)) {
        if (
          typeof value === "function" &&
          value.prototype &&
          typeof value.prototype.execute === "function" &&
          typeof value.prototype.toDefinition === "function"
        ) {
          try {
            const instance = new (value as new () => any)();
            if (instance.name) {
              toolset.add(instance);
            }
          } catch {
            // Some tools need constructor args, skip
          }
        }
      }
    } catch (err) {
      logger.warn(`Failed to load tool module: ${err}`);
    }
  }

  // Register Agent tool (needs runtime for description building)
  try {
    const { AgentTool } = await import("../tools/agent/agent.ts");
    const agentTool = new AgentTool();
    agentTool.buildDescription(runtime);
    toolset.add(agentTool);
  } catch (err) {
    logger.warn(`Failed to load Agent tool: ${err}`);
  }
}

// ── AGENTS.md loader ────────────────────────────────

const AGENTS_MD_MAX_BYTES = 32 * 1024; // 32 KiB

/**
 * Find the nearest git root by walking up from workDir.
 */
async function findProjectRoot(workDir: string): Promise<string> {
  const { resolve, dirname } = await import("node:path");
  let current = resolve(workDir);
  while (true) {
    const gitFile = Bun.file(`${current}/.git`);
    if (await gitFile.exists()) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(workDir);
    current = parent;
  }
}

/**
 * Return the list of directories from projectRoot down to workDir (inclusive).
 */
function dirsRootToLeaf(workDir: string, projectRoot: string): string[] {
  const { resolve, dirname } = require("node:path");
  const dirs: string[] = [];
  let current = resolve(workDir);
  const root = resolve(projectRoot);
  while (true) {
    dirs.push(current);
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  dirs.reverse(); // root → leaf
  return dirs;
}

/**
 * Discover and merge AGENTS.md files from the project root down to workDir.
 * Matches Python's `load_agents_md` behavior.
 */
export async function loadAgentsMd(workDir: string): Promise<string | null> {
  const projectRoot = await findProjectRoot(workDir);
  const dirs = dirsRootToLeaf(workDir, projectRoot);

  // Phase 1: collect all candidate files (root → leaf order)
  const discovered: { path: string; content: string }[] = [];
  for (const d of dirs) {
    const candidates: string[] = [];

    // .kimi/AGENTS.md — highest priority
    const kimiPath = `${d}/.kimi/AGENTS.md`;
    if (await Bun.file(kimiPath).exists()) {
      candidates.push(kimiPath);
    }

    // AGENTS.md or agents.md — mutually exclusive
    const upperPath = `${d}/AGENTS.md`;
    const lowerPath = `${d}/agents.md`;
    if (await Bun.file(upperPath).exists()) {
      candidates.push(upperPath);
    } else if (await Bun.file(lowerPath).exists()) {
      candidates.push(lowerPath);
    }

    for (const path of candidates) {
      const content = (await Bun.file(path).text()).trim();
      if (content) {
        discovered.push({ path, content });
        logger.info(`Loaded agents.md: ${path}`);
      }
    }
  }

  if (discovered.length === 0) return null;

  // Phase 2: allocate budget leaf-first
  let remaining = AGENTS_MD_MAX_BYTES;
  const budgeted: { path: string; content: string }[] = new Array(discovered.length);
  for (let i = discovered.length - 1; i >= 0; i--) {
    const { path, content } = discovered[i]!;
    const annotation = `<!-- From: ${path} -->\n`;
    const separatorCost = i < discovered.length - 1 ? 2 : 0; // "\n\n"
    const overhead = Buffer.byteLength(annotation) + separatorCost;
    remaining -= overhead;
    if (remaining <= 0) {
      budgeted[i] = { path, content: "" };
      remaining = 0;
      continue;
    }
    const encoded = Buffer.from(content);
    if (encoded.length > remaining) {
      budgeted[i] = {
        path,
        content: encoded.subarray(0, remaining).toString("utf-8").trim(),
      };
      remaining = 0;
    } else {
      budgeted[i] = { path, content };
      remaining -= encoded.length;
    }
  }

  // Phase 3: assemble root → leaf
  const parts: string[] = [];
  for (const { path, content } of budgeted) {
    if (content) {
      parts.push(`<!-- From: ${path} -->\n${content}`);
    }
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}
