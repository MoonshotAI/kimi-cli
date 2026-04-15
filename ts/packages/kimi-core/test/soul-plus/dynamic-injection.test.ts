/**
 * Unit tests for DynamicInjectionManager + built-in providers (Slice 3.6).
 */

import { describe, expect, it, vi } from 'vitest';

import {
  DynamicInjectionManager,
  PlanModeInjectionProvider,
  YoloModeInjectionProvider,
  createDefaultDynamicInjectionManager,
  type DynamicInjectionProvider,
  type InjectionContext,
} from '../../src/soul-plus/dynamic-injection.js';
import type { EphemeralInjection } from '../../src/storage/projector.js';

const baseCtx = (overrides: Partial<InjectionContext> = {}): InjectionContext => ({
  planMode: false,
  permissionMode: 'default',
  turnNumber: 1,
  ...overrides,
});

describe('DynamicInjectionManager', () => {
  it('computes injections from registered providers in order', () => {
    const a: DynamicInjectionProvider = {
      id: 'a',
      getInjections: () => [{ kind: 'system_reminder', content: 'first' }],
    };
    const b: DynamicInjectionProvider = {
      id: 'b',
      getInjections: () => [{ kind: 'system_reminder', content: 'second' }],
    };
    const manager = new DynamicInjectionManager({ initialProviders: [a, b] });

    const out = manager.computeInjections(baseCtx());

    expect(out).toEqual([
      { kind: 'system_reminder', content: 'first' },
      { kind: 'system_reminder', content: 'second' },
    ]);
  });

  it('returns an empty list when no provider emits', () => {
    const manager = new DynamicInjectionManager({
      initialProviders: [
        { id: 'quiet', getInjections: () => [] satisfies readonly EphemeralInjection[] },
      ],
    });
    expect(manager.computeInjections(baseCtx())).toEqual([]);
  });

  it('register is idempotent on id — replacing the previous entry', () => {
    const manager = new DynamicInjectionManager();
    manager.register({
      id: 'x',
      getInjections: () => [{ kind: 'system_reminder', content: 'old' }],
    });
    manager.register({
      id: 'x',
      getInjections: () => [{ kind: 'system_reminder', content: 'new' }],
    });

    expect(manager.list()).toHaveLength(1);
    expect(manager.computeInjections(baseCtx())).toEqual([
      { kind: 'system_reminder', content: 'new' },
    ]);
  });

  it('unregister removes the provider by id', () => {
    const manager = new DynamicInjectionManager({
      initialProviders: [
        { id: 'a', getInjections: () => [{ kind: 'system_reminder', content: 'a' }] },
        { id: 'b', getInjections: () => [{ kind: 'system_reminder', content: 'b' }] },
      ],
    });

    manager.unregister('a');
    expect(manager.list()).toHaveLength(1);
    expect(manager.computeInjections(baseCtx())).toEqual([
      { kind: 'system_reminder', content: 'b' },
    ]);
  });

  it('isolates provider errors — other providers still run', () => {
    const onError = vi.fn();
    const manager = new DynamicInjectionManager({
      initialProviders: [
        {
          id: 'boom',
          getInjections: () => {
            throw new Error('kaboom');
          },
        },
        {
          id: 'good',
          getInjections: () => [{ kind: 'system_reminder', content: 'ok' }],
        },
      ],
      onProviderError: onError,
    });

    const out = manager.computeInjections(baseCtx());
    expect(out).toEqual([{ kind: 'system_reminder', content: 'ok' }]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0].id).toBe('boom');
    expect(onError.mock.calls[0]?.[1]).toBeInstanceOf(Error);
  });
});

describe('PlanModeInjectionProvider', () => {
  it('emits nothing when plan mode is off', () => {
    const provider = new PlanModeInjectionProvider();
    expect(provider.getInjections(baseCtx())).toEqual([]);
  });

  it('emits a system-reminder when plan mode is on', () => {
    const provider = new PlanModeInjectionProvider();
    const out = provider.getInjections(baseCtx({ planMode: true }));
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('system_reminder');
    expect(out[0]?.content as string).toContain('Plan mode is active');
  });

  it('re-emits on every turn while plan mode stays active (no throttle)', () => {
    const provider = new PlanModeInjectionProvider();
    const t1 = provider.getInjections(baseCtx({ planMode: true, turnNumber: 1 }));
    const t5 = provider.getInjections(baseCtx({ planMode: true, turnNumber: 5 }));
    expect(t1).toHaveLength(1);
    expect(t5).toHaveLength(1);
  });
});

describe('YoloModeInjectionProvider', () => {
  it('emits nothing outside bypassPermissions', () => {
    const provider = new YoloModeInjectionProvider();
    expect(provider.getInjections(baseCtx({ permissionMode: 'default' }))).toEqual([]);
    expect(provider.getInjections(baseCtx({ permissionMode: 'acceptEdits' }))).toEqual([]);
  });

  it('emits once on entering bypassPermissions, then stays silent', () => {
    const provider = new YoloModeInjectionProvider();
    const first = provider.getInjections(baseCtx({ permissionMode: 'bypassPermissions' }));
    expect(first).toHaveLength(1);
    expect(first[0]?.content as string).toContain('yolo');

    const second = provider.getInjections(baseCtx({ permissionMode: 'bypassPermissions' }));
    expect(second).toEqual([]);
  });

  it('resets the one-shot after leaving and re-entering bypass mode', () => {
    const provider = new YoloModeInjectionProvider();
    provider.getInjections(baseCtx({ permissionMode: 'bypassPermissions' }));
    // Leave yolo
    provider.getInjections(baseCtx({ permissionMode: 'default' }));
    // Re-enter — one-shot should fire again
    const third = provider.getInjections(baseCtx({ permissionMode: 'bypassPermissions' }));
    expect(third).toHaveLength(1);
  });
});

describe('createDefaultDynamicInjectionManager', () => {
  it('pre-registers plan + yolo providers', () => {
    const manager = createDefaultDynamicInjectionManager();
    const ids = manager.list().map((p) => p.id);
    expect(ids).toEqual(['plan_mode', 'yolo_mode']);
  });

  it('integration — both providers fire when both conditions active', () => {
    const manager = createDefaultDynamicInjectionManager();
    const out = manager.computeInjections({
      planMode: true,
      permissionMode: 'bypassPermissions',
      turnNumber: 1,
    });
    expect(out).toHaveLength(2);
    expect(out[0]?.content as string).toContain('Plan mode is active');
    expect(out[1]?.content as string).toContain('yolo');
  });
});
