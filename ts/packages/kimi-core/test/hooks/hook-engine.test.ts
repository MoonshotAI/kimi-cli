/**
 * Covers: HookEngine (v2 §9-C.3 / §9-H.3).
 *
 * Pins:
 *   - register + list hook lifecycle
 *   - executeHooks dispatches to matching executor
 *   - Multiple hooks execute in parallel (Promise.allSettled)
 *   - blockAction aggregation: one true → overall block
 *   - additionalContext accumulation
 *   - Executor error isolation (one hook fails, others still run)
 *   - Unknown executor type is skipped gracefully
 */

import { describe, expect, it, vi } from 'vitest';

import { HookEngine } from '../../src/hooks/engine.js';
import type {
  CommandHookConfig,
  HookConfig,
  HookExecutor,
  HookResult,
  PostToolUseInput,
} from '../../src/hooks/types.js';

function makePostToolUseInput(overrides?: Partial<PostToolUseInput>): PostToolUseInput {
  return {
    event: 'PostToolUse',
    sessionId: 'sess_1',
    turnId: 'turn_1',
    agentId: 'agent_main',
    toolCall: { id: 'tc_1', name: 'Bash', args: {} },
    args: {},
    result: { content: 'ok' },
    ...overrides,
  };
}

function makeCommandHook(overrides?: Partial<CommandHookConfig>): CommandHookConfig {
  return {
    type: 'command',
    event: 'PostToolUse',
    command: 'echo ok',
    ...overrides,
  };
}

function makeExecutor(type: string, result?: HookResult): HookExecutor {
  return {
    type,
    execute: vi.fn().mockResolvedValue(result ?? { ok: true }),
  };
}

function makeEngine(
  executors?: Map<string, HookExecutor>,
  onError?: (hook: HookConfig, error: Error) => void,
): HookEngine {
  return new HookEngine({
    executors: executors ?? new Map([['command', makeExecutor('command')]]),
    onExecutorError: onError,
  });
}

