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
export { atomicWrite } from './storage/atomic-write.js';
// Phase 22 — producer identity (host bootstrap injects via setProducerInfo).
export { setProducerInfo, getProducerInfo } from './storage/producer-info.js';
export type { WireProducer } from './storage/wire-record.js';
export { UnsupportedProducerError } from './storage/errors.js';

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
export type {
  CompactionBoundaryRecord,
  CompactionOptions,
  CompactionProvider,
  JournalCapability,
  RotateResult,
  Runtime,
  SummaryMessage as RuntimeSummaryMessage,
} from './soul/runtime.js';
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
export { SoulLifecycleGate } from './soul-plus/soul-lifecycle-gate.js';
export { TurnManager } from './soul-plus/turn-manager.js';
export { SoulRegistry } from './soul-plus/soul-registry.js';
export { TransactionalHandlerRegistry } from './soul-plus/transactional-handler-registry.js';
export { DefaultSessionControl } from './soul-plus/session-control.js';
export type { SessionControlHandler, SessionControlDeps } from './soul-plus/session-control.js';
export { KosongAdapter, createKosongAdapter } from './soul-plus/kosong-adapter.js';
export type { KosongAdapterOptions } from './soul-plus/kosong-adapter.js';
export {
  createRuntime,
  createStubCompactionProvider,
  createStubJournalCapability,
} from './soul-plus/runtime-factory.js';
export type { RuntimeFactoryDeps } from './soul-plus/runtime-factory.js';
export {
  KosongCompactionProvider,
  createKosongCompactionProvider,
} from './soul-plus/compaction-provider.js';
export {
  WiredJournalCapability,
  createWiredJournalCapability,
} from './soul-plus/journal-capability.js';
export type { WiredJournalCapabilityDeps } from './soul-plus/journal-capability.js';
export { SessionEventBus } from './soul-plus/session-event-bus.js';
export type {
  SessionEventListener,
  NotificationListener,
  BusEvent,
  EventSource,
} from './soul-plus/session-event-bus.js';
export { NotificationManager } from './soul-plus/notification-manager.js';
export type {
  NotificationData,
  NotificationManagerDeps,
  ShellDeliverCallback,
  LlmDeliverCallback,
  EmitInput as NotificationEmitInput,
  EmitResult as NotificationEmitResult,
} from './soul-plus/notification-manager.js';
export { AlwaysAllowApprovalRuntime, NotImplementedError } from './soul-plus/approval-runtime.js';
export type {
  ApprovalRequest,
  ApprovalRequestPayload,
  ApprovalResponseData,
  ApprovalResult,
  ApprovalRuntime,
} from './soul-plus/approval-runtime.js';
export { WiredApprovalRuntime } from './soul-plus/wired-approval-runtime.js';
export type { WiredApprovalRuntimeDeps } from './soul-plus/wired-approval-runtime.js';
export type { TurnLifecycleEvent, TurnLifecycleListener } from './soul-plus/turn-manager.js';
export type { ApprovalDisplay, ApprovalSource } from './storage/wire-record.js';

// ── Permission (Slice 4) ────────────────────────────────────────────────
export type { PermissionMode, PermissionRule } from './soul-plus/permission/index.js';
export { actionToRulePattern, describeApprovalAction } from './soul-plus/permission/action-label.js';

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
export type { Capability, ImageSizeExtractor } from './tools/read-media.js';

// ── Phase 14 — skip-tool sentinel + file-type detection + env probe ──
export { SkipThisTool } from './tools/skip-this-tool.js';
export {
  MEDIA_SNIFF_BYTES,
  IMAGE_MIME_BY_SUFFIX,
  VIDEO_MIME_BY_SUFFIX,
  NON_TEXT_SUFFIXES,
  sniffMediaFromMagic,
  detectFileType,
} from './tools/file-type.js';
export type { FileType } from './tools/file-type.js';
export { detectEnvironment, detectEnvironmentFromNode } from './utils/environment.js';
export type { Environment, EnvironmentDeps, OsKind, ShellName } from './utils/environment.js';
export { consoleLogger, noopLogger } from './utils/logger.js';
export type { Logger } from './utils/logger.js';

// ── Slice 4.3 tools (host-injected collaboration set) ─────────────────
export { ReadTool } from './tools/read.js';
export { WriteTool } from './tools/write.js';
export { EditTool } from './tools/edit.js';
export { BashTool } from './tools/bash.js';
export { GrepTool } from './tools/grep.js';
export { GlobTool } from './tools/glob.js';
export { SetTodoListTool, InMemoryTodoStore } from './tools/set-todo-list.js';
export type { TodoStore, TodoItem, TodoStatus } from './tools/set-todo-list.js';
export { ExitPlanModeTool } from './tools/exit-plan-mode.js';
export type { ExitPlanModeDeps } from './tools/exit-plan-mode.js';
export type { WorkspaceConfig } from './tools/workspace.js';
export {
  discoverMonorepoSiblings,
  extendWorkspaceWithMonorepoSiblings,
} from './tools/workspace-monorepo.js';
export type { MonorepoDiscoveryResult } from './tools/workspace-monorepo.js';

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
export { parseHookConfigs } from './hooks/config-loader.js';
export { CommandHookExecutor } from './hooks/command-executor.js';

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

