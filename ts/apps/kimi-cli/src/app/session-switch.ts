/**
 * Pure decision logic for `switchSession` — lives separately from
 * `InteractiveMode` so the guards (same-session / streaming / workspace
 * mismatch / unsupported client) can be unit-tested without spinning up
 * a TUI. The caller handles the actual side effects (WireHandler
 * teardown, `resumeSession`, transcript updates) based on the decision.
 */

import type { SessionInfo } from '../wire/methods.js';

export type SessionSwitchDecision =
  | { kind: 'noop'; reason: 'same-session' }
  | { kind: 'error'; reason: 'streaming'; message: string }
  | { kind: 'error'; reason: 'not-found'; message: string }
  | { kind: 'error'; reason: 'workdir-mismatch'; message: string; targetWorkDir: string }
  | { kind: 'error'; reason: 'unsupported'; message: string }
  | { kind: 'proceed'; target: SessionInfo };

export interface SessionSwitchInput {
  currentSessionId: string;
  targetSessionId: string;
  isStreaming: boolean;
  currentWorkDir: string;
  sessions: readonly SessionInfo[];
  clientSupportsResumeSession: boolean;
}

export function decideSessionSwitch(input: SessionSwitchInput): SessionSwitchDecision {
  if (input.targetSessionId === input.currentSessionId) {
    return { kind: 'noop', reason: 'same-session' };
  }
  if (input.isStreaming) {
    return {
      kind: 'error',
      reason: 'streaming',
      message: 'Cannot switch sessions while streaming — press Esc or Ctrl-C first.',
    };
  }
  const target = input.sessions.find((s) => s.id === input.targetSessionId);
  if (target === undefined) {
    return {
      kind: 'error',
      reason: 'not-found',
      message: `Session not found: ${input.targetSessionId}`,
    };
  }
  if (target.work_dir.length > 0 && target.work_dir !== input.currentWorkDir) {
    return {
      kind: 'error',
      reason: 'workdir-mismatch',
      targetWorkDir: target.work_dir,
      message:
        `Session belongs to "${target.work_dir}", but you are in "${input.currentWorkDir}". ` +
        'Restart kimi from that directory to resume.',
    };
  }
  if (!input.clientSupportsResumeSession) {
    return {
      kind: 'error',
      reason: 'unsupported',
      message: 'Session switching not supported on this build.',
    };
  }
  return { kind: 'proceed', target };
}
