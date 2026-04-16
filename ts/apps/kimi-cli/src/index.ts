/**
 * kimi-cli entry point.
 *
 * Parses CLI arguments via Commander.js, validates options, determines the
 * UI mode, and dispatches to the appropriate runner (shell / print / wire).
 *
 * In shell mode the Ink 7 TUI is launched with no alternate screen. The
 * shell runner boots a real `KimiCoreClient` wrapping `@moonshot-ai/core`
 * by default. `--offline` falls back to the development `MockDataSource`.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AgentRegistry,
  AskUserQuestionTool,
  BackgroundProcessManager,
  BashTool,
  DefaultSkillManager,
  EditTool,
  ExitPlanModeTool,
  FetchURLTool,
  GlobTool,
  GrepTool,
  InMemoryTodoStore,
  MCPConfigError,
  MCPManager,
  PathConfig,
  ReadMediaFileTool,
  ReadTool,
  SessionManager,
  SetTodoListTool,
  TaskListTool,
  TaskOutputTool,
  TaskStopTool,
  ThinkTool,
  WebSearchTool,
  WriteTool,
  assembleSystemPrompt,
  createKosongAdapter,
  createKosongCompactionProvider,
  createProviderFromConfig,
  createRuntime,
  createStubJournalCapability,
  extendWorkspaceWithSkillRoots,
  loadConfig as loadKimiCoreConfig,
  parseMcpConfig,
  resolveSkillRoots,
} from '@moonshot-ai/core';
import type {
  McpConfig,
  McpLoadNotification,
  Runtime,
  Tool,
  WorkspaceConfig,
} from '@moonshot-ai/core';
import { localKaos } from '@moonshot-ai/kaos';
import { MockDataSource } from '@moonshot-ai/kimi-wire-mock';
import { render } from 'ink';
import React from 'react';

import App from './app/App.js';
import type { AppState } from './app/context.js';
import { createProgram } from './cli/commands.js';
import type { CLIOptions, UIMode } from './cli/options.js';
import { OptionConflictError, validateOptions } from './cli/options.js';
import { loadConfig as loadCliConfig } from './config/loader.js';
import { StubUrlFetcher } from './providers/stub-fetch-url.js';
import { StubWebSearchProvider } from './providers/stub-web-search.js';
import { WireClientImpl } from './wire/client.js';
import type { WireClient } from './wire/client.js';
import { KimiCoreClient } from './wire/kimi-core-client.js';
import type { PerSessionToolContext } from './wire/kimi-core-client.js';

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

const __dirname = import.meta.dirname;

function getVersion(): string {
  // In the built bundle the dist/ directory sits one level below the package
  // root, so package.json is at `../package.json`.  During development with
  // tsx the source file is at `src/`, same relative depth.
  const pkgPath = resolve(__dirname, '..', 'package.json');
  const pkg: { version: string } = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  return pkg.version;
}

// ---------------------------------------------------------------------------
// UI mode runners
// ---------------------------------------------------------------------------

interface ShellBootstrap {
  wireClient: WireClient;
  sessionId: string;
  model: string;
  defaultThinking: boolean;
  theme: AppState['theme'];
  /**
   * Slice 4.4 Part 4 — optional MCPManager bound to the session; the
   * runner closes it on exit so subprocess transports do not leak.
   */
  mcpManager?: MCPManager | undefined;
}

async function bootstrapOfflineShell(opts: CLIOptions): Promise<ShellBootstrap> {
  const { config } = loadCliConfig({
    config: opts.config,
    configFile: opts.configFile,
  });

  const model = opts.model ?? config.default_model ?? 'mock-model';
  const workDir = opts.workDir ?? process.cwd();

  const dataSource = new MockDataSource();
  const wireClient = new WireClientImpl(dataSource);

  let sessionId: string;
  if (opts.session) {
    const existing = dataSource.sessions.get(opts.session);
    if (existing) {
      sessionId = opts.session;
    } else {
      sessionId = dataSource.sessions.create(workDir);
      process.stderr.write(
        `Warning: session "${opts.session}" not found, created new session ${sessionId}\n`,
      );
    }
  } else if (opts.continue) {
    const existing = dataSource.sessions.list(workDir);
    sessionId = existing.length > 0 ? existing[0]!.id : dataSource.sessions.create(workDir);
  } else {
    sessionId = dataSource.sessions.create(workDir);
  }

  return {
    wireClient,
    sessionId,
    model,
    defaultThinking: config.default_thinking,
    theme: config.theme,
  };
}

