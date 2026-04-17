/**
 * Phase 9 test-helpers barrel.
 *
 * Tests import everything from here so future refactors in the helper
 * tree stay invisible to callers:
 *
 *   import {
 *     FakeKosongAdapter,
 *     createTestRuntime,
 *     createFullToolset,
 *     createWireE2EHarness,
 *   } from '../helpers/index.js';
 */

// ── Event sink re-export ──────────────────────────────────────────────
// Re-export the existing CollectingEventSink so helper consumers can
// import everything they need from a single barrel (aligns with
// TestRuntimeBundle.events: CollectingEventSink).
export { CollectingEventSink } from '../soul/fixtures/collecting-event-sink.js';

// ── Filesystem ────────────────────────────────────────────────────────
export {
  createTempWorkDir,
  createTempShareDir,
  createTempHomeDir,
  createTempEnv,
  seedFiles,
  type SeedFile,
  type TempDirHandle,
  type TempEnvHandle,
} from './filesystem/temp-work-dir.js';

// ── Kosong adapter ────────────────────────────────────────────────────
export {
  FakeKosongAdapter,
  createTextResponseAdapter,
  createToolCallAdapter,
  type AbortOnTurn,
  type FakeKosongAdapterOptions,
  type KosongErrorInjection,
  type ScriptedToolCall,
  type ScriptedStreaming,
  type ScriptedTurn,
} from './kosong/fake-kosong-adapter.js';
export { resolveDeltaChunks } from './kosong/script-builder.js';

// ── Tool factories + tool-call stubs ──────────────────────────────────
export {
  createAgentTool,
  createAskUserQuestionTool,
  createBashTool,
  createEditTool,
  createEnterPlanModeTool,
  createExitPlanModeTool,
  createFetchURLTool,
  createFullToolset,
  createGlobTool,
  createGrepTool,
  createReadMediaFileTool,
  createReadTool,
  createSetTodoListTool,
  createTaskListTool,
  createTaskOutputTool,
  createTaskStopTool,
  createThinkTool,
  createWebSearchTool,
  createWriteTool,
  type AgentToolOptions,
  type AskUserQuestionToolOptions,
  type BackgroundToolOptions,
  type BashToolFactoryOptions,
  type CreateFullToolsetOptions,
  type EnterPlanModeToolOptions,
  type ExitPlanModeToolOptions,
  type FetchURLToolOptions,
  type SetTodoListToolOptions,
  type ToolFactoryDefaults,
  type WebSearchToolOptions,
} from './tools/tool-factories.js';
export {
  makeAbortSignal,
  makeAbortableSignal,
  makeToolCallStub,
  type AbortableSignal,
  type ToolCallStub,
} from './tools/tool-call-context.js';

// ── Runtime / session / approval / environment ───────────────────────
export * from './runtime/index.js';

// ── Wire harness + message builders + path-replacements ──────────────
export {
  createWireE2EHarness,
  WireFrameQueue,
  type CreateWireE2EHarnessOptions,
  type WireCollectUntilRequestOptions,
  type WireCollectUntilResponseOptions,
  type WireE2EHarness,
  type WireE2EInMemoryHarness,
} from './wire/wire-e2e-harness.js';
export {
  canStartWireSubprocess,
  startWireSubprocess,
  type StartWireSubprocessOptions,
  type WireSubprocessHarness,
} from './wire/wire-subprocess-harness.js';
export {
  buildAgentToolCall,
  buildApprovalResponse,
  buildCancelRequest,
  buildErrorResponse,
  buildHookSubscription,
  buildInitializeRequest,
  buildPromptRequest,
  buildQuestionResponse,
  buildSessionCreateRequest,
  buildSetTodoCall,
  buildShellToolCall,
  buildSteerRequest,
  buildStrReplaceFileCall,
  buildToolResultResponse,
  buildWriteFileCall,
  type ApprovalWireResponse,
  type BuildInitializeOptions,
  type BuildPromptOptions,
  type BuildSessionCreateOptions,
  type BuildToolResultOptions,
  type HookSubscription,
  type ScriptedToolCallBuilder,
} from './wire/wire-message-builder.js';
export {
  normalizeLineEndings,
  normalizePathSeparators,
  normalizeUuids,
  normalizeValue,
  summarizeMessages,
  type NormalizedMessage,
  type PathReplacement,
} from './wire/path-replacements.js';

// ── Multi-process ─────────────────────────────────────────────────────
export {
  spawnInlineWorkers,
  spawnWorkers,
  TimeoutError,
  type SpawnInlineWorkersOptions,
  type SpawnWorkersOptions,
  type SpawnedWorker,
} from './process/multi-process-runner.js';
