/**
 * Hook system barrel (Slice 4) — NOT re-exported from `src/index.ts`.
 *
 * Direct import: `import { HookEngine } from '../../src/hooks/index.js';`
 */

export type {
  AggregatedHookResult,
  CommandHookConfig,
  HookConfig,
  HookEventType,
  HookExecutor,
  HookInput,
  HookInputBase,
  HookResult,
  OnToolFailureInput,
  PostToolUseInput,
  PreToolUseInput,
  WireHookConfig,
} from './types.js';

export { HookEngine } from './engine.js';
export type { HookEngineDeps } from './engine.js';

export { CommandHookExecutor } from './command-executor.js';

export { WireHookExecutor } from './wire-executor.js';
export type { WireHookMessage, WireHookResponse, WireHookSender } from './wire-executor.js';
