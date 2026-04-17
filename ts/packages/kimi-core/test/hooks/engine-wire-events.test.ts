/**
 * Phase 17 B.7 补齐 — HookEngine emit hook.triggered / hook.resolved。
 *
 * Post-merge with ts-rewrite-work (Phase 17 A.1 event-bridge): events
 * are routed through the SoulEvent `sink` dependency rather than an
 * engine-private `emitEvent` callback. Shape:
 *
 *   - `hook.triggered { event, matchers, matched_count }`
 *       fires on EVERY `executeHooks` call (matched_count=0 when no
 *       hooks match — kept symmetric so wire observers see every
 *       dispatch). Event carries the flat list of matcher strings
 *       (empty string = match-all).
 *   - `hook.resolved { hook_id, outcome }` fires once per settled
 *       hook. `outcome` ∈ { 'ok', 'blocked', 'error' }. `hook_id` is
 *       `${event}:${type}:${matcher}:${registrationIndex}` so clients
 *       can correlate triggered matchers to resolved hooks.
 *
 * Per v2 §3.7 these events are **not** persisted (the wire event-bridge
 * forwards them live; the journal writer never writes `hook.*`).
 */

import { describe, expect, it, vi } from 'vitest';

import { HookEngine } from '../../src/hooks/engine.js';
import type { EventSink, SoulEvent } from '../../src/soul/event-sink.js';
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

function makeCollectingSink(): { sink: EventSink; events: SoulEvent[] } {
  const events: SoulEvent[] = [];
  return {
    events,
    sink: { emit: (ev: SoulEvent) => events.push(ev) },
  };
}

type HookTriggered = Extract<SoulEvent, { type: 'hook.triggered' }>;
type HookResolved = Extract<SoulEvent, { type: 'hook.resolved' }>;

describe('Phase 17 B.7 — HookEngine emits hook.triggered / hook.resolved', () => {
  it('allow path: matching hook → triggered(matched_count:1), then resolved(outcome:"ok")', async () => {
    const { sink, events } = makeCollectingSink();
    const engine = new HookEngine({
      executors: new Map([['command', makeExecutor({ ok: true })]]),
      sink,
    });

    engine.register(makeCommandHook({ matcher: 'Bash' }));

    await engine.executeHooks(
      'PostToolUse',
      makePostToolUseInput({
        toolCall: { id: 'tc_1', name: 'Bash', args: {} },
      }),
      new AbortController().signal,
    );

    const kinds = events.map((e) => e.type);
    expect(kinds).toEqual(['hook.triggered', 'hook.resolved']);

    const triggered = events[0] as HookTriggered;
    expect(triggered.event).toBe('PostToolUse');
    expect(triggered.matched_count).toBe(1);
    expect(triggered.matchers).toEqual(['Bash']);

    const resolved = events[1] as HookResolved;
    expect(resolved.outcome).toBe('ok');
    expect(resolved.hook_id).toContain('PostToolUse');
    expect(resolved.hook_id).toContain('command');
    expect(resolved.hook_id).toContain('Bash');
  });

  it('block path: any blockAction=true → resolved.outcome="blocked"', async () => {
    const { sink, events } = makeCollectingSink();
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
      sink,
    });

    engine.register(makeCommandHook({ matcher: 'Bash' }));
    await engine.executeHooks(
      'PostToolUse',
      makePostToolUseInput(),
      new AbortController().signal,
    );

    const resolved = events.find(
      (e): e is HookResolved => e.type === 'hook.resolved',
    );
    expect(resolved?.outcome).toBe('blocked');
  });

  it('no matching hooks → still emits hook.triggered with matched_count=0 (symmetric protocol)', async () => {
    const { sink, events } = makeCollectingSink();
    const engine = new HookEngine({
      executors: new Map([['command', makeExecutor()]]),
      sink,
    });

    // Register a hook for a DIFFERENT event → no match for PostToolUse.
    engine.register(makeCommandHook({ event: 'PreToolUse' }));

    await engine.executeHooks(
      'PostToolUse',
      makePostToolUseInput(),
      new AbortController().signal,
    );

    // Post-merge protocol: still emit triggered with matched_count=0
    // so wire-side observability sees that the event was considered.
    expect(events.length).toBe(1);
    const triggered = events[0] as HookTriggered;
    expect(triggered.type).toBe('hook.triggered');
    expect(triggered.matched_count).toBe(0);
    expect(triggered.matchers).toEqual([]);
  });

  it('matched_count reflects number of deduped matching hooks', async () => {
    const { sink, events } = makeCollectingSink();
    const engine = new HookEngine({
      executors: new Map([['command', makeExecutor()]]),
      sink,
    });

    // Three hooks match (different commands). Dedupe keys on `command`
    // so these stay as 3 distinct hooks.
    engine.register(makeCommandHook({ command: 'echo a', matcher: 'Bash' }));
    engine.register(makeCommandHook({ command: 'echo b', matcher: 'Bash' }));
    engine.register(makeCommandHook({ command: 'echo c', matcher: 'Bash' }));

    await engine.executeHooks(
      'PostToolUse',
      makePostToolUseInput(),
      new AbortController().signal,
    );

    const triggered = events.find(
      (e): e is HookTriggered => e.type === 'hook.triggered',
    );
    expect(triggered?.matched_count).toBe(3);
  });

  it('omitting sink keeps executeHooks behaviour backward-compatible', async () => {
    const engine = new HookEngine({
      executors: new Map([['command', makeExecutor({ ok: true })]]),
      // sink omitted
    });

    engine.register(makeCommandHook({ matcher: 'Bash' }));

    // Should not throw even without a sink.
    const result = await engine.executeHooks(
      'PostToolUse',
      makePostToolUseInput({
        toolCall: { id: 'tc_1', name: 'Bash', args: {} },
      }),
      new AbortController().signal,
    );

    expect(result.blockAction).toBe(false);
  });
});
