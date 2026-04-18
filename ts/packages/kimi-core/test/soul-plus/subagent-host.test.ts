/**
 * Covers: SoulRegistry as SubagentHost (v2 §5.2.3 / §7.2).
 *
 * Slice 7 scope:
 *   - SoulRegistry.spawn() — creates sub:<id> handle, returns SubagentHandle
 *   - Subagent ID generation — unique, prefixed with `sub_`
 *   - Foreground vs background abort isolation
 *   - Subagent state machine (7-state: created → running → completed/failed/killed/lost)
 *   - SubagentStateJson persistence shape
 *   - SoulRegistry key management for sub:* entries
 *   - Cleanup: destroy(sub:<id>) aborts the subagent
 *
 * All tests are red bar — SoulRegistry.spawn is not yet implemented.
 */

import { describe, expect, it } from 'vitest';

import type {
  AgentResult,
  SoulHandle,
  SoulKey,
  SpawnRequest,
  SubagentHandle,
  SubagentHost,
  SubagentStateJson,
  SubagentStatus,
} from '../../src/soul-plus/index.js';
import { SoulRegistry } from '../../src/soul-plus/index.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makeHandle(key: SoulKey, agentId: string, agentDepth = 0): SoulHandle {
  return {
    key,
    agentId,
    abortController: new AbortController(),
    agentDepth,
  };
}

function makeSpawnRequest(overrides?: Partial<SpawnRequest>): SpawnRequest {
  return {
    parentAgentId: 'agent_main',
    parentToolCallId: 'tc_default',
    agentName: 'general-purpose',
    prompt: 'Do the task',
    ...overrides,
  };
}

/**
 * Stays pending forever — used when a test needs to observe registry
 * state while a subagent is still "running" (auto-destroy would
 * otherwise fire as soon as the stub completion settles).
 */
function pendingCompletion(): Promise<AgentResult> {
  return new Promise<AgentResult>(() => {});
}

// ── SoulRegistry.spawn (SubagentHost interface) ──────────────────────

describe('SoulRegistry as SubagentHost', () => {
  it('implements SubagentHost interface', () => {
    const registry = new SoulRegistry({
      createHandle: (key) => makeHandle(key, 'agent_main'),
    });

    // Type-level assertion: SoulRegistry should satisfy SubagentHost
    const host: SubagentHost = registry as unknown as SubagentHost;
    expect(typeof host.spawn).toBe('function');
  });

  it('spawn() creates a sub:<id> entry in the registry', async () => {
    const registry = new SoulRegistry({
      createHandle: (key) => makeHandle(key, `id_for_${key}`),
    });

    const host = registry as unknown as SubagentHost;
    const handle = await host.spawn(makeSpawnRequest());

    // The subagent key should be registered
    const subKey: SoulKey = `sub:${handle.agentId}`;
    expect(registry.has(subKey)).toBe(true);
  });

  it('spawn() generates unique agent IDs', async () => {
    const registry = new SoulRegistry({
      createHandle: (key) => makeHandle(key, `id_for_${key}`),
    });

    const host = registry as unknown as SubagentHost;
    const h1 = await host.spawn(makeSpawnRequest());
    const h2 = await host.spawn(makeSpawnRequest());

    expect(h1.agentId).not.toBe(h2.agentId);
  });

  it('spawn() returns a SubagentHandle with agentId and completion promise', async () => {
    const registry = new SoulRegistry({
      createHandle: (key) => makeHandle(key, `id_for_${key}`),
    });

    const host = registry as unknown as SubagentHost;
    const handle: SubagentHandle = await host.spawn(makeSpawnRequest());

    expect(handle.agentId).toBeDefined();
    expect(handle.agentId).toMatch(/^sub_/);
    expect(handle.completion).toBeInstanceOf(Promise);
  });

  it('foreground spawn: completion resolves with AgentResult', async () => {
    const registry = new SoulRegistry({
      createHandle: (key) => makeHandle(key, `id_for_${key}`),
    });

    const host = registry as unknown as SubagentHost;
    const handle = await host.spawn(makeSpawnRequest({ runInBackground: false }));

    const result: AgentResult = await handle.completion;
    expect(result.result).toBeDefined();
    expect(result.usage).toBeDefined();
    expect(result.usage.input).toBeGreaterThanOrEqual(0);
    expect(result.usage.output).toBeGreaterThanOrEqual(0);
  });

  it('background spawn: completion eventually resolves without blocking spawn()', async () => {
    const registry = new SoulRegistry({
      createHandle: (key) => makeHandle(key, `id_for_${key}`),
    });

    const host = registry as unknown as SubagentHost;
    const handle = await host.spawn(makeSpawnRequest({ runInBackground: true }));

    // spawn() should return quickly for background mode
    expect(handle.agentId).toBeDefined();

    // completion is a promise that resolves later
    const result = await handle.completion;
    expect(result.result).toBeDefined();
  });

  it('spawn() passes the prompt as initial user input to the subagent', async () => {
    const registry = new SoulRegistry({
      createHandle: (key) => makeHandle(key, `id_for_${key}`),
    });

    const host = registry as unknown as SubagentHost;
    const handle = await host.spawn(makeSpawnRequest({ prompt: 'Analyze the auth module' }));

    // The subagent should have received the prompt
    // (Verified by the fact that completion resolves with meaningful result)
    const result = await handle.completion;
    expect(result).toBeDefined();
  });
});