async function bootstrapCoreShell(opts: CLIOptions): Promise<ShellBootstrap> {
  // 1. Load kimi-core config (~/.kimi/config.toml + project override).
  const workDir = opts.workDir ?? process.cwd();
  const pathConfig = new PathConfig();
  const kimiConfig = loadKimiCoreConfig({ pathConfig, workspaceDir: workDir });

  // 2. Resolve default model → ChatProvider via kosong.
  const modelAlias = opts.model ?? kimiConfig.defaultModel;
  if (modelAlias === undefined || modelAlias === '') {
    throw new Error(
      'No default model configured. Set `default_model` in ~/.kimi/config.toml or pass --model.',
    );
  }
  const provider = createProviderFromConfig(kimiConfig, modelAlias);

  // 3. Resolve the agent spec — Slice 4.1 only uses the built-in default.
  const agentRegistry = new AgentRegistry();
  const agentName = opts.agent ?? 'default';
  const agentSpec = agentRegistry.resolve(agentName);

  // 3b. Slice 4.4 Part 3 — discover filesystem skill roots (builtin is
  //     absent in Slice 4.4; user + project come from ~/.kimi/skills/
  //     and $WORKDIR/.kimi/skills/ respectively). Scanner walks brand
  //     and generic candidates so `.claude/skills` / `.codex/skills`
  //     fall through without the host having to enumerate them.
  //     Parse failures are logged to stderr and the bad skill is
  //     skipped — startup must never block on a malformed SKILL.md.
  const skillManager = new DefaultSkillManager({
    onWarning: (msg, cause) => {
      process.stderr.write(
        `warning: ${msg}${cause instanceof Error ? `: ${cause.message}` : ''}\n`,
      );
    },
  });
  const skillRoots = await resolveSkillRoots({ workDir });
  await skillManager.init(skillRoots);
  const kimiSkills = skillManager.getKimiSkillsDescription();

  const systemPrompt = assembleSystemPrompt(agentSpec, {
    workspaceDir: workDir,
    kimiHome: pathConfig.home,
    kimiSkills,
  });

  // 4. Assemble Runtime — kosong adapter + kosong-backed compaction
  //    + stub journal capability (Slice 4.1 does not exercise compaction).
  const runtime: Runtime = createRuntime({
    kosong: createKosongAdapter({ provider }),
    compactionProvider: createKosongCompactionProvider(provider),
    lifecycle: {
      // SoulPlus overrides this field with its own LifecycleGateFacade,
      // so a throwing placeholder is fine — it would only be invoked if
      // Soul were to call lifecycle through the passed-in Runtime,
      // which never happens in practice (see soul-plus.ts).
      transitionTo: async () => {
        throw new Error('host lifecycle gate should have been overridden by SoulPlus');
      },
    },
    journal: createStubJournalCapability(),
  });

  // 5. SessionManager — real filesystem-backed lifecycle.
  const sessionManager = new SessionManager(pathConfig);

  // 6. Builtin tools — Slice 4.3 injects the full collaboration tool
  //    set. Workspace-scoped tools all get `LocalKaos` + a common
  //    `WorkspaceConfig`; background-execution tools share a single
  //    `BackgroundProcessManager` so `/task list` sees the same
  //    registry; the TODO store is process-local (Slice 3.6 contract).
  //    Web search + URL fetch ship with stub providers that throw a
  //    clear "OAuth required" error — the Moonshot services need OAuth
  //    which is Phase 5 work.
  //
  //    Per-session tools (AskUserQuestion, ExitPlanMode) need
  //    session-local wiring. They are constructed inside `buildTools`
  //    below using closures over the `PerSessionToolContext` supplied
  //    by `KimiCoreClient` — the context delivers the session's
  //    QuestionRuntime, its live permission mode, and its
  //    SessionControl handle.
  // Slice 4.4 Part 4 — MCP server wiring. We look at
  // `kimiConfig.raw.mcp` which carries the untransformed TOML subtree
  // after `loadKimiCoreConfig` preserved it. Absence of any `[mcp]`
  // section (or an empty / malformed one) is NOT a fatal condition —
  // we log and carry on with no MCP tools.
  let mcpManager: MCPManager | undefined;
  const mcpTools: Tool[] = [];
  const mcpConfig = extractMcpConfig(kimiConfig.raw);
  if (mcpConfig !== undefined) {
    try {
      const parsed = parseMcpConfig(mcpConfig);
      mcpManager = new MCPManager({
        config: parsed,
        onNotify: (notif: McpLoadNotification) => {
          if (notif.kind === 'loading') {
            process.stderr.write(`[mcp] ${notif.serverName}: connecting...\n`);
          } else if (notif.kind === 'loaded') {
            process.stderr.write(
              `[mcp] ${notif.serverName}: ${String(notif.toolCount ?? 0)} tools loaded\n`,
            );
          } else {
            process.stderr.write(
              `[mcp] ${notif.serverName}: failed (${notif.error ?? 'unknown error'})\n`,
            );
          }
        },
        onStderr: (server, line) => {
          process.stderr.write(`[mcp:${server}] ${line}\n`);
        },
      });
      await mcpManager.loadAll();
      mcpTools.push(...mcpManager.getTools());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`warning: MCP config invalid, skipping: ${message}\n`);
      if (mcpManager !== undefined) {
        await mcpManager.close();
        mcpManager = undefined;
      }
      if (error instanceof MCPConfigError) {
        // fall through — degraded mode
      }
    }
  }

  const baseWorkspace: WorkspaceConfig = {
    workspaceDir: workDir,
    additionalDirs: [],
  };
  // Slice 4.4 Part 3 — add discovered skill roots to WorkspaceConfig
  // so Phase 1 path-guard lets Read/Glob follow `${KIMI_SKILLS}`
  // pointers into `~/.kimi/skills/<name>/`.
  const workspace = extendWorkspaceWithSkillRoots(baseWorkspace, skillManager.getSkillRoots());
  const backgroundManager = new BackgroundProcessManager();
  const todoStore = new InMemoryTodoStore();
  const stubWebSearch = new StubWebSearchProvider();
  const stubUrlFetcher = new StubUrlFetcher();

  const buildTools = (ctx: PerSessionToolContext): Tool[] => [
    new ReadTool(localKaos, workspace),
    new WriteTool(localKaos, workspace),
    new EditTool(localKaos, workspace),
    new GrepTool(localKaos, workspace),
    new GlobTool(localKaos, workspace),
    new BashTool(localKaos, workDir, backgroundManager),
    new ReadMediaFileTool(localKaos, workspace),
    new ThinkTool(),
    new SetTodoListTool(todoStore),
    new ExitPlanModeTool({
      isPlanModeActive: ctx.isPlanModeActive,
      setPlanMode: ctx.setPlanMode,
    }),
    new AskUserQuestionTool(ctx.questionRuntime, ctx.getPermissionMode),
    // Background-process control surface: BashTool spawns a
    // `KaosProcess` via `backgroundManager` when `run_in_background`
    // is true; these three tools let the LLM list / drain / stop the
    // resulting tasks. All three share the same BackgroundProcessManager
    // instance created above so task ids resolve consistently.
    new TaskListTool(backgroundManager),
    new TaskOutputTool(backgroundManager),
    new TaskStopTool(backgroundManager),
    new WebSearchTool(stubWebSearch),
    new FetchURLTool(stubUrlFetcher),
    ...mcpTools,
  ];

  // 7. Build the client + resolve the initial session. Three branches
  //    mirror `bootstrapOfflineShell`:
  //      --session <id> → resume that session (or throw if missing)
  //      --continue     → resume the most recent session in this workDir,
  //                       or create a new one when none exist
  //      otherwise      → create a new session
  const wireClient = new KimiCoreClient({
    sessionManager,
    runtime,
    model: modelAlias,
    systemPrompt,
    buildTools,
    skillManager,
  });

  let sessionId: string;
  if (opts.session !== undefined) {
    const known = await sessionManager.listSessions();
    const target = known.find((s) => s.session_id === opts.session);
    if (target === undefined) {
      throw new Error(`Session "${opts.session}" not found under ${pathConfig.sessionsDir}.`);
    }
    if (target.workspace_dir !== undefined && target.workspace_dir !== workDir) {
      throw new Error(
        `Session "${opts.session}" belongs to workspace "${target.workspace_dir}", ` +
          `but you are in "${workDir}". Resume from the original project directory.`,
      );
    }
    ({ session_id: sessionId } = await wireClient.resumeSession(opts.session));
  } else if (opts.continue) {
    const known = await sessionManager.listSessions();
    // Slice 4.3 Part 5: filter by current workDir so `--continue` never
    // resumes a session that was created under a different project.
    // Legacy sessions (workspace_dir === undefined) are excluded — the
    // user must resume them explicitly via `--session <id>`.
    const scoped = known.filter((s) => s.workspace_dir === workDir);
    if (scoped.length === 0) {
      throw new Error(
        `No sessions found for workspace "${workDir}". ` +
          'Start a new session without --continue.',
      );
    } else {
      const [latest] = scoped.toSorted((a, b) => b.created_at - a.created_at);
      if (latest === undefined) {
        throw new Error(
          'Unreachable: scoped session list reported non-empty but toSorted returned nothing',
        );
      }
      ({ session_id: sessionId } = await wireClient.resumeSession(latest.session_id));
    }
  } else {
    ({ session_id: sessionId } = await wireClient.createSession(workDir));
  }

  return {
    wireClient,
    sessionId,
    model: modelAlias,
    defaultThinking: kimiConfig.defaultThinking ?? false,
    theme: (kimiConfig.theme as 'dark' | 'light') ?? 'dark',
    ...(mcpManager !== undefined ? { mcpManager } : {}),
  };
}

