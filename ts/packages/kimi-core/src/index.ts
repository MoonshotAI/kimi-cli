// kimi-core barrel — v2 public API.
//
// Slice 5 replaces the legacy Soul/Wire re-exports with the v2 stack.
// `src/soul-legacy/` and `src/wire-legacy/` have been removed.

// ── Storage (Slice 1) ────────────────────────────────────────────────────
export type { FullContextState, SoulContextState, UserInput } from './storage/context-state.js';
export { InMemoryContextState } from './storage/context-state.js';
export type { SessionJournal } from './storage/session-journal.js';
export { WiredSessionJournalImpl, InMemorySessionJournalImpl } from './storage/session-journal.js';
export type { JournalWriter, LifecycleGate } from './storage/journal-writer.js';
export { WiredJournalWriter, NoopJournalWriter } from './storage/journal-writer.js';
export type { ConversationProjector } from './storage/projector.js';
export { DefaultConversationProjector } from './storage/projector.js';
export { replayWire } from './storage/replay.js';
export type { ReplayResult, ReplayOptions, SessionHealth } from './storage/replay.js';

// ── Soul (Slice 2) ──────────────────────────────────────────────────────
export { runSoulTurn } from './soul/run-turn.js';
export type { EventSink, SoulEvent } from './soul/event-sink.js';
export type {
  AfterToolCallContext,
  AfterToolCallHook,
  AfterToolCallResult,
  AssistantMessage,
  BeforeToolCallContext,
  BeforeToolCallHook,
  BeforeToolCallResult,
  ContentBlock,
  SoulConfig,
  SoulTurnOverrides,
  StopReason,
  TokenUsage,
  Tool,
  ToolCall,
  ToolResult,
  ToolResultContent,
  ToolUpdate,
  TurnResult,
} from './soul/types.js';
export type { Runtime } from './soul/runtime.js';
export { MaxStepsExceededError } from './soul/errors.js';

// ── SoulPlus (Slice 3) ──────────────────────────────────────────────────
export { SoulPlus } from './soul-plus/soul-plus.js';
export type { SoulPlusDeps } from './soul-plus/soul-plus.js';
export type {
  DispatchRequest,
  DispatchResponse,
  SessionLifecycleState,
  SoulHandle,
  SoulKey,
  SoulPlusConfig,
  TurnTrigger,
} from './soul-plus/types.js';
export { SessionLifecycleStateMachine } from './soul-plus/lifecycle-state-machine.js';
export { LifecycleGateFacade } from './soul-plus/lifecycle-gate.js';
export { TurnManager } from './soul-plus/turn-manager.js';
export { SoulRegistry } from './soul-plus/soul-registry.js';
export { TransactionalHandlerRegistry } from './soul-plus/transactional-handler-registry.js';
export { DefaultSessionControl } from './soul-plus/session-control.js';
export type { SessionControlHandler, SessionControlDeps } from './soul-plus/session-control.js';

// ── Tools (Slice 4) ─────────────────────────────────────────────────────
export { ToolRegistry } from './tools/registry.js';
export type { BuiltinTool } from './tools/types.js';
export { AskUserQuestionTool, AskUserQuestionInputSchema } from './tools/ask-user.js';
export type { AskUserQuestionInput } from './tools/ask-user.js';
export { AlwaysSkipQuestionRuntime } from './tools/question-runtime.js';
export type {
  QuestionItem,
  QuestionOption,
  QuestionRequest,
  QuestionResult,
  QuestionRuntime,
} from './tools/question-runtime.js';

// ── Slice 3.5 tools ─────────────────────────────────────────────────────
export { ThinkTool } from './tools/think.js';
export { BackgroundProcessManager } from './tools/background/manager.js';
export { TaskListTool } from './tools/background/task-list.js';
export { TaskOutputTool } from './tools/background/task-output.js';
export { TaskStopTool } from './tools/background/task-stop.js';
export type { BackgroundTaskInfo, BackgroundTaskStatus } from './tools/background/manager.js';
export { WebSearchTool } from './tools/web-search.js';
export type { WebSearchProvider, WebSearchResult } from './tools/web-search.js';
export { FetchURLTool } from './tools/fetch-url.js';
export type { UrlFetcher } from './tools/fetch-url.js';
export { ReadMediaFileTool } from './tools/read-media.js';

// ── Hooks (Slice 4) ─────────────────────────────────────────────────────
export { HookEngine } from './hooks/engine.js';
export type {
  HookConfig,
  HookEventType,
  HookExecutor,
  HookInput,
  AggregatedHookResult,
} from './hooks/types.js';
export { ToolCallOrchestrator } from './soul-plus/orchestrator.js';

