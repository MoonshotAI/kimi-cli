/**
 * v2 SoulPlus barrel — **not** re-exported from `src/index.ts`.
 *
 * Slice 3 keeps SoulPlus independent of the legacy top-level barrel, the
 * same way Slice 2 kept `src/soul/` independent. Slice 5 (Wire + Transport
 * + Router) will promote the v2 SoulPlus stack into `src/index.ts` and
 * retire the `-legacy` directories.
 */

export type {
  DispatchRequest,
  DispatchResponse,
  SessionLifecycleState,
  SoulHandle,
  SoulKey,
  SoulPlusConfig,
  TurnTrigger,
} from './types.js';

export { SessionLifecycleStateMachine } from './lifecycle-state-machine.js';
export { SoulLifecycleGate } from './soul-lifecycle-gate.js';
export { KosongAdapter, createKosongAdapter } from './kosong-adapter.js';
export type { KosongAdapterOptions } from './kosong-adapter.js';
export { SessionEventBus } from './session-event-bus.js';
export type { NotificationListener, SessionEventListener } from './session-event-bus.js';
export { NotificationManager } from './notification-manager.js';
export type {
  EmitInput as NotificationEmitInput,
  EmitResult as NotificationEmitResult,
  LlmDeliverCallback,
  NotificationData,
  NotificationManagerDeps,
  ShellDeliverCallback,
} from './notification-manager.js';
export { SoulRegistry } from './soul-registry.js';
export type { SoulRegistryDeps } from './soul-registry.js';
export {
  createRuntime,
  createStubCompactionProvider,
  createStubJournalCapability,
} from './runtime-factory.js';
export type { RuntimeFactoryDeps } from './runtime-factory.js';
export { TurnManager } from './turn-manager.js';
export type {
  TurnLifecycleEvent,
  TurnLifecycleListener,
  TurnManagerDeps,
  TurnPermissionOverrides,
  TurnState,
} from './turn-manager.js';

// ── Permission subsystem (Slice 2.2) ──────────────────────────────────

export type {
  PermissionMode,
  PermissionRule,
  PermissionRuleDecision,
  PermissionRuleScope,
} from './permission/index.js';
export {
  ApprovalTimeoutError,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  ToolPermissionDeniedError,
  buildBeforeToolCall as buildPermissionBeforeToolCall,
  checkRules,
  globToRegex,
  matchesRule,
  parsePattern,
  withTimeout,
} from './permission/index.js';
export { SoulPlus } from './soul-plus.js';
export type { SoulPlusDeps } from './soul-plus.js';

// ── Phase 18 business errors ─────────────────────────────────────────
export {
  LLMNotSetError,
  LLMCapabilityMismatchError,
  ProviderError,
  SubagentTooDeepError,
  classifyBusinessError,
} from './errors.js';
export type { BusinessErrorMapping } from './errors.js';
export { MAX_SUBAGENT_DEPTH, MAX_SKILL_QUERY_DEPTH } from './subagent-constants.js';

// ── Phase 19 Slice B — capability check ──────────────────────────────
export { checkLLMCapabilities } from './capability-check.js';
export type { LLMCapabilityCheckOptions } from './capability-check.js';
export { TransactionalHandlerRegistry } from './transactional-handler-registry.js';
export type { TransactionalHandler } from './transactional-handler-registry.js';
export { ToolCallOrchestrator } from './orchestrator.js';
export type { ToolCallOrchestratorContext, ToolCallOrchestratorDeps } from './orchestrator.js';

// ── Subagent types (Slice 7) ──────────────────────────────────────────

export type {
  AgentResult,
  SpawnRequest,
  SubagentHandle,
  SubagentHost,
  SubagentStateJson,
  SubagentStatus,
} from './subagent-types.js';

// ── Approval Runtime (Slice 8 stub + Slice 2.3 wired) ────────────────