// Phase 17 §A.1 / §A.4 / §A.5 — shared wire machinery used by the
// production `apps/kimi-cli --wire` runner AND the in-memory test
// harness so both call into the same handler registrations.
export {
  installWireEventBridge,
  mapToWireError,
  registerDefaultWireHandlers,
} from './wire-protocol/index.js';
export type {
  DefaultHandlersDeps,
  InstallWireEventBridgeOptions,
  WireErrorMapping,
  WireEventBridgeHandle,
  WireEventBridgeTransport,
} from './wire-protocol/index.js';

// ── Transport (Slice 5) ────────────────────────────────────────────────
export type { Transport, TransportServer, TransportState } from './transport/index.js';
export { MemoryTransport, createLinkedTransportPair, StdioTransport } from './transport/index.js';
export type { StdioTransportOptions } from './transport/index.js';

// ── Router (Slice 5) ───────────────────────────────────────────────────
export { RequestRouter } from './router/index.js';
export type { RouteHandler, RequestRouterDeps, SessionManagerLike } from './router/index.js';

// ── Session (Slice 5 / Slice 3.4 / Slice 5.1) ────────────────────────
export { PathConfig } from './session/index.js';
export { SessionManager } from './session/index.js';
export type {
  CreateSessionOptions,
  ManagedSession,
  ResumeSessionOptions,
  SessionInfo,
  SessionStatus,
  SessionUsageTotals,
} from './session/index.js';
export { StateCache } from './session/index.js';
export type { SessionState } from './session/index.js';
export { projectReplayState } from './session/index.js';
export type { ReplayProjectedState } from './session/index.js';
export {
  aggregateUsage,
  createCachedUsageAggregator,
} from './session/index.js';
export type {
  CachedAggregatorOptions,
  CachedUsageAggregator,
} from './session/index.js';

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

// ── Skill subsystem (Slice 2.5) ──────────────────────────────────────
export type {
  SkillActivationContext,
  SkillDefinition,
  SkillManager,
  SkillManagerOptions,
  SkillMetadata,
  SkillRoot,
  SkillSource,
  SkippedByPolicy,
} from './soul-plus/skill/index.js';
export {
  DefaultSkillManager,
  SkillNotFoundError,
  SkillParseError,
  UnsupportedSkillTypeError,
  FrontmatterError,
  discoverSkills,
  extendWorkspaceWithSkillRoots,
  normalizeSkillName,
  resolveSkillRoots,
} from './soul-plus/skill/index.js';

// ── MCP subsystem (Slice 2.6 + Phase 19 Slice D OAuth) ──────────────
export type {
  HttpServerConfig,
  McpConfig,
  McpServerConfig,
  McpClientFactory,
  McpLoadNotification,
  McpNotifyCallback,
  McpOAuthProviderOptions,
  McpStderrCallback,
  MCPClient,
  MCPManagerOptions,
  MCPServerStatus,
  MCPToolDefinition,
  MCPToolResult,
  OAuthCallbackPayload,
  OAuthCallbackServerHandle,
  OAuthClientProvider,
  StartOAuthCallbackServerOptions,
  StdioServerConfig,
} from './soul-plus/mcp/index.js';
export {
  HttpMcpClient,
  MCPConfigError,
  MCPManager,
  MCPRuntimeError,
  MCPTimeoutError,
  McpOAuthProvider,
  StdioMcpClient,
  isHttpServer,
  isStdioServer,
  mcpToolName,
  mergeMcpConfigs,
  parseMcpConfig,
  parseMcpToolName,
  startOAuthCallbackServer,
} from './soul-plus/mcp/index.js';

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
  applyEnvOverrides,
  transformTomlData,
} from './config/index.js';
export type { OAuthResolver, ProviderFactoryDeps } from './config/index.js';

// ── Subagent (Slice 5.3) ────────────────────────────────────────────────
export { SubagentStore } from './soul-plus/subagent-store.js';
export type { SubagentInstanceRecord, CreateInstanceOpts } from './soul-plus/subagent-store.js';
export { AgentTypeRegistry } from './soul-plus/agent-type-registry.js';
export type { AgentTypeDefinition } from './soul-plus/agent-type-registry.js';
export {
  DEFAULT_AGENT_SPEC_VERSION,
  SUPPORTED_AGENT_SPEC_VERSIONS,
  loadAgentSpec,
  loadSubagentTypes,
  getBundledAgentYamlPath,
} from './soul-plus/agent-yaml-loader.js';
export type { ResolvedAgentSpec } from './soul-plus/agent-yaml-loader.js';
export { runSubagentTurn, cleanupStaleSubagents } from './soul-plus/subagent-runner.js';
export type { SubagentRunnerDeps } from './soul-plus/subagent-runner.js';
export { AgentTool } from './tools/agent.js';
export type { AgentToolInput, AgentToolOutput } from './tools/agent.js';
export { EnterPlanModeTool, EnterPlanModeInputSchema } from './tools/enter-plan-mode.js';
export type { EnterPlanModeInput, EnterPlanModeDeps } from './tools/enter-plan-mode.js';

// ── Auth (Slice 5.0) ────────────────────────────────────────────────────
export * from './auth/index.js';
