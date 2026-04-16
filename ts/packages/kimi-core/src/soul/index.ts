/**
 * v2 Soul barrel — **not** re-exported from the package-level `src/index.ts`
 * during Slice 2 (legacy Soul / Wire still occupy the top-level barrel).
 * New call sites and Slice 2 tests must import directly from this module:
 *
 *   import { runSoulTurn } from '../../src/soul/index.js';
 *
 * Slice 5 (Wire + Transport + Router) will promote v2 Soul into the
 * top-level barrel and delete `src/soul-legacy/` + `src/wire-legacy/`.
 */

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
  ToolDisplayHooks,
  ToolInputDisplay,
  ToolResult,
  ToolResultContent,
  ToolResultDisplay,
  ToolUpdate,
  TurnResult,
  UserInput,
} from './types.js';

export { ToolInputDisplaySchema, ToolResultDisplaySchema } from './types.js';

export type { EventSink, SoulEvent } from './event-sink.js';

export type {
  ChatParams,
  ChatResponse,
  CompactionBoundaryRecord,
  CompactionOptions,
  CompactionProvider,
  JournalCapability,
  KosongAdapter,
  LifecycleGate,
  LLMToolDefinition,
  RotateResult,
  Runtime,
  SummaryMessage,
} from './runtime.js';

export { ContextOverflowError, MaxStepsExceededError } from './errors.js';

export { runSoulTurn } from './run-turn.js';

export type { CompactionConfig } from './compaction.js';
// Phase 2 (todo/phase-2-compaction-out-of-soul.md): `runCompaction` is
// removed. Soul no longer executes compaction — the equivalent pipeline
// now lives on `TurnManager.executeCompaction` in `src/soul-plus/`.
export {
  DEFAULT_RESERVED_CONTEXT_SIZE,
  DEFAULT_TRIGGER_RATIO,
  estimateTokens,
  shouldCompact,
} from './compaction.js';
