/**
 * kimi-cli entry point.
 *
 * Parses CLI arguments via Commander.js, validates options, determines the
 * UI mode, and dispatches to the appropriate runner (shell / print / wire).
 *
 * In shell mode the Ink 7 TUI is launched with no alternate screen. The
 * shell runner boots a `KimiCoreClient` wrapping `@moonshot-ai/core`.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  AgentRegistry,
  AgentTypeRegistry,
  AskUserQuestionTool,
  BackgroundProcessManager,
  BashTool,
  DefaultSkillManager,
  EditTool,
  EnterPlanModeTool,
  ExitPlanModeTool,
  FetchURLTool,
  FileTokenStorage,
  GlobTool,
  GrepTool,
  InMemoryTodoStore,
  KIMI_CODE_FLOW_CONFIG,
  MCPConfigError,
  MCPManager,
  OAuthManager,
  PathConfig,
  ReadMediaFileTool,
  ReadTool,
  SkipThisTool,
  SessionManager,
  SetTodoListTool,
  TaskListTool,
  TaskOutputTool,
  TaskStopTool,
  ThinkTool,
  WebSearchTool,
  WriteTool,
  applyEnvOverrides,
  assembleSystemPrompt,
  createKosongAdapter,
  createKosongCompactionProvider,
  createProviderFromConfig,
  createRuntime,
  createStubJournalCapability,
  detectEnvironmentFromNode,
  extendWorkspaceWithSkillRoots,
  getBundledAgentYamlPath,
  loadConfig as loadKimiCoreConfig,
  loadSubagentTypes,
  parseMcpConfig,
  resolveSkillRoots,
  getDeviceHeaders,
  setCliVersion,
} from '@moonshot-ai/core';
import type {
  ApprovalRuntime,
  KimiConfig,
  McpConfig,
  McpLoadNotification,
  OAuthResolver,
  Runtime,
  Tool,
  WireMessage,
  WorkspaceConfig,
} from '@moonshot-ai/core';
import { localKaos } from '@moonshot-ai/kaos';

import { InteractiveMode } from './app/InteractiveMode.js';
import type { AppState } from './app/state.js';
import { runPrintMode } from './app/PrintMode.js';
import { createProgram } from './cli/commands.js';
import type { CLIOptions, UIMode } from './cli/options.js';
import { OptionConflictError, validateOptions } from './cli/options.js';
import { LocalFetchURLProvider } from './providers/local-fetch-url.js';
import { MoonshotFetchURLProvider } from './providers/moonshot-fetch-url.js';
import { MoonshotWebSearchProvider } from './providers/moonshot-web-search.js';
import { StubWebSearchProvider } from './providers/stub-web-search.js';
import { getLogger } from './utils/logger.js';
import { pinoToLogger } from './utils/pino-adapter.js';
import type { WireClient } from './wire/client.js';
import { KimiCoreClient } from './wire/kimi-core-client.js';
import type { PerSessionToolContext } from './wire/kimi-core-client.js';
import { join } from 'node:path';

import { runLoginFlow } from './auth/login-flow-tui.js';

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

const __dirname = import.meta.dirname;

function getVersion(): string {
  const pkgPath = resolve(__dirname, '..', 'package.json');
  const pkg: { version: string } = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  return pkg.version;
}

function buildKimiDefaultHeaders(version: string): Record<string, string> {
  setCliVersion(version);
  return {
    'User-Agent': `KimiCLI/${version}`,
    ...getDeviceHeaders(),
  };
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
  maxContextSize: number;
  /**
   * Slice 5.0.1 (M3) — initial yolo state derived from
   * `KIMI_YOLO` / config.yolo / config.defaultYolo. The runner merges
   * with `opts.yolo` (CLI flag) so explicit CLI takes precedence.
   */
  defaultYolo: boolean;
  /** External editor command from config.toml (empty when unset). */
  defaultEditor: string;
  /** All model aliases loaded from config.toml — for /model picker. */
  availableModels: Record<string, import('@moonshot-ai/core').ModelAlias>;
  /**
   * Slice 4.4 Part 4 — optional MCPManager bound to the session; the
   * runner closes it on exit so subprocess transports do not leak.
   */
  mcpManager?: MCPManager | undefined;
  /**
   * Slice 5.0 — OAuth managers for `/logout` slash command. Keyed by
   * provider name; empty map when no OAuth-backed provider is in use.
   */
  oauthManagers?: Map<string, OAuthManager> | undefined;
}

