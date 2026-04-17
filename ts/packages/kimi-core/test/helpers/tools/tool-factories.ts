/**
 * Tool factory collection — Phase 9 §2.
 *
 * Mirrors the 17 Python tool fixtures in `tests/conftest.py:233-329`.
 * Each factory wires the tool's constructor dependencies from a shared
 * set of defaults (`createFakeKaos()` + `PERMISSIVE_WORKSPACE`) so tests
 * can do `createReadTool()` without repeating boilerplate.
 *
 * Every factory accepts per-tool overrides; `createFullToolset()`
 * assembles a ready-to-use array for SoulPlus.
 */

import type { Kaos } from '@moonshot-ai/kaos';

import {
  AgentTool,
  AskUserQuestionTool,
  AlwaysSkipQuestionRuntime,
  BackgroundProcessManager,
  BashTool,
  EditTool,
  ExitPlanModeTool,
  FetchURLTool,
  GlobTool,
  GrepTool,
  InMemoryTodoStore,
  ReadMediaFileTool,
  ReadTool,
  SetTodoListTool,
  TaskListTool,
  TaskOutputTool,
  TaskStopTool,
  ThinkTool,
  WebSearchTool,
  WriteTool,
} from '../../../src/tools/index.js';
import type {
  ExitPlanModeDeps,
  FetchURLInput,
  QuestionRuntime,
  TodoStore,
  UrlFetcher,
  WebSearchProvider,
  WebSearchResult,
  WorkspaceConfig,
} from '../../../src/tools/index.js';
import { EnterPlanModeTool } from '../../../src/tools/enter-plan-mode.js';
import type { EnterPlanModeDeps } from '../../../src/tools/enter-plan-mode.js';
import type { PermissionMode } from '../../../src/soul-plus/permission/index.js';
import type { Tool } from '../../../src/soul/types.js';
import type { SubagentHost } from '../../../src/soul-plus/subagent-types.js';
import type { AgentTypeRegistry } from '../../../src/soul-plus/agent-type-registry.js';
import {
  createFakeKaos,
  PERMISSIVE_WORKSPACE,
} from '../../tools/fixtures/fake-kaos.js';

export interface ToolFactoryDefaults {
  readonly kaos?: Kaos;
  readonly workspace?: WorkspaceConfig;
}

function resolveKaos(d?: ToolFactoryDefaults): Kaos {
  return d?.kaos ?? createFakeKaos();
}
function resolveWorkspace(d?: ToolFactoryDefaults): WorkspaceConfig {
  return d?.workspace ?? PERMISSIVE_WORKSPACE;
}

// ── File tools ──────────────────────────────────────────────────────────

export function createReadTool(opts?: ToolFactoryDefaults): ReadTool {
  return new ReadTool(resolveKaos(opts), resolveWorkspace(opts));
}

export function createWriteTool(opts?: ToolFactoryDefaults): WriteTool {
  return new WriteTool(resolveKaos(opts), resolveWorkspace(opts));
}

export function createEditTool(opts?: ToolFactoryDefaults): EditTool {
  return new EditTool(resolveKaos(opts), resolveWorkspace(opts));
}

export function createGlobTool(opts?: ToolFactoryDefaults): GlobTool {
  return new GlobTool(resolveKaos(opts), resolveWorkspace(opts));
}

export function createGrepTool(opts?: ToolFactoryDefaults): GrepTool {
  return new GrepTool(resolveKaos(opts), resolveWorkspace(opts));
}

export function createReadMediaFileTool(opts?: ToolFactoryDefaults): ReadMediaFileTool {
  // Phase 14 §3.3 — ReadMediaFileTool now requires a capability set.
  // Test default: both image + video so the tool doesn't SkipThisTool
  // itself out of existence.
  return new ReadMediaFileTool(
    resolveKaos(opts),
    resolveWorkspace(opts),
    new Set(['image_in', 'video_in']),
  );
}

// ── Bash ────────────────────────────────────────────────────────────────

