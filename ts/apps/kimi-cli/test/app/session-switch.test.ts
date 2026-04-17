import { describe, it, expect } from 'vitest';

import { decideSessionSwitch } from '../../src/app/session-switch.js';
import type { SessionInfo } from '../../src/wire/methods.js';

function makeSession(overrides?: Partial<SessionInfo>): SessionInfo {
  return {
    id: 'ses_target',
    work_dir: '/repo/a',
    title: null,
    created_at: 0,
    updated_at: 0,
    archived: false,
    ...overrides,
  };
}

const BASE = {
  currentSessionId: 'ses_current',
  targetSessionId: 'ses_target',
  isStreaming: false,
  currentWorkDir: '/repo/a',
  sessions: [makeSession()],
  clientSupportsResumeSession: true,
};

describe('decideSessionSwitch', () => {
  it('returns noop when selecting the already-active session', () => {
    const decision = decideSessionSwitch({
      ...BASE,
      targetSessionId: 'ses_current',
      sessions: [makeSession({ id: 'ses_current' })],
    });
    expect(decision).toEqual({ kind: 'noop', reason: 'same-session' });
  });

  it('rejects with a streaming error while a turn is in flight', () => {
    const decision = decideSessionSwitch({ ...BASE, isStreaming: true });
    expect(decision.kind).toBe('error');
    if (decision.kind !== 'error') throw new Error('unexpected');
    expect(decision.reason).toBe('streaming');
    expect(decision.message).toMatch(/Esc or Ctrl-C/);
  });

  it('rejects when target session is not in the picker list', () => {
    const decision = decideSessionSwitch({ ...BASE, sessions: [] });
    expect(decision.kind).toBe('error');
    if (decision.kind !== 'error') throw new Error('unexpected');
    expect(decision.reason).toBe('not-found');
    expect(decision.message).toContain('ses_target');
  });

  it('rejects when the target session belongs to a different workspace', () => {
    const decision = decideSessionSwitch({
      ...BASE,
      currentWorkDir: '/repo/a',
      sessions: [makeSession({ work_dir: '/repo/b' })],
    });
    expect(decision.kind).toBe('error');
    if (decision.kind !== 'error') throw new Error('unexpected');
    expect(decision.reason).toBe('workdir-mismatch');
    if (decision.reason !== 'workdir-mismatch') throw new Error('unexpected');
    expect(decision.targetWorkDir).toBe('/repo/b');
    expect(decision.message).toContain('/repo/b');
    expect(decision.message).toContain('/repo/a');
  });

  it('allows switching when the target session has no recorded workspace (legacy)', () => {
    const decision = decideSessionSwitch({
      ...BASE,
      sessions: [makeSession({ work_dir: '' })],
    });
    expect(decision.kind).toBe('proceed');
  });

  it('rejects when the wire client lacks resumeSession support', () => {
    const decision = decideSessionSwitch({ ...BASE, clientSupportsResumeSession: false });
    expect(decision.kind).toBe('error');
    if (decision.kind !== 'error') throw new Error('unexpected');
    expect(decision.reason).toBe('unsupported');
  });

  it('proceeds on a valid matched-workspace switch', () => {
    const target = makeSession({ id: 'ses_target', work_dir: '/repo/a', title: 'Alpha' });
    const decision = decideSessionSwitch({ ...BASE, sessions: [target] });
    expect(decision.kind).toBe('proceed');
    if (decision.kind !== 'proceed') throw new Error('unexpected');
    expect(decision.target.id).toBe('ses_target');
    expect(decision.target.title).toBe('Alpha');
  });

  it('streaming check wins over workdir mismatch', () => {
    const decision = decideSessionSwitch({
      ...BASE,
      isStreaming: true,
      currentWorkDir: '/repo/a',
      sessions: [makeSession({ work_dir: '/repo/b' })],
    });
    expect(decision.kind).toBe('error');
    if (decision.kind !== 'error') throw new Error('unexpected');
    expect(decision.reason).toBe('streaming');
  });
});
