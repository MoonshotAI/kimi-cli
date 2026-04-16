/**
 * Hook config loader tests — parse [[hooks]] from KimiConfig.
 */

import { describe, expect, it, vi } from 'vitest';

import { parseHookConfigs } from '../../src/hooks/config-loader.js';

describe('parseHookConfigs', () => {
  it('returns empty array for undefined input', () => {
    // oxlint-disable-next-line unicorn/no-useless-undefined
    expect(parseHookConfigs(undefined)).toEqual([]);
  });

  it('returns empty array for empty array', () => {
    expect(parseHookConfigs([])).toEqual([]);
  });

  it('parses a valid hook entry', () => {
    const hooks = parseHookConfigs([
      { event: 'PreToolUse', command: 'my-hook.sh', matcher: 'Bash', timeout: 10 },
    ]);
    expect(hooks).toHaveLength(1);
    expect(hooks[0]!.type).toBe('command');
    expect(hooks[0]!.event).toBe('PreToolUse');
    expect(hooks[0]!.command).toBe('my-hook.sh');
    expect(hooks[0]!.matcher).toBe('Bash');
    expect(hooks[0]!.timeoutMs).toBe(10_000);
  });

  it('uses default timeout when not specified', () => {
    const hooks = parseHookConfigs([
      { event: 'Stop', command: 'on-stop.sh' },
    ]);
    expect(hooks[0]!.timeoutMs).toBe(30_000);
  });

  it('omits matcher when not specified', () => {
    const hooks = parseHookConfigs([
      { event: 'PostToolUse', command: 'post.sh' },
    ]);
    expect(hooks[0]!.matcher).toBeUndefined();
  });

  it('skips entry with invalid event and warns', () => {
    const onWarning = vi.fn();
    const hooks = parseHookConfigs(
      [{ event: 'InvalidEvent', command: 'bad.sh' }],
      onWarning,
    );
    expect(hooks).toHaveLength(0);
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('invalid event'));
  });

  it('skips entry with missing command and warns', () => {
    const onWarning = vi.fn();
    const hooks = parseHookConfigs(
      [{ event: 'PreToolUse' }],
      onWarning,
    );
    expect(hooks).toHaveLength(0);
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('command'));
  });

  it('skips non-object entries and warns', () => {
    const onWarning = vi.fn();
    const hooks = parseHookConfigs(['not-an-object', 42, null], onWarning);
    expect(hooks).toHaveLength(0);
    expect(onWarning).toHaveBeenCalledTimes(3);
  });

  it('warns on out-of-range timeout but still uses default', () => {
    const onWarning = vi.fn();
    const hooks = parseHookConfigs(
      [{ event: 'Stop', command: 'x.sh', timeout: 9999 }],
      onWarning,
    );
    expect(hooks).toHaveLength(1);
    expect(hooks[0]!.timeoutMs).toBe(30_000);
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('out of range'));
  });

  it('parses multiple valid hooks', () => {
    const hooks = parseHookConfigs([
      { event: 'PreToolUse', command: 'pre.sh' },
      { event: 'PostToolUse', command: 'post.sh', matcher: 'Write' },
      { event: 'SubagentStart', command: 'agent-hook.sh', matcher: 'coder' },
    ]);
    expect(hooks).toHaveLength(3);
    expect(hooks.map(h => h.event)).toEqual(['PreToolUse', 'PostToolUse', 'SubagentStart']);
  });

  it('accepts all 13 event types', () => {
    const events = [
      'PreToolUse', 'PostToolUse', 'OnToolFailure',
      'UserPromptSubmit', 'Stop', 'StopFailure', 'Notification',
      'SubagentStart', 'SubagentStop',
      'SessionStart', 'SessionEnd',
      'PreCompact', 'PostCompact',
    ];
    const raw = events.map(e => ({ event: e, command: `hook-${e}.sh` }));
    const hooks = parseHookConfigs(raw);
    expect(hooks).toHaveLength(13);
  });

  it('trims whitespace from command', () => {
    const hooks = parseHookConfigs([
      { event: 'Stop', command: '  my-hook.sh  ' },
    ]);
    expect(hooks[0]!.command).toBe('my-hook.sh');
  });
});
