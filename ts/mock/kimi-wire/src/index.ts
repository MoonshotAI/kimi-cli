/**
 * @moonshot-ai/kimi-wire-mock
 *
 * Mock data source for kimi-cli development and testing.
 * Provides a MockDataSource that satisfies the DataSource interface
 * consumed by WireClientImpl.
 */

// Wire 2.1 types (lightweight copy for mock independence)
export type {
  WireMessage,
  WireError,
  EventOpts,
  RequestOpts,
  ResponseOpts,
  TurnBeginData,
  TurnEndData,
  StepBeginData,
  StepEndData,
  StepInterruptedData,
  ContentDeltaData,
  ToolCallData,
  ToolResultData,
  StatusUpdateData,
  ApprovalRequestData,
  BriefDisplayBlock,
  DiffDisplayBlock,
  ShellDisplayBlock,
  DisplayBlock,
  SessionInfo,
} from './types.js';
export {
  createEvent,
  createRequest,
  createResponse,
  _resetIdCounter,
} from './types.js';

// Mock data source
export { MockDataSource } from './mock-data-source.js';
export type { MockDataSourceOptions, ScenarioResolver } from './mock-data-source.js';

// Mock event generator
export { MockEventGenerator, evt, req, delay } from './mock-event-generator.js';
export type {
  Scenario,
  ScenarioStep,
  MockEventGeneratorOptions,
} from './mock-event-generator.js';

// Mock session store
export { MockSessionStore } from './mock-session-store.js';

// Pre-built scenarios
export { simpleChatScenario } from './scenarios/simple-chat.js';
export { toolCallScenario } from './scenarios/tool-call.js';
export { approvalScenario, approvalScenarioFlat } from './scenarios/approval.js';
export { thinkingScenario } from './scenarios/thinking.js';
export { btwScenario } from './scenarios/btw.js';
