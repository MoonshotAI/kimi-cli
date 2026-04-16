/**
 * Tool system barrel (Slice 4) — NOT re-exported from `src/index.ts`.
 *
 * Direct import: `import { ToolRegistry, ReadTool } from '../../src/tools/index.js';`
 */

// ── Type definitions + schemas ─────────────────────────────────────────

export type {
  BuiltinTool,
  ReadInput,
  ReadOutput,
  WriteInput,
  WriteOutput,
  EditInput,
  EditOutput,
  BashInput,
  BashOutput,
  GrepInput,
  GrepOutput,
  GlobInput,
  GlobOutput,
} from './types.js';

export {
  ReadInputSchema,
  ReadOutputSchema,
  WriteInputSchema,
  WriteOutputSchema,
  EditInputSchema,
  EditOutputSchema,
  BashInputSchema,
  BashOutputSchema,
  GrepInputSchema,
  GrepOutputSchema,
  GlobInputSchema,
  GlobOutputSchema,
} from './types.js';

// ── Registry ───────────────────────────────────────────────────────────

export { ToolRegistry } from './registry.js';
export type { ToolSource, ToolConflict, ToolRegistryOptions } from './registry.js';

// ── Display defaults + size constants (Slice 5 / 决策 #96 / #98) ───────

export {
  DEFAULT_BUILTIN_MAX_RESULT_CHARS,
  DEFAULT_MCP_MAX_RESULT_CHARS,
  defaultGetActivityDescription,
  defaultGetCollapsedSummary,
  defaultGetInputDisplay,
  defaultGetProgressDescription,
  defaultGetResultDisplay,
  defaultGetUserFacingName,
} from './display-defaults.js';

// ── Workspace + path safety (§14.3 D11) ────────────────────────────────

export type { WorkspaceConfig } from './workspace.js';
export {
  PathSecurityError,
  assertPathAllowed,
  canonicalizePath,
  isWithinDirectory,
  isWithinWorkspace,
} from './path-guard.js';
export type { PathSecurityCode, AssertPathOptions } from './path-guard.js';
export { isSensitiveFile } from './sensitive.js';

// ── Built-in tools ─────────────────────────────────────────────────────

export { ReadTool } from './read.js';
export { WriteTool } from './write.js';
export { EditTool } from './edit.js';
export { BashTool } from './bash.js';
export { GrepTool } from './grep.js';
export { GlobTool, MAX_MATCHES as GLOB_MAX_MATCHES } from './glob.js';

// ── Collaboration tools (Slice 7) ─────────────────────────────────────

export { AgentTool, AgentToolInputSchema, AgentToolOutputSchema } from './agent.js';
export type { AgentToolInput, AgentToolOutput } from './agent.js';

// ── AskUserQuestion tool (Slice 3.2) ──────────────────────────────────

export { AskUserQuestionTool, AskUserQuestionInputSchema } from './ask-user.js';
export type { AskUserQuestionInput } from './ask-user.js';
export { AlwaysSkipQuestionRuntime } from './question-runtime.js';
export type {
  QuestionItem,
  QuestionOption,
  QuestionRequest,
  QuestionResult,
  QuestionRuntime,
} from './question-runtime.js';

// ── Think tool (Slice 3.5) ────────────────────────────────────────────

export { ThinkTool, ThinkInputSchema } from './think.js';
export type { ThinkInput } from './think.js';

// ── Background task tools (Slice 3.5) ─────────────────────────────────

export {
  BackgroundProcessManager,
  TaskListTool,
  TaskListInputSchema,
  TaskOutputTool,
  TaskOutputInputSchema,
  TaskStopTool,
  TaskStopInputSchema,
} from './background/index.js';
export type {
  BackgroundTaskInfo,
  BackgroundTaskStatus,
  TaskListInput,
  TaskOutputInput,
  TaskStopInput,
} from './background/index.js';

// ── Host-injected web tools (Slice 3.5) ───────────────────────────────

export { WebSearchTool, WebSearchInputSchema } from './web-search.js';
export type { WebSearchInput, WebSearchProvider, WebSearchResult } from './web-search.js';
export { FetchURLTool, FetchURLInputSchema } from './fetch-url.js';
export type { FetchURLInput, UrlFetcher } from './fetch-url.js';

// ── ReadMediaFile tool (Slice 3.5) ────────────────────────────────────

export { ReadMediaFileTool, ReadMediaFileInputSchema } from './read-media.js';
export type { ReadMediaFileInput } from './read-media.js';

// ── Plan-mode tools (Slice 3.6) ───────────────────────────────────────

export { SetTodoListTool, SetTodoListInputSchema, InMemoryTodoStore } from './set-todo-list.js';
export type { SetTodoListInput, TodoItem, TodoStatus, TodoStore } from './set-todo-list.js';

export { ExitPlanModeTool, ExitPlanModeInputSchema } from './exit-plan-mode.js';
export type { ExitPlanModeInput, ExitPlanModeDeps } from './exit-plan-mode.js';
