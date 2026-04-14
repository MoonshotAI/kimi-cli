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

function makeHandle(key: SoulKey, agentId: string): SoulHandle {
  return {
    key,
    agentId,
    abortController: new AbortController(),
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
      createHandle: (key) => {
        const c = new AbortController();
        controllers.push(c);
        return { key, agentId: 'agent_main', abortController: c };
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