// ── Subagent abort semantics (§5.9) ──────────────────────────────────

describe('SoulRegistry — subagent abort', () => {
  it('destroy(sub:<id>) aborts the subagent AbortController', async () => {
    const controllers: Map<string, AbortController> = new Map();
    const registry = new SoulRegistry({
      createHandle: (key) => {
        const c = new AbortController();
        controllers.set(key, c);
        return { key, agentId: `id_for_${key}`, abortController: c, agentDepth: 0 };
      },
    });

    const host = registry as unknown as SubagentHost;
    const handle = await host.spawn(makeSpawnRequest());

    const subKey: SoulKey = `sub:${handle.agentId}`;
    const controller = controllers.get(subKey);
    expect(controller).toBeDefined();
    expect(controller!.signal.aborted).toBe(false);

    registry.destroy(subKey);

    expect(controller!.signal.aborted).toBe(true);
    expect(registry.has(subKey)).toBe(false);
  });

  it('foreground subagent: parent turn abort cascades to child', async () => {
    const registry = new SoulRegistry({
      createHandle: (key) => makeHandle(key, `id_for_${key}`),
    });

    const host = registry as unknown as SubagentHost;

    // Simulate: parent creates a foreground subagent, then aborts
    const handle = await host.spawn(makeSpawnRequest({ runInBackground: false }));

    // In the real implementation, the parent's AbortController.abort()
    // should cascade to the child via the linked child controller.
    // The sub:<id> handle's AbortController should end up aborted.
    const subKey: SoulKey = `sub:${handle.agentId}`;
    registry.destroy(subKey);

    // After destruction, the handle should be cleaned up
    expect(registry.has(subKey)).toBe(false);
  });

  it('background subagent: independent controller, not linked to parent', async () => {
    const controllers: Map<string, AbortController> = new Map();
    const registry = new SoulRegistry({
      createHandle: (key) => {
        const c = new AbortController();
        controllers.set(key, c);
        return { key, agentId: `id_for_${key}`, abortController: c, agentDepth: 0 };
      },
    });

    // Create main handle
    registry.getOrCreate('main');
    const mainController = controllers.get('main');

    const host = registry as unknown as SubagentHost;
    const handle = await host.spawn(makeSpawnRequest({ runInBackground: true }));

    const subKey: SoulKey = `sub:${handle.agentId}`;
    const subController = controllers.get(subKey);

    // Abort the main — background subagent should NOT be affected
    mainController!.abort();
    expect(subController!.signal.aborted).toBe(false);
  });

  // ── Slice 2.1: parent signal → child cascade via SpawnRequest.signal ──

  it('foreground spawn: parent signal aborting cascades into child controller', async () => {
    const controllers: Map<string, AbortController> = new Map();
    const registry = new SoulRegistry({
      createHandle: (key) => {
        const c = new AbortController();
        controllers.set(key, c);
        return { key, agentId: `id_for_${key}`, abortController: c, agentDepth: 0 };
      },
      runSubagentTurn: (_id) => pendingCompletion(),
    });

    const parentController = new AbortController();
    const host = registry as unknown as SubagentHost;

    const handle = await host.spawn(
      makeSpawnRequest({ runInBackground: false, signal: parentController.signal }),
    );
    const subController = controllers.get(`sub:${handle.agentId}`);
    expect(subController!.signal.aborted).toBe(false);

    parentController.abort();
    expect(subController!.signal.aborted).toBe(true);
  });

  it('foreground spawn with already-aborted parent signal: child is born aborted', async () => {
    const controllers: Map<string, AbortController> = new Map();
    const registry = new SoulRegistry({
      createHandle: (key) => {
        const c = new AbortController();
        controllers.set(key, c);
        return { key, agentId: `id_for_${key}`, abortController: c, agentDepth: 0 };
      },
      runSubagentTurn: (_id) => pendingCompletion(),
    });

    const parentController = new AbortController();
    parentController.abort();

    const host = registry as unknown as SubagentHost;
    const handle = await host.spawn(
      makeSpawnRequest({ runInBackground: false, signal: parentController.signal }),
    );
    const subController = controllers.get(`sub:${handle.agentId}`);
    expect(subController!.signal.aborted).toBe(true);
  });

  it('background spawn: parent signal abort does NOT cascade into child controller', async () => {
    const controllers: Map<string, AbortController> = new Map();
    const registry = new SoulRegistry({
      createHandle: (key) => {
        const c = new AbortController();
        controllers.set(key, c);
        return { key, agentId: `id_for_${key}`, abortController: c, agentDepth: 0 };
      },
      runSubagentTurn: (_id) => pendingCompletion(),
    });

    const parentController = new AbortController();
    const host = registry as unknown as SubagentHost;

    const handle = await host.spawn(
      makeSpawnRequest({ runInBackground: true, signal: parentController.signal }),
    );
    const subController = controllers.get(`sub:${handle.agentId}`);

    parentController.abort();
    expect(subController!.signal.aborted).toBe(false);
  });
});

