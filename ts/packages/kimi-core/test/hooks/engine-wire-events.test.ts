/**
 * Phase 17 B.7 补齐 — HookEngine emit hook.triggered / hook.resolved。
 *
 * v2 §3.6 定义了这两个 wire event（第 381-382 行）：
 *   - `hook.triggered` { event, target, hook_count }
 *   - `hook.resolved`  { event, target, action, reason, duration_ms }
 *
 * 两者都在 §3.7 "不落盘事件" 列表里（debug-only），走 EventSink /
 * transport，不进 wire.jsonl。TS 的 HookEngine 目前只返
 * AggregatedHookResult，没有任何事件推送通道——需要新增一个
 * `emitEvent` 依赖注入口（v2 §9-H / 决策 #109 "Soul/业务层的 wire
 * 事件必须走 EventSink 或等价回调"）。
 *
 * 本测试锁定的契约：
 *   1. HookEngineDeps 新增 optional `emitEvent?: (ev: HookWireEvent) => void`
 *   2. 调 `executeHooks(event, input, signal)`：
 *      - 有 matching hooks → 先 emit `hook.triggered` + event/target/hook_count
 *      - 所有 hook settled 后 emit `hook.resolved` + action/reason/duration_ms
 *   3. 没 matching hooks → 不 emit（安静路径）
 *   4. `action` = "block" 当聚合 blockAction=true，否则 "allow"
 *   5. duration_ms 是正整数 / 0 (测试里只锁 ≥ 0)
 *   6. 没注入 emitEvent 时，executeHooks 行为不变（向后兼容）
 */

import { describe, expect, it, vi } from 'vitest';

import { HookEngine } from '../../src/hooks/engine.js';
import type {
  CommandHookConfig,
  HookExecutor,
  HookResult,
  PostToolUseInput,
} from '../../src/hooks/types.js';

// ── Test fixtures ──────────────────────────────────────────────────────

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

function makeExecutor(result?: HookResult): HookExecutor {
  return {
    type: 'command',
    execute: vi.fn().mockResolvedValue(result ?? { ok: true }),
  };
}

// ── Shape of the expected event union (new public surface) ─────────────

interface HookTriggeredEvent {
  type: 'hook.triggered';
  event: string;
  target: string;
  hook_count: number;
}

interface HookResolvedEvent {
  type: 'hook.resolved';
  event: string;
  target: string;
  action: 'allow' | 'block';
  reason?: string | undefined;
  duration_ms: number;
}

type HookWireEvent = HookTriggeredEvent | HookResolvedEvent;

describe('Phase 17 B.7 — HookEngine emits hook.triggered / hook.resolved', () => {
  it('allow path: matching hook → triggered, then resolved(action: "allow")', async () => {
    const emitted: HookWireEvent[] = [];
    const emitEvent = vi.fn((ev: HookWireEvent) => emitted.push(ev));

    const engine = new HookEngine({
      executors: new Map([['command', makeExecutor({ ok: true })]]),
      // New optional dep — implementer must extend HookEngineDeps.
      emitEvent,
    } as unknown as ConstructorParameters<typeof HookEngine>[0]);

    engine.register(makeCommandHook({ matcher: 'Bash' }));

    await engine.executeHooks(
      'PostToolUse',
      makePostToolUseInput({
        toolCall: { id: 'tc_1', name: 'Bash', args: {} },
      }),
      new AbortController().signal,
    );

    const kinds = emitted.map((e) => e.type);
    expect(kinds).toEqual(['hook.triggered', 'hook.resolved']);

    const triggered = emitted[0] as HookTriggeredEvent;
    expect(triggered.event).toBe('PostToolUse');
    expect(triggered.target).toBe('Bash');
    expect(triggered.hook_count).toBe(1);

    const resolved = emitted[1] as HookResolvedEvent;
    expect(resolved.event).toBe('PostToolUse');
    expect(resolved.target).toBe('Bash');
    expect(resolved.action).toBe('allow');
    expect(resolved.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('block path: any blockAction=true → resolved.action="block" + reason forwarded', async () => {
    const emitted: HookWireEvent[] = [];
    const engine = new HookEngine({
      executors: new Map([
        [
          'command',
          makeExecutor({
            ok: true,
            blockAction: true,
            reason: 'no way',
          }),
        ],
      ]),
      emitEvent: (ev: HookWireEvent) => emitted.push(ev),
    } as unknown as ConstructorParameters<typeof HookEngine>[0]);

    engine.register(makeCommandHook({ matcher: 'Bash' }));
    await engine.executeHooks(
      'PostToolUse',
      makePostToolUseInput(),
      new AbortController().signal,
    );

    const resolved = emitted.find(
      (e) => e.type === 'hook.resolved',
    ) as HookResolvedEvent | undefined;
    expect(resolved?.action).toBe('block');
    expect(resolved?.reason).toBe('no way');
  });

  it('no matching hooks → NO events emitted (quiet path)', async () => {
    const emitted: HookWireEvent[] = [];
    const engine = new HookEngine({
      executors: new Map([['command', makeExecutor()]]),
      emitEvent: (ev: HookWireEvent) => emitted.push(ev),
    } as unknown as ConstructorParameters<typeof HookEngine>[0]);

    // Register a hook for a DIFFERENT event → no match for PostToolUse.
    engine.register(makeCommandHook({ event: 'PreToolUse' }));

    await engine.executeHooks(
      'PostToolUse',
      makePostToolUseInput(),
      new AbortController().signal,
    );

    expect(emitted).toEqual([]);
  });

  it('hook_count reflects number of deduped matching hooks', async () => {
    const emitted: HookWireEvent[] = [];
    const engine = new HookEngine({
      executors: new Map([['command', makeExecutor()]]),
      emitEvent: (ev: HookWireEvent) => emitted.push(ev),
    } as unknown as ConstructorParameters<typeof HookEngine>[0]);

    // Three hooks match (different commands).
    engine.register(makeCommandHook({ command: 'echo a', matcher: 'Bash' }));
    engine.register(makeCommandHook({ command: 'echo b', matcher: 'Bash' }));
    engine.register(makeCommandHook({ command: 'echo c', matcher: 'Bash' }));

    await engine.executeHooks(
      'PostToolUse',
      makePostToolUseInput(),
      new AbortController().signal,
    );

    const triggered = emitted.find(
      (e) => e.type === 'hook.triggered',
    ) as HookTriggeredEvent | undefined;
    expect(triggered?.hook_count).toBe(3);
  });

  it('omitting emitEvent keeps executeHooks behaviour backward-compatible', async () => {
    const executor = makeExecutor({ ok: true });
    const engine = new HookEngine({
      executors: new Map([['command', executor]]),
      // No emitEvent.
    });
    engine.register(makeCommandHook({ matcher: 'Bash' }));
    const result = await engine.executeHooks(
      'PostToolUse',
      makePostToolUseInput(),
      new AbortController().signal,
    );
    // Must still resolve normally with the usual aggregated shape.
    expect(result.blockAction).toBe(false);
    expect(Array.isArray(result.additionalContext)).toBe(true);
  });
});
