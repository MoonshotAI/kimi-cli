/**
 * Covers: `SoulRegistry` (v2 §5.2.3).
 *
 * Slice 3 scope: only `main` is created; `sub:*` / `independent:*` are
 * Slice 7. Tests lock idempotent `getOrCreate`, `has` lookup, and
 * `destroy` aborting the underlying AbortController.
 */

import { describe, expect, it } from 'vitest';

import type { SoulHandle, SoulKey } from '../../src/soul-plus/index.js';
import { SoulRegistry } from '../../src/soul-plus/index.js';

function makeHandle(key: SoulKey, agentId: string, agentDepth = 0): SoulHandle {
  return {
    key,
    agentId,
    abortController: new AbortController(),
    agentDepth,
  };
}

describe('SoulRegistry', () => {
  it('getOrCreate("main") invokes the factory on first call', () => {
    let factoryCalls = 0;
    const registry = new SoulRegistry({
      createHandle: (key) => {
        factoryCalls += 1;
        return makeHandle(key, `agent_${factoryCalls}`);
      },
    });

    const handle = registry.getOrCreate('main');
    expect(handle.key).toBe('main');
    expect(handle.agentId).toBe('agent_1');
    expect(factoryCalls).toBe(1);
  });

  it('getOrCreate("main") is idempotent — the second call returns the same handle without re-invoking the factory', () => {
    let factoryCalls = 0;
    const registry = new SoulRegistry({
      createHandle: (key) => {
        factoryCalls += 1;
        return makeHandle(key, `agent_${factoryCalls}`);
      },
    });

    const first = registry.getOrCreate('main');
    const second = registry.getOrCreate('main');
    expect(second).toBe(first);
    expect(factoryCalls).toBe(1);
  });

  it('has() reflects the registry state', () => {
    const registry = new SoulRegistry({
      createHandle: (key) => makeHandle(key, 'agent_main'),
    });

    expect(registry.has('main')).toBe(false);
    registry.getOrCreate('main');
    expect(registry.has('main')).toBe(true);
  });

  it('keys() lists all registered SoulKeys', () => {
    const registry = new SoulRegistry({
      createHandle: (key) => makeHandle(key, `id_for_${key}`),
    });
    registry.getOrCreate('main');
    expect([...registry.keys()]).toEqual(['main']);
  });

  it('destroy() aborts the handle AbortController and removes the entry', () => {
    const controllers: AbortController[] = [];
    const registry = new SoulRegistry({
      createHandle: (key, agentDepth) => {
        const c = new AbortController();
        controllers.push(c);
        return { key, agentId: 'agent_main', abortController: c, agentDepth };
      },
    });

    registry.getOrCreate('main');
    expect(registry.has('main')).toBe(true);
    const controller = controllers[0];
    expect(controller).toBeDefined();
    expect(controller!.signal.aborted).toBe(false);

    registry.destroy('main');
    expect(registry.has('main')).toBe(false);
    expect(controller!.signal.aborted).toBe(true);
  });

  it('destroy() is a no-op for unknown keys', () => {
    const registry = new SoulRegistry({
      createHandle: (key) => makeHandle(key, 'agent_main'),
    });
    expect(() => {
      registry.destroy('main');
    }).not.toThrow();
  });

  it('creating, destroying, then re-creating produces a fresh handle', () => {
    let sequence = 0;
    const registry = new SoulRegistry({
      createHandle: (key) => {
        sequence += 1;
        return makeHandle(key, `agent_${sequence}`);
      },
    });

    const first = registry.getOrCreate('main');
    registry.destroy('main');
    const second = registry.getOrCreate('main');
    expect(second).not.toBe(first);
    expect(second.agentId).toBe('agent_2');
  });
});

// ── Phase 6 / Scenario H — abort cascade + lifecycle records ─────────
//
// When `SpawnRequest.signal` aborts mid-flight (e.g. parent turn cancelled),
// the subagent runner rejects and SoulRegistry MUST:
//   1. Write a `subagent_failed` record to the parent SessionJournal.
//   2. Ensure the child JournalWriter has been flushed so the child's
//      last durable record is persisted — the child wire must not lose
//      tail data just because the parent aborted.
//
// The registry gains a parentSessionJournal dependency in Phase 6. These
// tests assert the lifecycle-records portion of the cascade; the child
// wire flush portion is exercised at integration level in
// subagent-independent-wire.test.ts.

