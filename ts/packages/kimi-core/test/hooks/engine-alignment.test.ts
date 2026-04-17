/**
 * Phase 18 Slice 1 Section B — HookEngine 对齐 Python 语义。
 *
 * B.1 Dedupe by command 单字段
 *   两个 hook 只要 `command` 相同就在同一次 executeHooks 里 dedupe
 *   (matcher/event/type 不参与 dedupe key)。Python 的
 *   `kimi_cli/hooks/engine.py:dedup_hooks` 从 2026-03-23 commit
 *   开始把 key 缩到单字段；TS 旧实现对相同 command 会并发执行两次，
 *   需要在 executeHooks → Promise.allSettled 前过滤重复。
 *
 * B.2 Invalid regex fail-closed
 *   TS 当前 `matchesTarget` 把 invalid regex 当 match-all（fail-open），
 *   这在用户配了 block 类 hook 时会一次性把所有 tool 都 block 掉。
 *   对齐 Python 改为 fail-closed —— invalid regex → 静默 0 匹配。
 *
 * B.3 `PostToolUseFailure` event alias
 *   Python 用 `PostToolUseFailure`，TS 用 `OnToolFailure`。config-loader
 *   需要把 `PostToolUseFailure` 归一化成 `OnToolFailure` 以兼容跨环境
 *   TOML。后续 executeHooks('OnToolFailure', …) 能命中由
 *   `PostToolUseFailure` 配置的 hook。
 *
 * All tests here are intentionally failing on current `src/`; Section B
 * implementer will flip them green.
 */

import { describe, expect, it, vi } from 'vitest';

import { HookEngine } from '../../src/hooks/engine.js';
import { parseHookConfigs } from '../../src/hooks/config-loader.js';
import type {
  CommandHookConfig,
  HookExecutor,
  HookResult,
  OnToolFailureInput,
  PostToolUseInput,
} from '../../src/hooks/types.js';

