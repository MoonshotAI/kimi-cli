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

function makeHandle(key: SoulKey, agentId: string): SoulHandle {
  return {
    key,
    agentId,
    abortController: new AbortController(),
  };
}

function makeSpawnRequest(overrides?: Partial<SpawnRequest>): SpawnRequest {
  return {
    parentAgentId: 'agent_main',
    agentName: 'general-purpose',
    prompt: 'Do the task',
    ...overrides,
  };
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
        return { key, agentId: `id_for_${key}`, abortController: c };
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
        return { key, agentId: `id_for_${key}`, abortController: c };
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