export type {
  ApprovalRequest,
  ApprovalRequestPayload,
  ApprovalResponseData,
  ApprovalResult,
  ApprovalRuntime,
} from './approval-runtime.js';
// Slice 5 — `ApprovalDisplay` is the SoulPlus-side alias of
// `ToolInputDisplay`; re-export here so callers can import it from a
// single approval-shaped entry point.
export type { ApprovalDisplay } from '../storage/wire-record.js';
export { AlwaysAllowApprovalRuntime, NotImplementedError } from './approval-runtime.js';
export { WiredApprovalRuntime, WIRED_APPROVAL_TIMEOUT_MS } from './wired-approval-runtime.js';
export type { WiredApprovalRuntimeDeps } from './wired-approval-runtime.js';
export {
  InMemoryApprovalStateStore,
  SessionStateApprovalStateStore,
} from './approval-state-store.js';
export type { ApprovalStateStore } from './approval-state-store.js';
export { describeApprovalAction, actionToRulePattern } from './permission/action-label.js';
export { checkRulesDetailed } from './permission/check-rules.js';
export type { CheckRulesResult } from './permission/check-rules.js';

// ── MCP subsystem (Slice 2.6) ─────────────────────────────────────────

export type {
  CallToolOptions as McpCallToolOptions,
  HttpServerConfig,
  MCPClient,
  MCPManagerOptions,
  MCPServerStatus,
  MCPToolDefinition,
  MCPToolResult,
  McpClientFactory,
  McpConfig,
  McpContentBlock,
  McpLoadNotification,
  McpNotifyCallback,
  McpOAuthProviderOptions,
  McpServerConfig,
  McpStderrCallback,
  McpToolAdapterOptions,
  McpToolResultInput,
  OAuthCallbackPayload,
  OAuthCallbackServerHandle,
  OAuthClientProvider,
  StartOAuthCallbackServerOptions,
  StdioServerConfig,
} from './mcp/index.js';
export {
  DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS,
  HttpMcpClient,
  HttpServerConfigSchema,
  MCPConfigError,
  MCPManager,
  MCPRuntimeError,
  MCPTimeoutError,
  MCP_MAX_OUTPUT_CHARS,
  MCP_TOOL_NAME_PREFIX,
  McpConfigSchema,
  McpOAuthProvider,
  McpServerConfigSchema,
  StdioMcpClient,
  StdioServerConfigSchema,
  convertBlock as convertMcpBlock,
  convertMcpToolResult,
  isHttpServer,
  isStdioServer,
  mcpToolName,
  mcpToolToKimiTool,
  parseMcpConfig,
  parseMcpToolName,
  startOAuthCallbackServer,
} from './mcp/index.js';

// ── Session control (Slice 3.2) ───────────────────────────────────

export { DefaultSessionControl } from './session-control.js';
export type { SessionControlHandler, SessionControlDeps } from './session-control.js';

// ── Dynamic injection (Slice 3.6) ─────────────────────────────────────

export {
  DynamicInjectionManager,
  PlanModeInjectionProvider,
  YoloModeInjectionProvider,
  createDefaultDynamicInjectionManager,
} from './dynamic-injection.js';
export type {
  DynamicInjectionManagerDeps,
  DynamicInjectionProvider,
  InjectionContext,
} from './dynamic-injection.js';

// ── Compaction providers (Slice 3.3) ─────────────────────────────────

export { KosongCompactionProvider, createKosongCompactionProvider } from './compaction-provider.js';
export { WiredJournalCapability, createWiredJournalCapability } from './journal-capability.js';
export type { WiredJournalCapabilityDeps } from './journal-capability.js';

// ── Skill subsystem (Slice 2.5) ───────────────────────────────────────

export type {
  DiscoverSkillsOptions,
  ParseSkillFromFileOptions,
  ParsedFrontmatter,
  ResolveSkillRootsOptions,
  SkillActivationContext,
  SkillDefinition,
  SkillManager,
  SkillManagerOptions,
  SkillMetadata,
  SkillRoot,
  SkillSource,
  SkippedByPolicy,
} from './skill/index.js';
export {
  DefaultSkillManager,
  FrontmatterError,
  SkillNotFoundError,
  SkillParseError,
  UnsupportedSkillTypeError,
  buildInlinePrompt,
  discoverSkills,
  extendWorkspaceWithSkillRoots,
  normalizeSkillName,
  parseFrontmatter,
  parseSkillFromFile,
  resolveSkillRoots,
} from './skill/index.js';
