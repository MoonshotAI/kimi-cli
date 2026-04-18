/**
 * Wire protocol 2.1 barrel (Slice 5).
 */

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
} from './types.js';

export type {
  ImageURLPart,
  TextPart,
  UserInputPart,
  VideoURLPart,
} from './types.js';

export {
  normalizeUserInput,
  PROCESS_SESSION_ID,
  WIRE_PROTOCOL_VERSION,
  WireErrorSchema,
  WireMessageSchema,
} from './types.js';

export { WireCodec } from './codec.js';

export { InvalidWireEnvelopeError, MalformedWireFrameError } from './errors.js';

export { createWireEvent, createWireRequest, createWireResponse } from './message-factory.js';
export type {
  CreateEventOptions,
  CreateRequestOptions,
  CreateResponseOptions,
} from './message-factory.js';

// Phase 17 §A.1 — shared bridge used by the production `--wire`
// runner and the in-memory E2E harness.
export { installWireEventBridge } from './event-bridge.js';
export type {
  InstallWireEventBridgeOptions,
  WireEventBridgeHandle,
  WireEventBridgeTransport,
} from './event-bridge.js';

// Phase 17 §A.4 — central JSON-RPC-style error-code mapping.
export { mapToWireError } from './error-mapping.js';
export type { WireErrorMapping } from './error-mapping.js';

// Phase 17 §A.5 — shared handler registration. Production `--wire`
// runner and the test harness both call this.
export { registerDefaultWireHandlers } from './default-handlers.js';
export type {
  DefaultHandlersDeps,
  DefaultWireHandlersHandle,
} from './default-handlers.js';
