/**
 * Covers: Slice 3.6 hook event union extensions.
 *
 * Pins:
 *   - Matcher extraction for each new event type (UserPromptSubmit / Stop /
 *     Notification) feeds the regex with the correct string.
 *   - executeHooks dispatches lifecycle events through the same executor
 *     surface as tool-scoped events.
 *   - getMatchingHooks filters on both event type and matcher regex.
 */

import { describe, expect, it, vi } from 'vitest';

import { HookEngine } from '../../src/hooks/engine.js';
import type {
  HookExecutor,
  HookInput,
  HookResult,
  NotificationInput,
  StopInput,
  UserPromptSubmitInput,
} from '../../src/hooks/types.js';

function makeExecutor(result?: HookResult): {
  executor: HookExecutor;
  execute: ReturnType<typeof vi.fn>;
} {
  const execute = vi.fn().mockResolvedValue(result ?? { ok: true });
  return {
    executor: { type: 'command', execute },
    execute,
  };
}

function makeEngine(executor: HookExecutor): HookEngine {
  return new HookEngine({
    executors: new Map([['command', executor]]),
  });
}

const userPrompt = (prompt: string): UserPromptSubmitInput => ({
  event: 'UserPromptSubmit',
  sessionId: 'sess_1',
  turnId: 'turn_1',
  agentId: 'agent_main',
  prompt,
});

const stop = (reason: 'done' | 'cancelled' | 'error'): StopInput => ({
  event: 'Stop',
  sessionId: 'sess_1',
  turnId: 'turn_1',
  agentId: 'agent_main',
  reason,
});

const notification = (type: string): NotificationInput => ({
  event: 'Notification',
  sessionId: 'sess_1',
  turnId: 'turn_1',
  agentId: 'agent_main',
  notificationType: type,
  title: 't',
  body: 'b',
  severity: 'info',
});

describe('HookEngine lifecycle events (Slice 3.6)', () => {
  it('dispatches UserPromptSubmit and runs the matcher against the prompt text', async () => {
    const { executor, execute } = makeExecutor();
    const engine = makeEngine(executor);
    engine.register({
      type: 'command',
      event: 'UserPromptSubmit',
      command: 'log',
      matcher: '^hello',
    });

    const controller = new AbortController();
    const hitInput = userPrompt('hello world');
    const missInput = userPrompt('goodbye');

    await engine.executeHooks('UserPromptSubmit', hitInput, controller.signal);
    expect(execute).toHaveBeenCalledTimes(1);

    await engine.executeHooks('UserPromptSubmit', missInput, controller.signal);
    // Matcher miss — executor not invoked a second time
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('dispatches Stop and matches on reason string', async () => {
    const { executor, execute } = makeExecutor();
    const engine = makeEngine(executor);
    engine.register({
      type: 'command',
      event: 'Stop',
      command: 'log',
      matcher: '^error$',
    });

    const ctl = new AbortController();
    await engine.executeHooks('Stop', stop('done'), ctl.signal);
    expect(execute).not.toHaveBeenCalled();

    await engine.executeHooks('Stop', stop('error'), ctl.signal);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('dispatches Notification and matches on notificationType', async () => {
    const { executor, execute } = makeExecutor();
    const engine = makeEngine(executor);
    engine.register({
      type: 'command',
      event: 'Notification',
      command: 'log',
      matcher: '^approval\\.',
    });

    const ctl = new AbortController();
    await engine.executeHooks('Notification', notification('tool.progress'), ctl.signal);
    expect(execute).not.toHaveBeenCalled();

    await engine.executeHooks('Notification', notification('approval.request'), ctl.signal);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('getMatchingHooks filters lifecycle events by event type', () => {
    const engine = makeEngine(makeExecutor().executor);
    engine.register({ type: 'command', event: 'PreToolUse', command: 'pre' });
    engine.register({ type: 'command', event: 'UserPromptSubmit', command: 'ups' });
    engine.register({ type: 'command', event: 'Stop', command: 'stop' });

    const input: HookInput = userPrompt('test');
    const matches = engine.getMatchingHooks('UserPromptSubmit', input);
    expect(matches).toHaveLength(1);
    expect((matches[0] as { command: string }).command).toBe('ups');
  });
});