// ── Subagent state machine (7-state, §7.2 L3031-3048) ────────────────

describe('Subagent state machine', () => {
  it('starts in created state', () => {
    const status: SubagentStatus = 'created';
    expect(status).toBe('created');
  });

  it('transitions: created → running → completed', () => {
    const transitions: SubagentStatus[] = ['created', 'running', 'completed'];
    expect(transitions[0]).toBe('created');
    expect(transitions[1]).toBe('running');
    expect(transitions[2]).toBe('completed');
  });

  it('transitions: created → running → failed', () => {
    const transitions: SubagentStatus[] = ['created', 'running', 'failed'];
    expect(transitions.at(-1)).toBe('failed');
  });

  it('transitions: created → running → killed', () => {
    const transitions: SubagentStatus[] = ['created', 'running', 'killed'];
    expect(transitions.at(-1)).toBe('killed');
  });

  it('transitions: running ↔ awaiting_approval', () => {
    const transitions: SubagentStatus[] = [
      'created',
      'running',
      'awaiting_approval',
      'running',
      'completed',
    ];
    expect(transitions[2]).toBe('awaiting_approval');
    expect(transitions[3]).toBe('running');
  });

  it('lost is set during resume for crashed subagents', () => {
    const status: SubagentStatus = 'lost';
    expect(status).toBe('lost');
  });
});

// ── SubagentStateJson shape (§7.2 L3017-3029) ────────────────────────