/**
 * Slice 4.4 Part 4 — extract an MCP config from the raw TOML subtree.
 * We accept both `[mcp.servers.*]` and `[mcp.mcpServers.*]` since
 * users often copy existing `claude_desktop_config.json` layouts. The
 * return value is shaped as `{mcpServers}` so `parseMcpConfig`
 * validates it unchanged.
 */
function extractMcpConfig(raw: Record<string, unknown> | undefined): McpConfig | undefined {
  if (raw === undefined) return undefined;
  const mcp = raw['mcp'];
  if (mcp === undefined || mcp === null || typeof mcp !== 'object') return undefined;
  const mcpObj = mcp as Record<string, unknown>;
  const servers =
    (mcpObj['servers'] as Record<string, unknown> | undefined) ??
    (mcpObj['mcpServers'] as Record<string, unknown> | undefined);
  if (servers === undefined || Object.keys(servers).length === 0) return undefined;
  return { mcpServers: servers } as unknown as McpConfig;
}

async function runShell(opts: CLIOptions, version: string): Promise<void> {
  const bootstrap = opts.offline
    ? await bootstrapOfflineShell(opts)
    : await bootstrapCoreShell(opts);

  const workDir = opts.workDir ?? process.cwd();

  const initialState: AppState = {
    model: bootstrap.model,
    workDir,
    sessionId: bootstrap.sessionId,
    yolo: opts.yolo,
    planMode: opts.plan,
    thinking: opts.thinking ?? bootstrap.defaultThinking,
    contextUsage: 0,
    isStreaming: false,
    streamingPhase: 'idle',
    streamingStartTime: 0,
    theme: bootstrap.theme,
    version,
  };

  const instance = render(
    React.createElement(App, {
      wireClient: bootstrap.wireClient,
      initialState,
    }),
    {
      exitOnCtrlC: false,
      patchConsole: true,
      incrementalRendering: true,
    },
  );

  void instance.waitUntilExit().then(async () => {
    await bootstrap.wireClient.dispose();
    if (bootstrap.mcpManager !== undefined) {
      try {
        await bootstrap.mcpManager.close();
      } catch {
        // MCPManager.close() already logs close errors — swallow so
        // shutdown never hangs on a misbehaving transport.
      }
    }
    process.exit(0);
  });
}

function runPrint(_opts: CLIOptions): void {
  process.stdout.write('Print mode: not yet implemented (Phase 10)\n');
}

function runWire(_opts: CLIOptions): void {
  process.stdout.write('Wire mode: not yet implemented (Phase 11)\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const version = getVersion();

  const program = createProgram(version, (opts) => {
    // -- Validate and resolve UI mode ----------------------------------------
    let uiMode: UIMode;
    try {
      const result = validateOptions(opts);
      uiMode = result.uiMode;
    } catch (error) {
      if (error instanceof OptionConflictError) {
        process.stderr.write(`error: ${error.message}\n`);
        process.exit(1);
      }
      throw error;
    }

    // -- Dispatch to the appropriate runner ----------------------------------
    switch (uiMode) {
      case 'shell':
        void runShell(opts, version).catch((error: unknown) => {
          process.stderr.write(
            `error: failed to start shell: ${error instanceof Error ? error.message : String(error)}\n`,
          );
          process.exit(1);
        });
        break;
      case 'print':
        runPrint(opts);
        break;
      case 'wire':
        runWire(opts);
        break;
    }
  });

  program.parse(process.argv);
}

main();
