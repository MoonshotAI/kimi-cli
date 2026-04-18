/**
 * Wire Protocol 2.1 -- public API surface for the CLI.
 *
 * Re-exports the unified message envelope, event/method payload types,
 * and the WireClient interface.
 */

// Envelope + factory functions
export type {
  WireMessage,
  WireError,
  EventOpts,
  RequestOpts,
  ResponseOpts,
} from './wire-message.js';
export {
  WIRE_PROTOCOL_VERSION,
  createEvent,
  createRequest,
  createResponse,
  createErrorResponse,
  _resetIdCounter,
} from './wire-message.js';

// Event payload types
export type {
  TurnBeginData,
  TurnEndData,
  TurnUsage,
  StepBeginData,
  StepEndData,
  StepInterruptedData,
  ContentDeltaData,
  ToolCallData,
  ToolCallDeltaData,
  ToolProgressData,
  ToolResultData,
  StatusUpdateData,
  SessionMetaChangedData,
  TokenUsage,
  MCPStatus,
  NotificationData,
  ApprovalRequestData,
  QuestionRequestData,
  QuestionRequestItem,
  QuestionRequestOption,
  SessionErrorData,
  CompactionBeginData,
  CompactionEndData,
  MCPLoadingData,
  HookTriggeredData,
  HookResolvedData,
  PlanDisplayData,
  SubagentEventData,
  BriefDisplayBlock,
  DiffDisplayBlock,
  ShellDisplayBlock,
  TodoDisplayItem,
  TodoDisplayBlock,
  BackgroundTaskDisplayBlock,
  DisplayBlock,
  WireEventMethod,
} from './events.js';

// Request/response payload types
export type {
  InitializeParams,
  InitializeResult,
  SessionCreateParams,
  SessionCreateResult,
  SessionInfo,
  SessionListResult,
  SessionForkParams,
  SessionForkResult,
  SessionRenameParams,
  SessionPromptParams,
  SessionPromptResult,
  SessionSteerParams,
  SessionCancelParams,
  SessionResumeParams,
  SessionStatusResult,
  SessionUsageResult,
  SetModelParams,
  SetThinkingParams,
  SetPlanModeParams,
  SetYoloParams,
  ApprovalResponseData,
  QuestionResponseData,
  HookResponseData,
} from './methods.js';

// Client interface
export type {
  WireClient,
  SlashCommandResult,
  SlashCommandStateUpdate,
} from './client.js';
