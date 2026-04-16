/**
 * Session management barrel (Slice 5 / Slice 3.4).
 */

export { PathConfig } from './path-config.js';

export { SessionManager } from './session-manager.js';
export type {
  CreateSessionOptions,
  ManagedSession,
  ResumeSessionOptions,
  SessionInfo,
  SessionStatus,
  SessionUsageTotals,
} from './session-manager.js';

export { StateCache } from './state-cache.js';
export type { SessionState } from './state-cache.js';

export { projectReplayState } from './replay-projector.js';
export type { ReplayProjectedState } from './replay-projector.js';

// Slice 5.1 — usage aggregation primitives (host can wire its own cache).
export {
  aggregateUsage,
  createCachedUsageAggregator,
} from './usage-aggregator.js';
export type {
  CachedAggregatorOptions,
  CachedUsageAggregator,
} from './usage-aggregator.js';