describe('SoulRegistry — subagent lifecycle journal integration (Phase 6)', () => {
  it('writes subagent_spawned to the parent journal when spawn() is called', async () => {
    // Imports kept local so this suite does not re-import the lightweight
    // `SoulRegistry` smoke-test file header.
    const { InMemorySessionJournalImpl } = await import(
      '../../src/storage/session-journal.js'
    );
    const parentJournal = new InMemorySessionJournalImpl();

    const registry = new SoulRegistry({
      createHandle: (key, agentDepth) => ({
        key,
        agentId: key.replace('sub:', ''),
        abortController: new AbortController(),
        agentDepth,
      }),
      runSubagentTurn: async () =>
        Promise.resolve({ result: 'ok', usage: { input: 0, output: 0 } }),
      parentSessionJournal: parentJournal,
    });

    const handle = await registry.spawn({
      parentAgentId: 'agent_main',
      parentToolCallId: 'tc_parent',
      agentName: 'coder',
      prompt: 'run',
    });

    // Make sure the completion settles before we assert the final records.
    await handle.completion.catch(() => {});

    const spawned = parentJournal.getRecordsByType('subagent_spawned');
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.data.agent_id).toBe(handle.agentId);
    expect(spawned[0]!.data.parent_tool_call_id).toBe('tc_parent');
  });

  it('writes subagent_completed on normal completion', async () => {
    const { InMemorySessionJournalImpl } = await import(
      '../../src/storage/session-journal.js'
    );
    const parentJournal = new InMemorySessionJournalImpl();

    const registry = new SoulRegistry({
      createHandle: (key, agentDepth) => ({
        key,
        agentId: key.replace('sub:', ''),
        abortController: new AbortController(),
        agentDepth,
      }),
      runSubagentTurn: async () => ({
        result: 'child wrote a full body of text we summarize into result_summary',
        usage: { input: 10, output: 20 },
      }),
      parentSessionJournal: parentJournal,
    });

    const handle = await registry.spawn({
      parentAgentId: 'agent_main',
      parentToolCallId: 'tc_parent',
      agentName: 'coder',
      prompt: 'work',
    });
    await handle.completion;

    const completed = parentJournal.getRecordsByType('subagent_completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]!.data.agent_id).toBe(handle.agentId);
    expect(completed[0]!.data.result_summary.length).toBeGreaterThan(0);
  });

  it('parent abort → subagent_failed record written with the error reason', async () => {
    const { InMemorySessionJournalImpl } = await import(
      '../../src/storage/session-journal.js'
    );
    const parentJournal = new InMemorySessionJournalImpl();

    const parentController = new AbortController();

    const registry = new SoulRegistry({
      createHandle: (key, agentDepth) => ({
        key,
        agentId: key.replace('sub:', ''),
        abortController: new AbortController(),
        agentDepth,
      }),
      // Simulate a subagent whose run throws when the signal aborts.
      runSubagentTurn: async (_id, _req, signal) =>
        new Promise<never>((_resolve, reject) => {
          const onAbort = (): void => {
            reject(new Error('Subagent was aborted'));
          };
          if (signal.aborted) {
            onAbort();
          } else {
            signal.addEventListener('abort', onAbort, { once: true });
          }
        }),
      parentSessionJournal: parentJournal,
    });

    const handle = await registry.spawn({
      parentAgentId: 'agent_main',
      parentToolCallId: 'tc_parent',
      agentName: 'coder',
      prompt: 'work',
      signal: parentController.signal,
    });

    parentController.abort();

    await handle.completion.catch(() => {});

    const failed = parentJournal.getRecordsByType('subagent_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.data.agent_id).toBe(handle.agentId);
    expect(failed[0]!.data.parent_tool_call_id).toBe('tc_parent');
    expect(failed[0]!.data.error.length).toBeGreaterThan(0);

    // Never both: a failed turn must not also log `subagent_completed`.
    expect(parentJournal.getRecordsByType('subagent_completed')).toHaveLength(0);
  });

  it('legacy `subagent_event` method is gone on Phase 6 SessionJournal', async () => {
    // Regression guard — if an older code path tries to bubble an event
    // via the removed `appendSubagentEvent`, the compile fails. Runtime
    // lookup is a secondary defence.
    const { InMemorySessionJournalImpl } = await import(
      '../../src/storage/session-journal.js'
    );
    const journal = new InMemorySessionJournalImpl();
    expect(
      (journal as unknown as Record<string, unknown>)['appendSubagentEvent'],
    ).toBeUndefined();
  });
});