/**
 * Slice 5.0 — determine whether the selected provider needs OAuth and, if so,
 * prepare an OAuthManager + ensure there's a valid token on disk (running
 * the device flow inline if not).
 */
async function ensureOAuthIfNeeded(
  kimiConfig: KimiConfig,
  modelAlias: string,
  pathConfig: PathConfig,
): Promise<{
  oauthResolver: OAuthResolver | undefined;
  managers: Map<string, OAuthManager>;
}> {
  const managers = new Map<string, OAuthManager>();

  // Use the same env-override pass the factory will apply, so KIMI_API_KEY
  // can short-circuit OAuth if the user prefers an explicit key. Pass the
  // requested model so overrides target the *actual* provider in use, not
  // the config default (Slice 5.0.1 M2 fix).
  const effectiveConfig = applyEnvOverrides(kimiConfig, undefined, modelAlias);

  // Resolve which provider would back the requested model.
  const alias = effectiveConfig.models?.[modelAlias];
  const providerName = alias?.provider ?? effectiveConfig.defaultProvider;
  if (providerName === undefined) {
    return { oauthResolver: undefined, managers };
  }

  const providerConfig = effectiveConfig.providers[providerName];
  const needsOAuth =
    providerConfig?.oauth !== undefined &&
    (providerConfig.apiKey === undefined || providerConfig.apiKey === '');
  if (!needsOAuth) {
    return { oauthResolver: undefined, managers };
  }

  // Slice 5.0 MVP: only `managed:kimi-code` uses Device Code Flow with the
  // hard-coded `KIMI_CODE_FLOW_CONFIG`. Adding a second OAuth-backed
  // provider (e.g. another managed: vendor) requires plumbing its
  // OAuthFlowConfig through `providerConfig.oauth.key` lookup. For now,
  // refuse at startup so users see a clear error instead of a silent
  // mis-configured token request.
  if (providerName !== 'managed:kimi-code') {
    throw new Error(
      `OAuth provider "${providerName}" is not yet supported. ` +
      'Slice 5.0 only implements managed:kimi-code; track a follow-up to ' +
      'extend OAuthFlowConfig per-provider.',
    );
  }

  const credentialsDir = join(pathConfig.home, 'credentials');
  const storage = new FileTokenStorage(credentialsDir);
  const manager = new OAuthManager({
    config: KIMI_CODE_FLOW_CONFIG,
    storage,
    // Phase 15 B.2 — thread the kimi home through so proper-lockfile
    // can coordinate concurrent `ensureFresh` across CLI processes
    // under `{home}/oauth/{provider}.lock`.
    configDir: pathConfig.home,
    sleep: (ms) => new Promise((r) => { setTimeout(r, Math.min(ms, 1000)); }),
  });
  managers.set(providerName, manager);

  const hasToken = await manager.hasToken();
  if (!hasToken) {
    await runLoginFlow({ providerName, manager });
  }

  const oauthResolver: OAuthResolver = async (name) => {
    const m = managers.get(name);
    if (m === undefined) {
      throw new Error(`No OAuth manager configured for provider "${name}".`);
    }
    return m.ensureFresh();
  };

  return { oauthResolver, managers };
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

  // 2a. Slice 5.0 — OAuth pre-flight + default headers.
  setCliVersion(getVersion());
  //     the oauthResolver can supply a fresh access token when needed.
  const { oauthResolver, managers: oauthManagers } = await ensureOAuthIfNeeded(
    kimiConfig,
    modelAlias,
    pathConfig,
  );

  const provider = await createProviderFromConfig(kimiConfig, modelAlias, {
    defaultHeaders: buildKimiDefaultHeaders(getVersion()),
    ...(oauthResolver !== undefined ? { oauthResolver } : {}),
  });

  /**
   * Rebuild provider/runtime/compaction for a given model alias. Used by
   * `/model` to swap the live LLM without restarting the process. The
   * closure captures the already-resolved `kimiConfig` + OAuth bits so
   * the picker path does not need to reload config from disk.
   */
  const rebuildRuntimeForModel = async (newModelAlias: string) => {
    const newProvider = await createProviderFromConfig(kimiConfig, newModelAlias, {
      defaultHeaders: buildKimiDefaultHeaders(getVersion()),
      ...(oauthResolver !== undefined ? { oauthResolver } : {}),
    });
    const newRuntime: Runtime = createRuntime({
      kosong: createKosongAdapter({ provider: newProvider }),
    });
    const newCompactionProvider = createKosongCompactionProvider(newProvider);
    const newMaxContextSize =
      kimiConfig.models?.[newModelAlias]?.maxContextSize ?? 200_000;
    return {
      runtime: newRuntime,
      compactionProvider: newCompactionProvider,
      maxContextSize: newMaxContextSize,
    };
  };

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

  // 4. Assemble Runtime + standalone compaction capabilities.
  //    Phase 2: `Runtime` collapsed to `{kosong}`; compactionProvider /
  //    journalCapability now flow into `SessionManager.createSession`
  //    (and `KimiCoreClient` deps) as their own top-level options.
  const runtime: Runtime = createRuntime({
    kosong: createKosongAdapter({ provider }),
  });
  const compactionProvider = createKosongCompactionProvider(provider);
  const journalCapability = createStubJournalCapability();

  // 5. SessionManager — real filesystem-backed lifecycle.
  const sessionManager = new SessionManager(pathConfig);

  // 6. Builtin tools — Slice 4.3 injects the full collaboration tool
  //    set. Workspace-scoped tools all get `LocalKaos` + a common
  //    `WorkspaceConfig`; background-execution tools share a single
  //    `BackgroundProcessManager` so `/task list` sees the same
  //    registry; the TODO store is process-local (Slice 3.6 contract).
  //    Web search uses `MoonshotWebSearchProvider` when the
  //    `managed:kimi-code` OAuth manager is configured, otherwise it
  //    falls back to `StubWebSearchProvider` (no server-side index
  //    without auth). URL fetching always has a `LocalFetchURLProvider`
  //    fallback so the LLM can still read public pages even without
  //    OAuth (Phase 19 Slice A).
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
        logger: pinoToLogger(getLogger()).child({ component: 'mcp-manager' }),
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

  // Slice 5.2 (Codex C2) — bind persistence + reconcile so resume shows
  // previously-running tasks as "lost" rather than silently dropping them.
  // sessionId isn't resolved yet; we defer attach to after session resolve
  // below. The `buildTools` closure captures backgroundManager by ref.
  const todoStore = new InMemoryTodoStore();

  // Phase 19 Slice A — External Tools:
  //  - With `managed:kimi-code` OAuth: use the real Moonshot coding
  //    search + fetch services, falling back to a local extractor when
  //    the fetch service is unreachable.
  //  - Without OAuth: web search surfaces a clear "not configured" error
  //    (matches Python semantics — search requires a server-side index)
  //    while URL fetching silently degrades to a local-only extractor so
  //    the LLM can still read public pages.
  const kimiCodeOAuth = oauthManagers.get('managed:kimi-code');
  const moonshotFetchBase = resolveMoonshotBaseUrl(kimiConfig);
  const hostUserAgent = `kimi-cli/${getVersion()}`;
  const localUrlFetcher = new LocalFetchURLProvider();
  const webSearch = kimiCodeOAuth !== undefined
    ? new MoonshotWebSearchProvider({
        oauthManager: kimiCodeOAuth,
        baseUrl: `${moonshotFetchBase}/search`,
        userAgent: hostUserAgent,
      })
    : new StubWebSearchProvider();
  const urlFetcher = kimiCodeOAuth !== undefined
    ? new MoonshotFetchURLProvider({
        oauthManager: kimiCodeOAuth,
        baseUrl: `${moonshotFetchBase}/fetch`,
        userAgent: hostUserAgent,
        localFallback: localUrlFetcher,
      })
    : localUrlFetcher;

  // Phase 14 §1.2 — resolve the shell Environment once at boot. All
  // per-session ShellTool instances share it so PowerShell vs bash is
  // picked consistently for the whole process.
  const hostEnvironment = await detectEnvironmentFromNode();

  // Phase 14 §3.3 — resolve model-declared capabilities (image_in /
  // video_in). The full capability surface is sessioned per-model in
  // v2, but at boot we only have the default alias, so expose a
  // permissive set derived from the model config when present.
  const defaultCapabilities = new Set<string>(
    kimiConfig.models?.[modelAlias]?.capabilities ?? ['image_in'],
  );

  const buildTools = (ctx: PerSessionToolContext): Tool[] => {
    const tools: Tool[] = [
      new ReadTool(localKaos, workspace),
      new WriteTool(localKaos, workspace),
      new EditTool(localKaos, workspace),
      new GrepTool(localKaos, workspace),
      new GlobTool(localKaos, workspace),
      new BashTool(localKaos, workDir, hostEnvironment, backgroundManager),
    ];
    try {
      tools.push(new ReadMediaFileTool(localKaos, workspace, defaultCapabilities));
    } catch (err) {
      if (!(err instanceof SkipThisTool)) throw err;
    }
    return [
      ...tools,
      new ThinkTool(),
      new SetTodoListTool(todoStore),
      new EnterPlanModeTool({
        isPlanModeActive: ctx.isPlanModeActive,
        setPlanMode: ctx.setPlanMode,
        isYoloMode: () => ctx.getPermissionMode() === 'bypassPermissions',
        questionRuntime: ctx.questionRuntime,
      }),
      new ExitPlanModeTool({
        isPlanModeActive: ctx.isPlanModeActive,
        setPlanMode: ctx.setPlanMode,
      }),
      new AskUserQuestionTool(ctx.questionRuntime, ctx.getPermissionMode),
      new TaskListTool(backgroundManager),
      new TaskOutputTool(backgroundManager),
      new TaskStopTool(backgroundManager),
      new WebSearchTool(webSearch),
      new FetchURLTool(urlFetcher),
      ...mcpTools,
    ];
  };

  // 7. Build the client + resolve the initial session. Three branches
  //    mirror `bootstrapOfflineShell`:
  //      --session <id> → resume that session (or throw if missing)
  //      --continue     → resume the most recent session in this workDir,
  //                       or create a new one when none exist
  //      otherwise      → create a new session
  const maxContextSize = kimiConfig.models?.[modelAlias]?.maxContextSize ?? 200_000;

  // Slice 5.3 — load subagent types from agent.yaml so SessionManager
  // can wire the `Agent` collaboration tool into SoulPlus. Failure
  // modes diverge on whether the user explicitly asked for a file
  // (Python parity — `load_agent` hard-fails on --agent-file):
  //   * `--agent-file <path>` supplied → any load failure is fatal so
  //     the user can't silently end up in "Agent tool disabled" when
  //     they intended a specific agent spec.
  //   * bundled default only → soft-skip with a stderr warning; the
  //     session still boots, just without subagent support (embedder-
  //     cutoff per v2 §10.3.1).
  let agentTypeRegistry: AgentTypeRegistry | undefined;
  try {
    const yamlPath = opts.agentFile ?? (await getBundledAgentYamlPath());
    const types = await loadSubagentTypes(yamlPath);
    const registry = new AgentTypeRegistry();
    for (const def of types) {
      registry.register(def.name, def);
    }
    agentTypeRegistry = registry;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (opts.agentFile !== undefined) {
      throw new Error(`failed to load --agent-file ${opts.agentFile}: ${msg}`);
    }
    process.stderr.write(
      `warning: failed to load bundled subagent types; Agent tool will be disabled: ${msg}\n`,
    );
  }

  const wireClient = new KimiCoreClient({
    sessionManager,
    runtime,
    compactionProvider,
    journalCapability,
    model: modelAlias,
    systemPrompt,
    buildTools,
    skillManager,
    kaos: localKaos,
    config: kimiConfig,
    maxContextSize,
    rebuildRuntimeForModel,
    ...(agentTypeRegistry !== undefined ? { agentTypeRegistry } : {}),
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
      // Codex M4: use last_activity (already sorted desc by listSessions)
      // instead of created_at so --continue resumes the most-recently-USED
      // session, not the most-recently-CREATED one.
      const [latest] = scoped;
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

  // Slice 5.2 (Codex C2) — now that sessionId is resolved, attach
  // persistence and reconcile stale background tasks from disk.
  const sessionDir = pathConfig.sessionDir(sessionId);
  backgroundManager.attachSessionDir(sessionDir);
  await backgroundManager.loadFromDisk();
  const reconcileResult = await backgroundManager.reconcile();
  if (reconcileResult.lost.length > 0) {
    process.stderr.write(
      `[kimi] ${reconcileResult.lost.length} background task(s) from a ` +
        'prior session were lost (process exited). Use /task list to see details.\n',
    );
  }

  // Slice 5.2 (D4) — plan mode management on bootstrap.
  if (opts.session !== undefined || opts.continue) {
    // Resume path: detect conflict between CLI flag and persisted state.
    await wireClient.schedulePlanModeReminder(sessionId, opts.plan === true);
  } else if (opts.plan === true) {
    // Codex C4: fresh session with --plan must activate plan mode in core,
    // not just the TUI state. Without this, TurnManager stays in default
    // mode and the LLM never sees plan-mode dynamic injections.
    await wireClient.setPlanMode(sessionId, true);
  }

  // Yolo mode: sync CLI --yolo / config default into core so
  // TurnManager uses bypassPermissions, not just the TUI label.
  const effectiveYolo = opts.yolo || (kimiConfig.yolo ?? kimiConfig.defaultYolo ?? false);
  if (effectiveYolo) {
    await wireClient.setYolo(sessionId, true);
  }

  return {
    wireClient,
    sessionId,
    model: modelAlias,
    defaultThinking: kimiConfig.defaultThinking ?? false,
    // Slice 5.0.1 (M3): honor KIMI_YOLO (loader writes config.yolo) +
    // config.defaultYolo. CLI --yolo takes precedence in runShell.
    defaultYolo: kimiConfig.yolo ?? kimiConfig.defaultYolo ?? false,
    theme: (kimiConfig.theme as 'dark' | 'light') ?? 'dark',
    defaultEditor: kimiConfig.defaultEditor ?? '',
    availableModels: kimiConfig.models ?? {},
    maxContextSize,
    ...(mcpManager !== undefined ? { mcpManager } : {}),
    ...(oauthManagers.size > 0 ? { oauthManagers } : {}),
  };
}

/**
 * Phase 19 Slice A — derive the Moonshot coding base URL.
 *
 * Priority:
 *   1. `providers['managed:kimi-code'].baseUrl` from config (with any
 *      trailing slash stripped) — lets the user override per-install.
 *   2. `KIMI_CODE_BASE_URL` env var — test / ops hatch.
 *   3. `https://api.kimi.com/coding/v1` — the production default that
 *      mirrors Python `auth/platforms.py::_kimi_code_base_url`.
 *
 * The returned URL is the base; callers append `/search` or `/fetch`.
 */
function resolveMoonshotBaseUrl(kimiConfig: KimiConfig): string {
  const configured = kimiConfig.providers['managed:kimi-code']?.baseUrl;
  const fromEnv = process.env['KIMI_CODE_BASE_URL'];
  const raw =
    configured !== undefined && configured.length > 0
      ? configured
      : fromEnv !== undefined && fromEnv.length > 0
        ? fromEnv
        : 'https://api.kimi.com/coding/v1';
  return raw.replace(/\/+$/, '');
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
  const bootstrap = await bootstrapCoreShell(opts);

  const workDir = opts.workDir ?? process.cwd();

  const initialState: AppState = {
    model: bootstrap.model,
    workDir,
    sessionId: bootstrap.sessionId,
    // Slice 5.0.1 (M3): merge CLI flag with config-derived default.
    yolo: opts.yolo || bootstrap.defaultYolo,
    planMode: opts.plan,
    thinking: opts.thinking ?? bootstrap.defaultThinking,
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: bootstrap.maxContextSize,
    isStreaming: false,
    streamingPhase: 'idle',
    streamingStartTime: 0,
    theme: bootstrap.theme,
    version,
    editorCommand: bootstrap.defaultEditor.length > 0 ? bootstrap.defaultEditor : null,
    availableModels: bootstrap.availableModels,
  };

  const mode = new InteractiveMode(bootstrap.wireClient, initialState, {
    ...(bootstrap.oauthManagers !== undefined ? { oauthManagers: bootstrap.oauthManagers } : {}),
    ...(bootstrap.mcpManager !== undefined ? { mcpManager: bootstrap.mcpManager } : {}),
  });
  mode.onExit = async () => {
    await bootstrap.wireClient.dispose();
    if (bootstrap.mcpManager !== undefined) {
      try {
        await bootstrap.mcpManager.close();
      } catch {
        // MCPManager.close() already logs close errors — swallow so
        // shutdown never hangs on a misbehaving transport.
      }
    }
    process.stderr.write(`\nTo resume this session: kimi -r ${bootstrap.sessionId}\n\n`);
    process.exit(0);
  };
  try { execSync('stty -ixon', { stdio: 'ignore' }); } catch { /* ignore */ }
  mode.start();
}

async function runPrint(opts: CLIOptions): Promise<void> {
  const bootstrap = await bootstrapCoreShell(opts);

  try {
    const exitCode = await runPrintMode({
      wireClient: bootstrap.wireClient,
      sessionId: bootstrap.sessionId,
      prompt: opts.prompt,
      inputFormat: opts.inputFormat ?? 'text',
      outputFormat: opts.outputFormat ?? 'text',
      finalMessageOnly: opts.finalMessageOnly,
    });
    process.exit(exitCode);
  } finally {
    await bootstrap.wireClient.dispose();
    if (bootstrap.mcpManager !== undefined) {
      try {
        await bootstrap.mcpManager.close();
      } catch {
        // Swallow — MCPManager.close() already logs close errors.
      }
    }
  }
}

/**
 * Phase 17 §A.1 / §A.4 / §A.5 — production `--wire` runner.
 *
 * Assembles the same wire surface the in-memory E2E harness uses:
 *   - `StdioTransport` for NDJSON framing
 *   - `RequestRouter` + `registerDefaultWireHandlers` for process /
 *     conversation / management / config / mcp methods
 *   - `installWireEventBridge` forwarding SoulEvents + turn lifecycle
 *     onto the wire
 *   - `mapToWireError` for codec / envelope / zod failures
 *
 * Missing for full prod parity (CLI Phase follow-up): per-session
 * SessionEventBus isolation (today a shared bus drives a single
 * bridge — single-session clients work; multi-session concurrent
 * usage shares frame attribution), OAuth-aware provider swap on
 * `session.setModel`, and MCP tool wiring.
 */
async function runWire(opts: CLIOptions): Promise<void> {
  // Lazy-load core wire machinery only inside this branch so the
  // shell/print code paths don't pay the import cost.
  const core = await import('@moonshot-ai/core');
  const {
    AlwaysAllowApprovalRuntime,
    HookEngine,
    RequestRouter,
    SessionEventBus,
    SessionManager: SessionManagerCtor,
    StdioTransport,
    ToolCallOrchestrator,
    WireCodec,
    createKosongAdapter,
    createRuntime,
    createProviderFromConfig,
    installWireEventBridge,
    loadConfig: loadKimiConfig,
    mapToWireError,
    registerDefaultWireHandlers,
    createWireResponse: makeResponse,
    PathConfig: PathConfigCtor,
  } = core;

  const workDir = opts.workDir ?? process.cwd();
  const pathConfig = new PathConfigCtor();
  const kimiConfig = loadKimiConfig({ pathConfig, workspaceDir: workDir });
  const modelAlias = opts.model ?? kimiConfig.defaultModel;
  if (modelAlias === undefined || modelAlias === '') {
    process.stderr.write(
      'error: --wire requires a default_model in ~/.kimi/config.toml or --model <name>\n',
    );
    process.exit(1);
  }

  setCliVersion(getVersion());
  const { oauthResolver } = await ensureOAuthIfNeeded(
    kimiConfig,
    modelAlias,
    pathConfig,
  );
  const provider = await createProviderFromConfig(kimiConfig, modelAlias, {
    defaultHeaders: buildKimiDefaultHeaders(getVersion()),
    ...(oauthResolver !== undefined ? { oauthResolver } : {}),
  });
  const kosong = createKosongAdapter({ provider });
  const runtime: Runtime = createRuntime({ kosong });

  const sessionManager = new SessionManagerCtor(pathConfig);
  const approval = new AlwaysAllowApprovalRuntime();
  const eventBus = new SessionEventBus();
  const hookEngine = new HookEngine({ executors: new Map(), sink: eventBus });

  // Phase 17 §A.1 / §C.1 — the orchestrator's sessionId closure
  // reads the session id most-recently created through this runner.
  // enforceResultBudget writes tool result archives to
  // `{pathConfig}/sessions/<id>/tool_results/` and must not collapse
  // all sessions into a single `wire-session` directory. Multi-session
  // concurrent tool execution still needs per-session orchestrators —
  // tracked as an explicit CLI Phase follow-up; single-session is the
  // intended production shape right now.
  let activeSessionId: string | undefined;
  const orchestrator = new ToolCallOrchestrator({
    hookEngine,
    sessionId: () => activeSessionId ?? 'session_pending',
    agentId: 'agent_main',
    approvalRuntime: approval,
    pathConfig,
  });

  const router = new RequestRouter({ sessionManager });
  registerDefaultWireHandlers({
    sessionManager,
    router,
    runtime,
    kosong,
    tools: [],
    approval,
    orchestrator,
    eventBus,
    workspaceDir: workDir,
    defaultModel: modelAlias,
    pathConfig,
    // Phase 18 §E.3-E.5 — hand the per-process BPM to wire handlers
    // so `session.getBackgroundTasks` / `stopBackgroundTask` /
    // `getBackgroundTaskOutput` dispatch to live tasks instead of
    // degrading to empty stubs.
    backgroundProcessManager: backgroundManager,
  });

  const transport = new StdioTransport();
  const codec = new WireCodec();

  // Phase 17 §A.1 — per-session WireEventBridge, keyed by sessionId.
  // Each `session.create` spawns a new bridge; `session.destroy`
  // disposes it. Avoids the single-ref aliasing that would let a
  // second session's events clobber the first session's frame
  // attribution.
  const bridgeDisposers = new Map<string, () => void>();

  const originalCreate = sessionManager.createSession.bind(sessionManager);
  (sessionManager as { createSession: typeof sessionManager.createSession }).createSession =
    async (options) => {
      const managed = await originalCreate(options);
      activeSessionId = managed.sessionId;
      // Dispose any stale bridge on the same id (e.g., createSession
      // called twice with the same sessionId from session.resume).
      bridgeDisposers.get(managed.sessionId)?.();
      const handle = installWireEventBridge({
        server: transport,
        eventBus,
        addTurnLifecycleListener: (l) =>
          managed.soulPlus.getTurnManager().addTurnLifecycleListener(l),
        sessionId: managed.sessionId,
      });
      bridgeDisposers.set(managed.sessionId, handle.dispose);
      return managed;
    };

  const originalClose = sessionManager.closeSession.bind(sessionManager);
  (sessionManager as { closeSession: typeof sessionManager.closeSession }).closeSession = async (
    sessionId,
  ) => {
    const disposer = bridgeDisposers.get(sessionId);
    if (disposer !== undefined) {
      disposer();
      bridgeDisposers.delete(sessionId);
    }
    if (activeSessionId === sessionId) {
      activeSessionId = undefined;
    }
    return originalClose(sessionId);
  };

  transport.onMessage = (frame) => {
    void (async () => {
      let msg: WireMessage;
      try {
        msg = codec.decode(frame);
      } catch (decodeError) {
        const mapping = mapToWireError(decodeError);
        try {
          const err = makeResponse({
            requestId: undefined,
            sessionId: '__unknown__',
            error: mapping.error,
          });
          await transport.send(codec.encode(err));
        } catch {
          /* transport closed — ignore */
        }
        return;
      }
      try {
        const response = await router.dispatch(msg, transport);
        if (response !== undefined) {
          await transport.send(codec.encode(response));
        }
      } catch (error) {
        if (msg.type !== 'request') return;
        const mapping = mapToWireError(error);
        const errorResponse = makeResponse({
          requestId: msg.id,
          sessionId: msg.session_id,
          error: mapping.error,
        });
        try {
          await transport.send(codec.encode(errorResponse));
        } catch {
          /* transport closed — ignore */
        }
      }
    })();
  };

  // Phase 17 §A.1 — graceful shutdown on stdin EOF. Close every active
  // session (each closeSession drains + closes its JournalWriter) before
  // exiting so the last batch of wire records lands on disk. Bridges
  // dispose as a side-effect of the patched closeSession above.
  transport.onClose = () => {
    void (async () => {
      const openIds = [...bridgeDisposers.keys()];
      for (const sid of openIds) {
        try {
          await sessionManager.closeSession(sid);
        } catch {
          /* keep going — best-effort drain on EOF */
        }
      }
      process.exit(0);
    })();
  };

  await transport.connect();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const version = getVersion();

  const program = createProgram(version, (opts) => {
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
        void runPrint(opts).catch((error: unknown) => {
          process.stderr.write(
            `error: failed to start print mode: ${error instanceof Error ? error.message : String(error)}\n`,
          );
          process.exit(1);
        });
        break;
      case 'wire':
        void runWire(opts).catch((error: unknown) => {
          process.stderr.write(
            `error: wire runner failed: ${error instanceof Error ? error.message : String(error)}\n`,
          );
          process.exit(1);
        });
        break;
    }
  });

  program.parse(process.argv);
}

main();
