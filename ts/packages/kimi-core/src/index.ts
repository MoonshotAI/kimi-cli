// Soul layer
export { CollectingSink, runTurn } from './soul/index.js';
export type { EventSink, Runtime, StatusSnapshot, StepResult, TurnResult } from './soul/index.js';

// Wire protocol
export { createEventEnvelope, WIRE_PROTOCOL_VERSION } from './wire/index.js';
export type {
  ContentDeltaEvent,
  SessionErrorEvent,
  StepBeginEvent,
  StepEndEvent,
  ToolCallEvent,
  ToolResultEvent,
  TurnBeginEvent,
  TurnEndEvent,
  WireEvent,
  WireMessageEnvelope,
} from './wire/index.js';
