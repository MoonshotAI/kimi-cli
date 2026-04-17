/**
 * Phase 17 B.2 补齐 — ApprovalStateStore.setYolo + onChanged 钩子。
 *
 * 当前 `ApprovalStateStore` 只有 `load()` / `save(actions)`（见
 * `src/soul-plus/approval-state-store.ts:23-28`）。Python 的
 * `ApprovalState` 持有独立的 `yolo: bool` 字段（`kimi_cli/soul/approval.py:62`）
 * 并通过 `notify_change()` 回调把 yolo / auto_approve_actions 的变化
 * 广播给订阅者（Python `set_yolo` / `approve_for_session` 里调）。
 *
 * Phase 18 Section A.5 `session.setYolo` wire method 依赖：
 *   1. `store.setYolo(enabled)` — 独立字段读写，不与 auto-approve 混淆
 *   2. `store.getYolo()` — 读当前 yolo 状态
 *   3. `store.onChanged(listener)` — 订阅状态变化；set_yolo 触发 listener
 *   4. save(actions) 也要触发同一个 onChanged（Python parity，
 *      `approve_for_session` 路径）
 *
 * 当前 src 还没提供以上 API；所有测试预期失败，由 Phase 17 补齐实装者
 * 扩展接口后转绿。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StateCache } from '../../src/session/state-cache.js';
import {
  InMemoryApprovalStateStore,
  SessionStateApprovalStateStore,
  type ApprovalStateStore,
} from '../../src/soul-plus/approval-state-store.js';

// ── Shared contract (runs against both implementations) ───────────────

function runContract(
  label: string,
  factory: () => Promise<ApprovalStateStore> | ApprovalStateStore,
): void {
  describe(`${label} — Phase 18 yolo contract`, () => {
    it('getYolo defaults to false', async () => {
      const store = await factory();
      // New API — not on the current interface.
      expect(
        (store as unknown as { getYolo?: () => Promise<boolean> | boolean })
          .getYolo,
      ).toBeTypeOf('function');
      const yolo = await (
        store as unknown as { getYolo: () => Promise<boolean> | boolean }
      ).getYolo();
      expect(yolo).toBe(false);
    });

    it('setYolo(true) then getYolo() returns true (persisted)', async () => {
      const store = await factory();
      await (
        store as unknown as {
          setYolo: (enabled: boolean) => Promise<void>;
        }
      ).setYolo(true);
      const yolo = await (
        store as unknown as { getYolo: () => Promise<boolean> | boolean }
      ).getYolo();
      expect(yolo).toBe(true);
    });

    it('setYolo fires onChanged with the new yolo value', async () => {
      const store = await factory();
      const listener = vi.fn();
      (
        store as unknown as {
          onChanged: (l: (snapshot: unknown) => void) => void;
        }
      ).onChanged(listener);

      await (
        store as unknown as { setYolo: (enabled: boolean) => Promise<void> }
      ).setYolo(true);

      expect(listener).toHaveBeenCalledTimes(1);
      // The listener snapshot must surface the new yolo flag so
      // downstream observers (wire record writer) can reflect it.
      const arg = listener.mock.calls[0]?.[0] as
        | { yolo?: boolean }
        | undefined;
      expect(arg?.yolo).toBe(true);
    });

    it('save(actions) also fires onChanged (actions changed)', async () => {
      const store = await factory();
      const listener = vi.fn();
      (
        store as unknown as {
          onChanged: (l: (snapshot: unknown) => void) => void;
        }
      ).onChanged(listener);

      await store.save(new Set(['run command']));

      expect(listener).toHaveBeenCalled();
    });

    it('setYolo(false) after (true) still fires onChanged', async () => {
      const store = await factory();
      const listener = vi.fn();
      (
        store as unknown as {
          onChanged: (l: (snapshot: unknown) => void) => void;
        }
      ).onChanged(listener);

      await (
        store as unknown as { setYolo: (enabled: boolean) => Promise<void> }
      ).setYolo(true);
      await (
        store as unknown as { setYolo: (enabled: boolean) => Promise<void> }
      ).setYolo(false);

      expect(listener).toHaveBeenCalledTimes(2);
    });

    it('store without any onChanged subscriber does not crash on setYolo', async () => {
      const store = await factory();
      // No listener registered — must still succeed silently.
      await expect(
        (
          store as unknown as {
            setYolo: (enabled: boolean) => Promise<void>;
          }
        ).setYolo(true),
      ).resolves.toBeUndefined();
    });
  });
}

// ── In-memory contract ─────────────────────────────────────────────────

runContract('InMemoryApprovalStateStore', () => new InMemoryApprovalStateStore());

// ── Session-state-backed contract (persisted to state.json) ────────────

describe('SessionStateApprovalStateStore — yolo persists across reload', () => {
  let dir: string;
  let cache: StateCache;
  const now = 1700000000000;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'slice18-yolo-'));
    cache = new StateCache(join(dir, 'state.json'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  runContract('SessionStateApprovalStateStore', () => {
    return new SessionStateApprovalStateStore(cache, 'sess_1', () => now);
  });

  it('yolo=true survives a StateCache reload via state.json', async () => {
    const store = new SessionStateApprovalStateStore(
      cache,
      'sess_1',
      () => now,
    );
    await (
      store as unknown as { setYolo: (enabled: boolean) => Promise<void> }
    ).setYolo(true);

    // Build a second store pointing at the same state.json file.
    const reloaded = new SessionStateApprovalStateStore(
      new StateCache(join(dir, 'state.json')),
      'sess_1',
      () => now,
    );
    const yolo = await (
      reloaded as unknown as {
        getYolo: () => Promise<boolean> | boolean;
      }
    ).getYolo();
    expect(yolo).toBe(true);
  });
});