function makePostToolUseInput(
  overrides?: Partial<PostToolUseInput>,
): PostToolUseInput {
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

function makeOnToolFailureInput(
  overrides?: Partial<OnToolFailureInput>,
): OnToolFailureInput {
  return {
    event: 'OnToolFailure',
    sessionId: 'sess_1',
    turnId: 'turn_1',
    agentId: 'agent_main',
    toolCall: { id: 'tc_1', name: 'Bash', args: {} },
    args: {},
    error: new Error('tool blew up'),
    ...overrides,
  };
}

function makeCommandHook(
  overrides?: Partial<CommandHookConfig>,
): CommandHookConfig {
  return {
    type: 'command',
    event: 'PostToolUse',
    command: 'echo ok',
    ...overrides,
  };
}

function makeExecutor(result?: HookResult): HookExecutor & {
  execute: ReturnType<typeof vi.fn>;
} {
  const execute = vi.fn().mockResolvedValue(result ?? { ok: true });
  return { type: 'command', execute };
}

// ── B.1 Dedupe ──────────────────────────────────────────────────────────

describe('Phase 18 B.1 — HookEngine dedupe by command', () => {
  it('two hooks with the SAME command execute only once in one executeHooks call', async () => {
    const executor = makeExecutor({ ok: true });
    const engine = new HookEngine({
      executors: new Map([['command', executor]]),
    });
    const hookA = makeCommandHook({ command: 'echo x', matcher: 'Bash' });
    const hookB = makeCommandHook({ command: 'echo x', matcher: 'Bash|Read' });
    engine.register(hookA);
    engine.register(hookB);

    await engine.executeHooks(
      'PostToolUse',
      makePostToolUseInput(),
      new AbortController().signal,
    );

    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it('two hooks with DIFFERENT commands both execute (no false-positive dedupe)', async () => {
    const executor = makeExecutor({ ok: true });
    const engine = new HookEngine({
      executors: new Map([['command', executor]]),
    });
    engine.register(makeCommandHook({ command: 'echo a' }));
    engine.register(makeCommandHook({ command: 'echo b' }));

    await engine.executeHooks(
      'PostToolUse',
      makePostToolUseInput(),
      new AbortController().signal,
    );

    expect(executor.execute).toHaveBeenCalledTimes(2);
  });

  it('dedupe is scoped per executeHooks call — a second call re-executes', async () => {
    const executor = makeExecutor({ ok: true });
    const engine = new HookEngine({
      executors: new Map([['command', executor]]),
    });
    engine.register(makeCommandHook({ command: 'echo x' }));
    engine.register(makeCommandHook({ command: 'echo x' }));

    await engine.executeHooks(
      'PostToolUse',
      makePostToolUseInput(),
      new AbortController().signal,
    );
    await engine.executeHooks(
      'PostToolUse',
      makePostToolUseInput(),
      new AbortController().signal,
    );

    // Call 1 → 1 execution (deduped), call 2 → 1 execution (deduped) → 2 total.
    expect(executor.execute).toHaveBeenCalledTimes(2);
  });
});

// ── B.2 Invalid regex fail-closed ──────────────────────────────────────

describe('Phase 18 B.2 — invalid regex fail-closed', () => {
  it('hook with invalid regex matcher does NOT match any tool (fail-closed)', async () => {
    const executor = makeExecutor({ ok: true });
    const invalid: string[] = [];
    const engine = new HookEngine({
      executors: new Map([['command', executor]]),
      onInvalidMatcher: (_hook, pattern) => invalid.push(pattern),
    });
    // `[invalid(regex` is a malformed character class + unclosed group.
    engine.register(
      makeCommandHook({
        matcher: '[invalid(regex',
        event: 'PreToolUse',
      }),
    );

    // Run through a variety of tool names — none should trigger the hook
    // because the matcher is invalid and we now fail-closed.
    for (const toolName of ['Bash', 'Read', 'Write', 'Grep']) {
      await engine.executeHooks(
        'PreToolUse',
        {
          event: 'PreToolUse',
          sessionId: 'sess_1',
          turnId: 'turn_1',
          agentId: 'agent_main',
          toolCall: { id: `tc_${toolName}`, name: toolName, args: {} },
          args: {},
        },
        new AbortController().signal,
      );
    }

    expect(executor.execute).not.toHaveBeenCalled();
    // Observer still called so the misconfig is visible in logs.
    expect(invalid).toContain('[invalid(regex');
  });

  it('block-action hook with invalid regex does NOT brick every tool', async () => {
    // Regression for the security issue: fail-open + block action → all
    // tools blocked. Fail-closed means the hook simply does not match,
    // so blockAction stays false.
    const blockExecutor: HookExecutor = {
      type: 'command',
      execute: vi.fn().mockResolvedValue({
        ok: true,
        blockAction: true,
        reason: 'deny',
      }),
    };
    const engine = new HookEngine({
      executors: new Map([['command', blockExecutor]]),
    });
    engine.register(
      makeCommandHook({ matcher: '[bad(', event: 'PreToolUse' }),
    );

    const result = await engine.executeHooks(
      'PreToolUse',
      {
        event: 'PreToolUse',
        sessionId: 'sess_1',
        turnId: 'turn_1',
        agentId: 'agent_main',
        toolCall: { id: 'tc_bash', name: 'Bash', args: {} },
        args: {},
      },
      new AbortController().signal,
    );

    expect(result.blockAction).toBe(false);
    // oxlint-disable-next-line typescript-eslint/unbound-method
    expect(blockExecutor.execute).not.toHaveBeenCalled();
  });

  it('valid regex matcher still matches normally after the fail-closed switch', async () => {
    const executor = makeExecutor({ ok: true });
    const engine = new HookEngine({
      executors: new Map([['command', executor]]),
    });
    engine.register(makeCommandHook({ matcher: 'Bash' }));

    await engine.executeHooks(
      'PostToolUse',
      makePostToolUseInput({
        toolCall: { id: 'tc_b', name: 'Bash', args: {} },
      }),
      new AbortController().signal,
    );

    expect(executor.execute).toHaveBeenCalledTimes(1);
  });
});

// ── B.3 PostToolUseFailure → OnToolFailure alias ────────────────────────

describe('Phase 18 B.3 — PostToolUseFailure event alias', () => {
  it('parseHookConfigs normalises PostToolUseFailure to OnToolFailure', () => {
    const warnings: string[] = [];
    const result = parseHookConfigs(
      [
        {
          event: 'PostToolUseFailure',
          command: 'log-failure.sh',
          matcher: 'Bash',
        },
      ],
      (msg) => warnings.push(msg),
    );

    expect(warnings).toEqual([]);
    expect(result).toHaveLength(1);
    expect(result[0]?.event).toBe('OnToolFailure');
    expect(result[0]?.command).toBe('log-failure.sh');
    expect(result[0]?.matcher).toBe('Bash');
  });

  it('a hook configured as PostToolUseFailure is triggered by executeHooks("OnToolFailure")', async () => {
    const [normalised] = parseHookConfigs([
      { event: 'PostToolUseFailure', command: 'log-failure.sh' },
    ]);
    expect(normalised).toBeDefined();

    const executor = makeExecutor({ ok: true });
    const engine = new HookEngine({
      executors: new Map([['command', executor]]),
    });
    engine.register(normalised!);

    await engine.executeHooks(
      'OnToolFailure',
      makeOnToolFailureInput(),
      new AbortController().signal,
    );

    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it('native OnToolFailure events still parse unchanged', () => {
    const warnings: string[] = [];
    const result = parseHookConfigs(
      [{ event: 'OnToolFailure', command: 'cleanup.sh' }],
      (msg) => warnings.push(msg),
    );

    expect(warnings).toEqual([]);
    expect(result[0]?.event).toBe('OnToolFailure');
  });
});