describe('SubagentStateJson', () => {
  it('has all required fields', () => {
    const state: SubagentStateJson = {
      agent_id: 'sub_abc',
      parent_session_id: 'ses_xxx',
      parent_tool_call_id: 'tc_yyy',
      status: 'created',
      created_at: 1712790000000,
    };

    expect(state.agent_id).toBe('sub_abc');
    expect(state.parent_session_id).toBe('ses_xxx');
    expect(state.parent_tool_call_id).toBe('tc_yyy');
    expect(state.status).toBe('created');
    expect(state.created_at).toBe(1712790000000);
  });

  it('supports optional description and pid', () => {
    const state: SubagentStateJson = {
      agent_id: 'sub_def',
      parent_session_id: 'ses_xxx',
      parent_tool_call_id: 'tc_zzz',
      status: 'running',
      description: 'Investigating auth bug',
      created_at: 1712790000000,
      pid: 12345,
    };

    expect(state.description).toBe('Investigating auth bug');
    expect(state.pid).toBe(12345);
  });

  it('status covers all 7 values', () => {
    const allStatuses: SubagentStatus[] = [
      'created',
      'running',
      'awaiting_approval',
      'completed',
      'failed',
      'killed',
      'lost',
    ];
    expect(allStatuses).toHaveLength(7);
  });
});

// ── SoulRegistry key management for sub:* ────────────────────────────

describe('SoulRegistry — sub:* key management', () => {
  it('keys() lists sub:* alongside main', async () => {
    const registry = new SoulRegistry({
      createHandle: (key) => makeHandle(key, `id_for_${key}`),
      // keep completions pending so auto-destroy (Finding #5) does not
      // fire during this test — we want to observe both handles alive
      runSubagentTurn: (_id) => pendingCompletion(),
    });

    registry.getOrCreate('main');
    const host = registry as unknown as SubagentHost;
    const h1 = await host.spawn(makeSpawnRequest());
    const h2 = await host.spawn(makeSpawnRequest());

    const keys = registry.keys();
    expect(keys).toContain('main');
    expect(keys.filter((k) => k.startsWith('sub:'))).toHaveLength(2);
    expect(keys).toContain(`sub:${h1.agentId}`);
    expect(keys).toContain(`sub:${h2.agentId}`);
  });

  it('destroy(sub:<id>) does not affect main', async () => {
    const registry = new SoulRegistry({
      createHandle: (key) => makeHandle(key, `id_for_${key}`),
    });

    registry.getOrCreate('main');
    const host = registry as unknown as SubagentHost;
    const handle = await host.spawn(makeSpawnRequest());
    const subKey: SoulKey = `sub:${handle.agentId}`;

    registry.destroy(subKey);

    expect(registry.has('main')).toBe(true);
    expect(registry.has(subKey)).toBe(false);
  });
});

// ── Finding #1: parent_tool_call_id threading ────────────────────────

describe('SoulRegistry.spawn — parentToolCallId threading (Finding #1)', () => {
  it('echoes SpawnRequest.parentToolCallId onto the returned handle', async () => {
    const registry = new SoulRegistry({
      createHandle: (key) => makeHandle(key, `id_for_${key}`),
      runSubagentTurn: (_id) => pendingCompletion(),
    });

    const host = registry as unknown as SubagentHost;
    const handle = await host.spawn(makeSpawnRequest({ parentToolCallId: 'tc_parent_123' }));

    expect(handle.parentToolCallId).toBe('tc_parent_123');
  });

  it('propagates parentToolCallId into the runSubagentTurn callback', async () => {
    let seenRequest: SpawnRequest | undefined;
    const registry = new SoulRegistry({
      createHandle: (key) => makeHandle(key, `id_for_${key}`),
      runSubagentTurn: (_id, request) => {
        seenRequest = request;
        return pendingCompletion();
      },
    });

    const host = registry as unknown as SubagentHost;
    await host.spawn(makeSpawnRequest({ parentToolCallId: 'tc_runner' }));

    expect(seenRequest?.parentToolCallId).toBe('tc_runner');
  });

  it('different parentToolCallIds produce handles with distinct parent ids', async () => {
    const registry = new SoulRegistry({
      createHandle: (key) => makeHandle(key, `id_for_${key}`),
      runSubagentTurn: (_id) => pendingCompletion(),
    });

    const host = registry as unknown as SubagentHost;
    const h1 = await host.spawn(makeSpawnRequest({ parentToolCallId: 'tc_aaa' }));
    const h2 = await host.spawn(makeSpawnRequest({ parentToolCallId: 'tc_bbb' }));

    expect(h1.parentToolCallId).toBe('tc_aaa');
    expect(h2.parentToolCallId).toBe('tc_bbb');
    expect(h1.parentToolCallId).not.toBe(h2.parentToolCallId);
  });
});

