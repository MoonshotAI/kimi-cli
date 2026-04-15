/**
 * ClientState unit tests.
 */

import { describe, it, expect } from 'vitest';

import {
  createClientState,
  approveForSession,
  isSessionApproved,
  clearSessionApprovals,
} from '../../src/session/client-state.js';

describe('ClientState', () => {
  it('creates with correct defaults', () => {
    const state = createClientState('session-001');
    expect(state.sessionId).toBe('session-001');
    expect(state.sessionApprovals.size).toBe(0);
    expect(state.editorCommand).toBeNull();
  });

  it('records session approvals', () => {
    const state = createClientState('s1');
    approveForSession(state, 'write_file');
    approveForSession(state, 'exec_command');
    expect(isSessionApproved(state, 'write_file')).toBe(true);
    expect(isSessionApproved(state, 'exec_command')).toBe(true);
    expect(isSessionApproved(state, 'read_file')).toBe(false);
  });

  it('does not duplicate approvals', () => {
    const state = createClientState('s1');
    approveForSession(state, 'write_file');
    approveForSession(state, 'write_file');
    expect(state.sessionApprovals.size).toBe(1);
  });

  it('clears all approvals', () => {
    const state = createClientState('s1');
    approveForSession(state, 'write_file');
    approveForSession(state, 'exec_command');
    clearSessionApprovals(state);
    expect(state.sessionApprovals.size).toBe(0);
    expect(isSessionApproved(state, 'write_file')).toBe(false);
  });

  it('allows setting editorCommand', () => {
    const state = createClientState('s1');
    state.editorCommand = 'nvim';
    expect(state.editorCommand).toBe('nvim');
  });
});