export interface BashToolFactoryOptions extends ToolFactoryDefaults {
  readonly cwd?: string;
  readonly backgroundManager?: BackgroundProcessManager;
}

export function createBashTool(opts?: BashToolFactoryOptions): BashTool {
  return new BashTool(
    resolveKaos(opts),
    opts?.cwd ?? '/workspace',
    opts?.backgroundManager,
  );
}

// ── Pure-compute tools ──────────────────────────────────────────────────

export function createThinkTool(): ThinkTool {
  return new ThinkTool();
}

// ── Plan-mode / todos ───────────────────────────────────────────────────

export interface SetTodoListToolOptions {
  readonly store?: TodoStore;
}
export function createSetTodoListTool(opts?: SetTodoListToolOptions): SetTodoListTool {
  return new SetTodoListTool(opts?.store ?? new InMemoryTodoStore());
}

export interface ExitPlanModeToolOptions {
  readonly deps?: ExitPlanModeDeps;
}
export function createExitPlanModeTool(opts?: ExitPlanModeToolOptions): ExitPlanModeTool {
  const deps = opts?.deps ?? {
    isPlanModeActive: () => true,
    setPlanMode: async () => {
      /* no-op test default */
    },
  };
  return new ExitPlanModeTool(deps);
}

export interface EnterPlanModeToolOptions {
  readonly deps?: EnterPlanModeDeps;
}
export function createEnterPlanModeTool(opts?: EnterPlanModeToolOptions): EnterPlanModeTool {
  const deps: EnterPlanModeDeps = opts?.deps ?? {
    isPlanModeActive: () => false,
    setPlanMode: async () => {
      /* no-op test default */
    },
    isYoloMode: () => true,
    questionRuntime: new AlwaysSkipQuestionRuntime(),
  };
  return new EnterPlanModeTool(deps);
}

// ── AskUserQuestion ─────────────────────────────────────────────────────

export interface AskUserQuestionToolOptions {
  readonly questionRuntime?: QuestionRuntime;
  readonly getPermissionMode?: () => PermissionMode;
}
export function createAskUserQuestionTool(
  opts?: AskUserQuestionToolOptions,
): AskUserQuestionTool {
  return new AskUserQuestionTool(
    opts?.questionRuntime ?? new AlwaysSkipQuestionRuntime(),
    opts?.getPermissionMode ?? ((): PermissionMode => 'default'),
  );
}

// ── Web tools ───────────────────────────────────────────────────────────

export interface WebSearchToolOptions {
  readonly provider?: WebSearchProvider;
}
const emptyWebSearchProvider: WebSearchProvider = {
  async search(
    _query: string,
    _options?: { limit?: number; includeContent?: boolean },
  ): Promise<WebSearchResult[]> {
    return [];
  },
};
export function createWebSearchTool(opts?: WebSearchToolOptions): WebSearchTool {
  return new WebSearchTool(opts?.provider ?? emptyWebSearchProvider);
}

export interface FetchURLToolOptions {
  readonly fetcher?: UrlFetcher;
}
const stubFetcher: UrlFetcher = {
  async fetch(_url: string, _options?: { format?: FetchURLInput['format'] }): Promise<string> {
    return '';
  },
};
export function createFetchURLTool(opts?: FetchURLToolOptions): FetchURLTool {
  return new FetchURLTool(opts?.fetcher ?? stubFetcher);
}

// ── Background task tools ──────────────────────────────────────────────

export interface BackgroundToolOptions {
  readonly manager?: BackgroundProcessManager;
}

function resolveManager(opts?: BackgroundToolOptions): BackgroundProcessManager {
  return opts?.manager ?? new BackgroundProcessManager();
}

export function createTaskListTool(opts?: BackgroundToolOptions): TaskListTool {
  return new TaskListTool(resolveManager(opts));
}
export function createTaskOutputTool(opts?: BackgroundToolOptions): TaskOutputTool {
  return new TaskOutputTool(resolveManager(opts));
}
export function createTaskStopTool(opts?: BackgroundToolOptions): TaskStopTool {
  return new TaskStopTool(resolveManager(opts));
}

