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
} from './session-manager.js';

export { StateCache } from './state-cache.js';
export type { SessionState } from './state-cache.js';

export { projectReplayState } from './replay-projector.js';
export type { ReplayProjectedState } from './replay-projector.js';
