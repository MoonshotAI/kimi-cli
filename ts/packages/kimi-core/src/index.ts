// Legacy Soul / Wire re-exports (scheduled for removal in Slice 5).
// Slice 2's v2 Soul lives in `src/soul/` and is **not** re-exported here on
// purpose — new call sites should import v2 Soul directly from the module
// path while Slice 5 finishes clearing out the legacy layer.
export { CollectingSink, runTurn } from './soul-legacy/index.js';
export type {
  EventSink,
  Runtime,
  StatusSnapshot,
  StepResult,
  TurnResult,
} from './soul-legacy/index.js';

export { createEventEnvelope, WIRE_PROTOCOL_VERSION } from './wire-legacy/index.js';
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
} from './wire-legacy/index.js';