// ── Agent tool (subagent spawn) ────────────────────────────────────────

export interface AgentToolOptions {
  readonly host: SubagentHost;
  readonly agentId: string;
  readonly backgroundManager?: BackgroundProcessManager;
  readonly typeRegistry?: AgentTypeRegistry;
}
export function createAgentTool(opts: AgentToolOptions): AgentTool {
  return new AgentTool(
    opts.host,
    opts.agentId,
    opts.backgroundManager,
    opts.typeRegistry,
  );
}

// ── Full toolset ────────────────────────────────────────────────────────

export interface CreateFullToolsetOptions extends ToolFactoryDefaults {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly bashCwd?: string;
  readonly questionRuntime?: QuestionRuntime;
  readonly getPermissionMode?: () => PermissionMode;
  readonly webSearchProvider?: WebSearchProvider;
  readonly urlFetcher?: UrlFetcher;
  readonly todoStore?: TodoStore;
  readonly exitPlanModeDeps?: ExitPlanModeDeps;
  readonly enterPlanModeDeps?: EnterPlanModeDeps;
  readonly backgroundManager?: BackgroundProcessManager;
}

/**
 * Assemble the full builtin toolset (Python `KimiToolset` equivalent).
 * Individual tools can be dropped via `exclude` or narrowed to a subset
 * via `include`. Every tool uses its factory defaults; advanced tests
 * that need custom wiring should build tools individually and pass
 * the composed array directly to `createTestSession({tools})`.
 */
export function createFullToolset(opts?: CreateFullToolsetOptions): readonly Tool[] {
  // Review M6 — one `BackgroundProcessManager` is shared between Bash
  // (spawns background tasks) and the TaskList/Output/Stop trio
  // (observes/controls them). Previously each Task* tool minted its
  // own manager, so Bash-spawned tasks were invisible to TaskOutput.
  const backgroundManager: BackgroundProcessManager =
    opts?.backgroundManager ?? new BackgroundProcessManager();

  const all: readonly Tool[] = [
    createReadTool(opts),
    createWriteTool(opts),
    createEditTool(opts),
    createGlobTool(opts),
    createGrepTool(opts),
    createReadMediaFileTool(opts),
    createBashTool({
      ...opts,
      backgroundManager,
      ...(opts?.bashCwd !== undefined ? { cwd: opts.bashCwd } : {}),
    }),
    createThinkTool(),
    createSetTodoListTool((opts?.todoStore !== undefined ? { store: opts.todoStore } : {})),
    createEnterPlanModeTool((opts?.enterPlanModeDeps !== undefined ? { deps: opts.enterPlanModeDeps } : {})),
    createExitPlanModeTool((opts?.exitPlanModeDeps !== undefined ? { deps: opts.exitPlanModeDeps } : {})),
    createAskUserQuestionTool({
      ...(opts?.questionRuntime !== undefined ? { questionRuntime: opts.questionRuntime } : {}),
      ...(opts?.getPermissionMode !== undefined ? { getPermissionMode: opts.getPermissionMode } : {}),
    }) satisfies Tool,
    createWebSearchTool((opts?.webSearchProvider !== undefined ? { provider: opts.webSearchProvider } : {})),
    createFetchURLTool((opts?.urlFetcher !== undefined ? { fetcher: opts.urlFetcher } : {})),
    createTaskListTool({ manager: backgroundManager }),
    createTaskOutputTool({ manager: backgroundManager }),
    createTaskStopTool({ manager: backgroundManager }),
  ];

  let out: readonly Tool[] = all;
  if (opts?.include !== undefined) {
    const names = new Set(opts.include);
    out = out.filter((t) => names.has(t.name));
  }
  if (opts?.exclude !== undefined) {
    const names = new Set(opts.exclude);
    out = out.filter((t) => !names.has(t.name));
  }
  return out;
}
