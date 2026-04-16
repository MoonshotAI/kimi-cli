// SDK re-exports a minimal slice of the kimi-core public API.
//
// Phase 4 note: the legacy `CollectingSink`, `runTurn`, and `*Event`
// symbols from the Slice-1 stack are gone — kimi-core now exposes
// `runSoulTurn` plus the `*EventData` wire-protocol payload types.
// The SDK is currently unused by downstream consumers; this file
// re-exports only the stable surface so the workspace typechecks.
export { WIRE_PROTOCOL_VERSION, runSoulTurn } from '@moonshot-ai/core';
export type {
  ContentDeltaEventData,
  EventSink,
  Runtime,
  StepBeginEventData,
  ToolCallEventData,
  ToolResultEventData,
  TurnBeginEventData,
  TurnEndEventData,
  TurnResult,
  WireEvent,
  WireMessage,
} from '@moonshot-ai/core';

// Re-export kosong types that SDK users need
export type {
  ChatProvider,
  Message,
  StreamedMessage,
  StreamedMessagePart,
  Tool,
  Toolset,
  TokenUsage,
} from '@moonshot-ai/kosong';