// ── Wire Protocol (Slice 5) ────────────────────────────────────────────
export type {
  ChannelType,
  ConfigMethod,
  ContentDeltaEventData,
  ConversationMethod,
  InitializeRequestData,
  InitializeResponseData,
  ManagementMethod,
  ProcessMethod,
  ReverseRpcMethod,
  SessionAddSystemReminderRequestData,
  SessionCancelRequestData,
  SessionCreateRequestData,
  SessionCreateResponseData,
  SessionErrorEventData,
  SessionGetHistoryResponseData,
  SessionGetStatusResponseData,
  SessionListToolsResponseData,
  SessionPromptRequestData,
  SessionPromptResponseData,
  SessionRegisterToolRequestData,
  SessionSetModelRequestData,
  SessionSetPlanModeRequestData,
  SessionSetSystemPromptRequestData,
  SessionSteerRequestData,
  SessionSteerResponseData,
  StatusUpdateEventData,
  StepBeginEventData,
  StepInterruptedEventData,
  ToolCallEventData,
  ToolResultEventData,
  ToolsMethod,
  TurnBeginEventData,
  TurnEndEventData,
  WireError,
  WireEvent,
  WireEventMethod,
  WireMessage,
  WireMethod,
  WireRequest,
  WireResponse,
} from './wire-protocol/index.js';
export {
  PROCESS_SESSION_ID,
  WIRE_PROTOCOL_VERSION,
  WireErrorSchema,
  WireMessageSchema,
  WireCodec,
  createWireEvent,
  createWireRequest,
  createWireResponse,
} from './wire-protocol/index.js';
export type {
  CreateEventOptions,
  CreateRequestOptions,
  CreateResponseOptions,
} from './wire-protocol/index.js';

// ── Transport (Slice 5) ────────────────────────────────────────────────
export type { Transport, TransportServer, TransportState } from './transport/index.js';
export { MemoryTransport, createLinkedTransportPair, StdioTransport } from './transport/index.js';
export type { StdioTransportOptions } from './transport/index.js';

// ── Router (Slice 5) ───────────────────────────────────────────────────
export { RequestRouter } from './router/index.js';
export type { RouteHandler, RequestRouterDeps, SessionManagerLike } from './router/index.js';

// ── Session (Slice 5 / Slice 3.4) ─────────────────────────────────────
export { PathConfig } from './session/index.js';
export { SessionManager } from './session/index.js';
export type {
  CreateSessionOptions,
  ManagedSession,
  ResumeSessionOptions,
  SessionInfo,
} from './session/index.js';
export { StateCache } from './session/index.js';
export type { SessionState } from './session/index.js';
export { projectReplayState } from './session/index.js';
export type { ReplayProjectedState } from './session/index.js';

// ── Migration (Slice 2.7) ──────────────────────────────────────────────
export {
  migratePythonSession,
  MigrationError,
  DEFAULT_TOOL_NAME_MAP,
  mapToolName,
} from './migrate/index.js';
export type { MigratePythonSessionOptions, MigrationResult } from './migrate/index.js';

// ── Agent (Slice 3.1) ───────────────────────────────────────────────────
export type {
  AgentLookup,
  AgentSpec,
  SkillFilter,
  TemplateContext,
  ToolFilter,
} from './agent/index.js';
export {
  AgentInheritanceCycleError,
  AgentNotFoundError,
  AgentRegistry,
  AgentSpecError,
  AgentYamlError,
  DEFAULT_AGENT,
  DEFAULT_SYSTEM_PROMPT,
  applySkillFilter,
  applyToolFilter,
  assembleSystemPrompt,
  expandTemplate,
  loadAgentFile,
  loadSystemPromptFile,
  parseAgentSpec,
  parseAgentYaml,
  resolveInheritance,
} from './agent/index.js';

// ── Config (Slice 3) ─────────────────────────────────────────────────────
export type {
  KimiConfig,
  ModelAlias,
  ProviderConfig,
  ProviderType,
  ThinkingConfig,
  LoadConfigOptions,
  ResolvedModel,
} from './config/index.js';
export {
  KimiConfigSchema,
  ProviderConfigSchema,
  ModelAliasSchema,
  getDefaultConfig,
  loadConfig,
  parseConfigString,
  ConfigError,
  createProvider,
  createProviderFromConfig,
  resolveModelAlias,
  ProviderFactoryError,
} from './config/index.js';