describe('HookEngine', () => {
  it('register adds a hook that list returns', () => {
    const engine = makeEngine();
    const hook = makeCommandHook();
    engine.register(hook);
    expect(engine.list('PostToolUse')).toContain(hook);
  });

  it('list returns empty array when no hooks registered', () => {
    const engine = makeEngine();
    expect(engine.list()).toEqual([]);
  });

  it('unregister removes a hook', () => {
    const engine = makeEngine();
    const hook = makeCommandHook();
    engine.register(hook);
    engine.unregister(hook);
    expect(engine.list('PostToolUse')).not.toContain(hook);
  });

  it('executeHooks dispatches to the correct executor', async () => {
    const executor = makeExecutor('command', { ok: true });
    const engine = makeEngine(new Map([['command', executor]]));
    engine.register(makeCommandHook());
    const input = makePostToolUseInput();
    await engine.executeHooks('PostToolUse', input, new AbortController().signal);
    // oxlint-disable-next-line typescript-eslint/unbound-method
    expect(executor.execute).toHaveBeenCalledOnce();
  });

  it('aggregation: blockAction=true from any hook blocks overall', async () => {
    const executor = makeExecutor('command', { ok: true, blockAction: true, reason: 'denied' });
    const engine = makeEngine(new Map([['command', executor]]));
    engine.register(makeCommandHook());
    const result = await engine.executeHooks(
      'PostToolUse',
      makePostToolUseInput(),
      new AbortController().signal,
    );
    expect(result.blockAction).toBe(true);
    expect(result.reason).toBe('denied');
  });

  it('aggregation: additionalContext accumulates from multiple hooks', async () => {
    const engine = new HookEngine({
      executors: new Map([
        [
          'command',
          {
            type: 'command',
            execute: vi
              .fn()
              .mockResolvedValueOnce({ ok: true, additionalContext: 'ctx-1' })
              .mockResolvedValueOnce({ ok: true, additionalContext: 'ctx-2' }),
          },
        ],
      ]),
    });
    engine.register(makeCommandHook({ command: 'hook1' }));
    engine.register(makeCommandHook({ command: 'hook2' }));
    const result = await engine.executeHooks(
      'PostToolUse',
      makePostToolUseInput(),
      new AbortController().signal,
    );
    expect(result.additionalContext).toContain('ctx-1');
    expect(result.additionalContext).toContain('ctx-2');
  });

  it('executor error is isolated — other hooks still execute', async () => {
    const failingExecutor: HookExecutor = {
      type: 'command',
      execute: vi
        .fn()
        .mockRejectedValueOnce(new Error('hook 1 blew up'))
        .mockResolvedValueOnce({ ok: true, additionalContext: 'hook 2 ran' }),
    };
    const errors: Error[] = [];
    const engine = new HookEngine({
      executors: new Map([['command', failingExecutor]]),
      onExecutorError: (_hook, err) => errors.push(err),
    });
    engine.register(makeCommandHook({ command: 'failing' }));
    engine.register(makeCommandHook({ command: 'succeeding' }));
    const result = await engine.executeHooks(
      'PostToolUse',
      makePostToolUseInput(),
      new AbortController().signal,
    );
    // The overall result should not throw; errors are isolated
    expect(result.blockAction).toBe(false);
    expect(errors).toHaveLength(1);
  });

  it('unknown executor type is skipped gracefully', async () => {
    const engine = makeEngine(new Map()); // no executors
    engine.register({
      type: 'unknown_type',
      event: 'PostToolUse',
      command: 'x',
    } as unknown as HookConfig);
    const result = await engine.executeHooks(
      'PostToolUse',
      makePostToolUseInput(),
      new AbortController().signal,
    );
    expect(result.blockAction).toBe(false);
  });

  it('no matching hooks for event type returns non-blocking result', async () => {
    const engine = makeEngine();
    engine.register(makeCommandHook({ event: 'PreToolUse' }));
    // Execute for PostToolUse — no match
    const result = await engine.executeHooks(
      'PostToolUse',
      makePostToolUseInput(),
      new AbortController().signal,
    );
    expect(result.blockAction).toBe(false);
    expect(result.additionalContext).toEqual([]);
  });

  // ── M4 regression: matcher regex filters by tool name ────────────────

  it('hook with matcher="Bash" does NOT fire for Read tool', async () => {
    const executor = makeExecutor('command', { ok: true });
    const engine = makeEngine(new Map([['command', executor]]));
    engine.register(makeCommandHook({ matcher: 'Bash' }));
    await engine.executeHooks(
      'PostToolUse',
      makePostToolUseInput({ toolCall: { id: 'tc_r', name: 'Read', args: {} } }),
      new AbortController().signal,
    );
    // oxlint-disable-next-line typescript-eslint/unbound-method
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('hook with matcher="Bash|Grep" fires for both Bash and Grep', async () => {
    const executor = makeExecutor('command', { ok: true });
    const engine = makeEngine(new Map([['command', executor]]));
    engine.register(makeCommandHook({ matcher: 'Bash|Grep' }));
    await engine.executeHooks(
      'PostToolUse',
      makePostToolUseInput({ toolCall: { id: 'tc_b', name: 'Bash', args: {} } }),
      new AbortController().signal,
    );
    await engine.executeHooks(
      'PostToolUse',
      makePostToolUseInput({ toolCall: { id: 'tc_g', name: 'Grep', args: {} } }),
      new AbortController().signal,
    );
    await engine.executeHooks(
      'PostToolUse',
      makePostToolUseInput({ toolCall: { id: 'tc_r', name: 'Read', args: {} } }),
      new AbortController().signal,
    );
    // oxlint-disable-next-line typescript-eslint/unbound-method
    expect(executor.execute).toHaveBeenCalledTimes(2);
  });

  it('hook without matcher fires for every tool (match-all)', async () => {
    const executor = makeExecutor('command', { ok: true });
    const engine = makeEngine(new Map([['command', executor]]));
    engine.register(makeCommandHook()); // no matcher
    await engine.executeHooks(
      'PostToolUse',
      makePostToolUseInput({ toolCall: { id: 'tc_r', name: 'Read', args: {} } }),
      new AbortController().signal,
    );
    await engine.executeHooks(
      'PostToolUse',
      makePostToolUseInput({ toolCall: { id: 'tc_b', name: 'Bash', args: {} } }),
      new AbortController().signal,
    );
    // oxlint-disable-next-line typescript-eslint/unbound-method
    expect(executor.execute).toHaveBeenCalledTimes(2);
  });

  it('hook with empty-string matcher matches all tools', async () => {
    const executor = makeExecutor('command', { ok: true });
    const engine = makeEngine(new Map([['command', executor]]));
    engine.register(makeCommandHook({ matcher: '' }));
    await engine.executeHooks(
      'PostToolUse',
      makePostToolUseInput({ toolCall: { id: 'tc_w', name: 'Write', args: {} } }),
      new AbortController().signal,
    );
    // oxlint-disable-next-line typescript-eslint/unbound-method
    expect(executor.execute).toHaveBeenCalledOnce();
  });

  it('invalid regex matcher fails CLOSED (no match) and notifies observer (Phase 18 B.2)', async () => {
    // Phase 18 B.2 — TS previously fail-open (match-all); aligned with
    // Python fail-closed semantics: invalid regex → 0 matches.
    // Security rationale: a block-action hook with a broken regex must
    // not inadvertently block every tool call.
    const executor = makeExecutor('command', { ok: true });
    const invalidCalls: string[] = [];
    const engine = new HookEngine({
      executors: new Map([['command', executor]]),
      onInvalidMatcher: (_hook, pattern) => invalidCalls.push(pattern),
    });
    engine.register(makeCommandHook({ matcher: '[invalid(' }));
    await engine.executeHooks(
      'PostToolUse',
      makePostToolUseInput({ toolCall: { id: 'tc_r', name: 'Read', args: {} } }),
      new AbortController().signal,
    );
    // oxlint-disable-next-line typescript-eslint/unbound-method
    expect(executor.execute).not.toHaveBeenCalled();
    expect(invalidCalls).toEqual(['[invalid(']);
  });

  it('getMatchingHooks exposes the pre-filter used by executeHooks', () => {
    const engine = makeEngine();
    const bashHook = makeCommandHook({ matcher: 'Bash' });
    const allHook = makeCommandHook({ command: 'echo all' });
    engine.register(bashHook);
    engine.register(allHook);
    const forBash = engine.getMatchingHooks(
      'PostToolUse',
      makePostToolUseInput({ toolCall: { id: 'tc_b', name: 'Bash', args: {} } }),
    );
    expect(forBash).toEqual([bashHook, allHook]);
    const forRead = engine.getMatchingHooks(
      'PostToolUse',
      makePostToolUseInput({ toolCall: { id: 'tc_r', name: 'Read', args: {} } }),
    );
    expect(forRead).toEqual([allHook]);
  });

  // ── Phase 15 A.6 — Python edge cases (ports tests/hooks/test_engine.py) ──

  it('invalid regex does not throw and does not brick the turn (Phase 15 A.6)', async () => {
    // Python `test_invalid_regex_skips_hook` (tests/hooks/test_engine.py:63)
    // treats invalid regex as NO-MATCH; TS deviates (matches all, logs).
    // The Phase 15 contract we pin here is narrower and agnostic of the
    // match-all vs no-match semantics: executing hooks with an invalid
    // regex MUST (a) not throw, (b) not brick the turn (resolves to a
    // well-formed AggregatedHookResult). The semantic decision
    // (match-all / no-match) is tracked as a separate issue.
    const executor = makeExecutor('command', { ok: true });
    const engine = new HookEngine({
      executors: new Map([['command', executor]]),
      // onInvalidMatcher is optional; omit to verify we don't rely on it.
    });
    engine.register(makeCommandHook({ matcher: '[(bad' }));
    const promise = engine.executeHooks(
      'PostToolUse',
      makePostToolUseInput(),
      new AbortController().signal,
    );
    // Must not reject.
    const result = await expect(promise).resolves.toBeDefined();
    void result;
    // AggregatedHookResult shape preserved — blockAction boolean,
    // additionalContext array — so the turn continues normally.
    const settled = await engine.executeHooks(
      'PostToolUse',
      makePostToolUseInput(),
      new AbortController().signal,
    );
    expect(typeof settled.blockAction).toBe('boolean');
    expect(Array.isArray(settled.additionalContext)).toBe(true);
  });

  // Phase 18 B.1 — HookEngine dedupes by command single-field (Python
  // 2026-03-23 commit); two hooks sharing `command` produce a single
  // execution result even if matcher/event differ. Full contract coverage
  // lives in test/hooks/engine-alignment.test.ts (B.1 group). This
  // entry stays as a minimal regression guard against reverting dedupe
  // at the engine layer.
  it('dedup: two hooks with the same command produce a single execution (Phase 18 B.1)', async () => {
    const executor = makeExecutor('command', { ok: true });
    const engine = new HookEngine({
      executors: new Map([['command', executor]]),
    });
    engine.register(
      makeCommandHook({ command: 'echo same', matcher: 'Bash' }),
    );
    engine.register(
      makeCommandHook({ command: 'echo same', matcher: 'Bash|Read' }),
    );
    await engine.executeHooks(
      'PostToolUse',
      makePostToolUseInput(),
      new AbortController().signal,
    );
    // oxlint-disable-next-line typescript-eslint/unbound-method
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });
});
