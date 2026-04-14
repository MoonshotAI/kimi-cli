/**
 * @moonshot-ai/kimi-wire-mock
 *
 * Mock Wire protocol client for kimi-cli development and testing.
 * Provides a complete WireClient interface with configurable scenarios.
 */

// Wire event types
export type {
  // Content parts
  TextPart,
  ThinkPart,
  ImageURLPart,
  AudioURLPart,
  VideoURLPart,
  ContentPart,
  // Tool types
  ToolCallFunction,
  ToolCall,
  ToolCallPart,
  // Display blocks
  BriefDisplayBlock,
  DiffDisplayBlock,
  ShellDisplayBlock,
  TodoDisplayItem,
  TodoDisplayBlock,
  BackgroundTaskDisplayBlock,
  UnknownDisplayBlock,
  DisplayBlock,
  // Tool result
  ToolReturnValue,
  // Token usage
  TokenUsage,
  // MCP status
  MCPServerSnapshot,
  MCPStatusSnapshot,
  // Lifecycle events
  TurnBeginEvent,
  TurnEndEvent,
  StepBeginEvent,
  StepInterruptedEvent,
  CompactionBeginEvent,
  CompactionEndEvent,
  // Content events
  ContentPartEvent,
  ToolCallEvent,
  ToolCallPartEvent,
  ToolResultEvent,
  // Status events
  StatusUpdateEvent,
  NotificationEvent,
  // Hook events
  HookTriggeredEvent,
  HookResolvedEvent,
  // MCP events
  MCPLoadingBeginEvent,
  MCPLoadingEndEvent,
  // Request events
  ApprovalRequestEvent,
  QuestionOption,
  QuestionItem,
  QuestionRequestEvent,
  HookRequestEvent,
  ToolCallRequestEvent,
  // Response events
  ApprovalResponseEvent,
  // Other events
  SteerInputEvent,
  PlanDisplayEvent,
  BtwBeginEvent,
  BtwEndEvent,
  SubagentEventWrapper,
  // Union type
  WireEvent,
} from './types.js';
export {
  isContentPartEvent,
  isTextContentEvent,
  isThinkContentEvent,
  isRequestEvent,
} from './types.js';

// Client interface
export type {
  WireClient,
  WireClientOptions,
  SessionInfo,
  ApprovalResponsePayload,
} from './client.js';

// Event stream utilities
export {
  EventStreamMerger,
  createCancellableStream,
  mergeEventStream,
} from './event-stream.js';
export type { CancellableStream } from './event-stream.js';

// Mock event generator
export { MockEventGenerator, event, delay } from './mock-event-generator.js';
export type {
  Scenario,
  ScenarioStep,
  MockEventGeneratorOptions,
} from './mock-event-generator.js';

// Mock Wire client
export { MockWireClient } from './mock-wire-client.js';
export type {
  MockWireClientOptions,
  ScenarioResolver,
} from './mock-wire-client.js';

// Mock session store
export { MockSessionStore } from './mock-session-store.js';

// Pre-built scenarios
export { simpleChatScenario } from './scenarios/simple-chat.js';
export { toolCallScenario } from './scenarios/tool-call.js';
export { approvalScenario, approvalScenarioFlat } from './scenarios/approval.js';
export { thinkingScenario } from './scenarios/thinking.js';
export { btwScenario } from './scenarios/btw.js';