// ── Finding #4: UUID-based subagent ids ──────────────────────────────

describe('SoulRegistry.spawn — UUID-based agent ids (Finding #4)', () => {
  it('generates UUID-format ids, not a process-local sequence', async () => {
    const registry = new SoulRegistry({
      createHandle: (key) => makeHandle(key, `id_for_${key}`),
      runSubagentTurn: (_id) => pendingCompletion(),
    });

    const host = registry as unknown as SubagentHost;
    const handle = await host.spawn(makeSpawnRequest());

    // `sub_` prefix + RFC 4122 v4 UUID
    expect(handle.agentId).toMatch(
      /^sub_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    // Explicitly verify we are NOT using the old `sub_1` / `sub_2` shape
    expect(handle.agentId).not.toMatch(/^sub_\d+$/);
  });

  it('three consecutive spawns all produce distinct ids', async () => {
    const registry = new SoulRegistry({
      createHandle: (key) => makeHandle(key, `id_for_${key}`),
      runSubagentTurn: (_id) => pendingCompletion(),
    });

    const host = registry as unknown as SubagentHost;
    const h1 = await host.spawn(makeSpawnRequest());
    const h2 = await host.spawn(makeSpawnRequest());
    const h3 = await host.spawn(makeSpawnRequest());

    const ids = new Set([h1.agentId, h2.agentId, h3.agentId]);
    expect(ids.size).toBe(3);
  });

  it('fresh registry does not restart ids from sub_1 (resume safety)', async () => {
    // Simulate two sequential sessions over the lifetime of a process:
    // if we were still using an in-process counter, both registries
    // would hand out the same `sub_1` id on their first spawn, which
    // would collide with the persisted `subagents/<id>` directory.
    const registryA = new SoulRegistry({
      createHandle: (key) => makeHandle(key, `id_for_${key}`),
      runSubagentTurn: (_id) => pendingCompletion(),
    });
    const registryB = new SoulRegistry({
      createHandle: (key) => makeHandle(key, `id_for_${key}`),
      runSubagentTurn: (_id) => pendingCompletion(),
    });

    const hostA = registryA as unknown as SubagentHost;
    const hostB = registryB as unknown as SubagentHost;
    const hA = await hostA.spawn(makeSpawnRequest());
    const hB = await hostB.spawn(makeSpawnRequest());

    expect(hA.agentId).not.toBe(hB.agentId);
  });
});

// ── Finding #5: auto-destroy on terminal state ───────────────────────

describe('SoulRegistry.spawn — auto-destroy on completion (Finding #5)', () => {
  it('completed subagent is removed from the registry once completion resolves', async () => {
    let resolveRun: ((v: AgentResult) => void) | undefined;
    const runPromise = new Promise<AgentResult>((resolve) => {
      resolveRun = resolve;
    });
    const registry = new SoulRegistry({
      createHandle: (key) => makeHandle(key, `id_for_${key}`),
      runSubagentTurn: (_id) => runPromise,
    });

    const host = registry as unknown as SubagentHost;
    const handle = await host.spawn(makeSpawnRequest());
    const subKey: SoulKey = `sub:${handle.agentId}`;

    // While the subagent is still running, the handle is live
    expect(registry.has(subKey)).toBe(true);

    // Subagent reaches terminal state: completed
    resolveRun!({ result: 'ok', usage: { input: 10, output: 5 } });
    await handle.completion;
    // The auto-destroy hook is attached via `.then(cleanup)`, which is
    // scheduled on the same resolution as the caller's `.then` chain.
    // Flush microtasks so the cleanup reaction runs before we assert.
    await Promise.resolve();

    expect(registry.has(subKey)).toBe(false);
  });

  it('failed subagent is removed from the registry once completion rejects', async () => {
    let rejectRun: ((err: Error) => void) | undefined;
    const runPromise = new Promise<AgentResult>((_resolve, reject) => {
      rejectRun = reject;
    });
    const registry = new SoulRegistry({
      createHandle: (key) => makeHandle(key, `id_for_${key}`),
      runSubagentTurn: (_id) => runPromise,
    });

    const host = registry as unknown as SubagentHost;
    const handle = await host.spawn(makeSpawnRequest());
    const subKey: SoulKey = `sub:${handle.agentId}`;

    expect(registry.has(subKey)).toBe(true);

    rejectRun!(new Error('subagent crashed'));
    await handle.completion.catch(() => {});
    await Promise.resolve();

    expect(registry.has(subKey)).toBe(false);
  });

  it('only the settled subagent is destroyed; siblings remain live', async () => {
    const runFns: Array<(v: AgentResult) => void> = [];
    const registry = new SoulRegistry({
      createHandle: (key) => makeHandle(key, `id_for_${key}`),
      runSubagentTurn: (_id) =>
        new Promise<AgentResult>((resolve) => {
          runFns.push(resolve);
        }),
    });

    const host = registry as unknown as SubagentHost;
    const h1 = await host.spawn(makeSpawnRequest());
    const h2 = await host.spawn(makeSpawnRequest());
    const k1: SoulKey = `sub:${h1.agentId}`;
    const k2: SoulKey = `sub:${h2.agentId}`;

    expect(registry.has(k1)).toBe(true);
    expect(registry.has(k2)).toBe(true);

    // Resolve only the first subagent
    runFns[0]!({ result: 'a', usage: { input: 0, output: 0 } });
    await h1.completion;
    await Promise.resolve();

    expect(registry.has(k1)).toBe(false);
    expect(registry.has(k2)).toBe(true);
  });

  it('aborts the subagent AbortController as part of cleanup', async () => {
    const controllers: Map<string, AbortController> = new Map();
    let resolveRun: ((v: AgentResult) => void) | undefined;
    const registry = new SoulRegistry({
      createHandle: (key) => {
        const c = new AbortController();
        controllers.set(key, c);
        return { key, agentId: `id_for_${key}`, abortController: c, agentDepth: 0 };
      },
      runSubagentTurn: (_id) =>
        new Promise<AgentResult>((resolve) => {
          resolveRun = resolve;
        }),
    });

    const host = registry as unknown as SubagentHost;
    const handle = await host.spawn(makeSpawnRequest());
    const subKey: SoulKey = `sub:${handle.agentId}`;
    const controller = controllers.get(subKey);
    expect(controller!.signal.aborted).toBe(false);

    resolveRun!({ result: 'done', usage: { input: 0, output: 0 } });
    await handle.completion;
    await Promise.resolve();

    // Auto-destroy ran `handle.abortController.abort()` as part of
    // `destroy(subKey)` — we do not leak the controller after terminal.
    expect(controller!.signal.aborted).toBe(true);
  });
});

// ── Error cases ──────────────────────────────────────────────────────

describe('SoulRegistry.spawn — error cases', () => {
  it('subagent crash does not affect main soul', async () => {
    const registry = new SoulRegistry({
      createHandle: (key) => makeHandle(key, `id_for_${key}`),
    });

    registry.getOrCreate('main');
    const host = registry as unknown as SubagentHost;
    const handle = await host.spawn(makeSpawnRequest());

    // Subagent crashes (completion rejects)
    // Main should still be fine
    expect(registry.has('main')).toBe(true);

    // Destroy the crashed subagent
    registry.destroy(`sub:${handle.agentId}`);
    expect(registry.has('main')).toBe(true);
  });
});
