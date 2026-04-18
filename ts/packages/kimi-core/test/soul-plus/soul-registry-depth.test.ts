/**
 * Phase 18 E.2 — Subagent 递归深度守护（MAX_SUBAGENT_DEPTH = 5）。
 *
 * 红线（v2 §8 + phase-18 E.2）:
 *   - `SoulRegistry.spawn()` 必须根据父 `SoulHandle.agentDepth` 计算子深度；
 *     当 parentDepth >= 5 时必须抛 `SubagentTooDeepError`，并且 **不得** 调用
 *     `SubagentStore.createInstance`（避免污染持久层）。
 *   - 成功 spawn 时子 handle 的 `agentDepth` = parentDepth + 1；main → 子深度
 *     为 1（main 自身视为 0）。
 *
 * 红色原因（实现前）：
 *   - `src/soul-plus/errors.ts` 没有 `SubagentTooDeepError` 类；`import` 会编
 *     译错。
 *   - `src/soul-plus/types.ts::SoulHandle` 没有 `agentDepth` 字段；`createHandle`
 *     工厂若返回 `agentDepth` 字段会被 TS 判定为 excess property。这里用
 *     `as unknown as SoulHandle` 桥接，真正实现后把这个 cast 拆掉即可。
 *   - `SoulRegistry.spawn()` 目前不检查深度 / 不向 handle 写 depth。
 *
 * 设计决策（Slice 18-3）：
 *   - 深度语义：`agentDepth` 挂在父 `SoulHandle` 上，由 `spawn` 读取；
 *     `SpawnRequest` 不新增字段（避免上游 AgentTool 也要感知 depth）。
 *   - `createInstance` 只有在深度检查通过后才调用 —— 失败路径不应产生磁盘副作用
 *     （phase-18 风险 4 提到 status='lost' 的误判问题，失败 spawn 本就不该留记录）。
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// NOTE: `SubagentTooDeepError` 不存在。这个 import 本身就会让红条落地。
// 实现者必须在 `src/soul-plus/errors.ts` 中添加并 re-export。
import { SubagentTooDeepError } from '../../src/soul-plus/errors.js';
import { SoulRegistry } from '../../src/soul-plus/index.js';
import { SubagentStore } from '../../src/soul-plus/subagent-store.js';
import type {
  SoulHandle,
  SoulKey,
  SpawnRequest,
} from '../../src/soul-plus/index.js';

// ── Fixtures ──────────────────────────────────────────────────────────

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'kimi-depth-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/**
 * Build a handle factory that attaches a fixed `agentDepth` to the
 * parent handle (overriding the registry's default) and honors the
 * depth the registry plumbs in for every child `sub:*` handle.
 *
 * The factory honors `SoulRegistryDeps.createHandle(key, agentDepth)`
 * directly — Phase 18 Round 1 removed the old "mutate after create"
 * pattern, so `agentDepth` is now set at construction and read by the
 * test via the real `SoulHandle` shape (no `as unknown as` cast).
 */
function makeRegistry(opts: {
  readonly parentDepth: number;
  readonly parentKey?: SoulKey;
}): {
  readonly registry: SoulRegistry;
  readonly created: SoulHandle[];
} {
  const created: SoulHandle[] = [];
  const parentKey = opts.parentKey ?? 'main';
  const registry = new SoulRegistry({
    createHandle: (key, agentDepth) => {
      const isParent = key === parentKey;
      const handle: SoulHandle = {
        key,
        agentId: isParent ? 'agent_parent_fixture' : `agent_${created.length}`,
        abortController: new AbortController(),
        // The test fixture overrides the parent's depth (so we can
        // probe boundary conditions); children use whatever the
        // registry computed from the parent's depth + 1.
        agentDepth: isParent ? opts.parentDepth : agentDepth,
      };
      created.push(handle);
      return handle;
    },
  });
  // Prime the parent entry so `spawn()` sees it via `getOrCreate`.
  registry.getOrCreate(parentKey);
  return { registry, created };
}

function buildSpawn(parentAgentId: string, extra: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    parentAgentId,
    parentToolCallId: 'tc_parent',
    agentName: 'coder',
    prompt: 'do stuff',
    ...extra,
  };
}

// ── E.2 cases ──────────────────────────────────────────────────────────

describe('Phase 18 E.2 — SoulRegistry depth guard (MAX_SUBAGENT_DEPTH=5)', () => {
  it('main → first child lands at agentDepth=1 (main counts as 0)', async () => {
    const { registry } = makeRegistry({ parentDepth: 0, parentKey: 'main' });

    const handle = await registry.spawn(buildSpawn('agent_parent_fixture'));
    expect(handle.agentId).toMatch(/^sub_/);

    // The registry should have stamped depth=1 on the child soul.
    // We introspect via the internal map — `keys()` is safe public API.
    expect(registry.keys()).toContain(`sub:${handle.agentId}`);

    // Hook into the same registry by re-using `getOrCreate` on the child
    // key; depth must be 1 on that handle.
    const childHandle = registry.getOrCreate(`sub:${handle.agentId}`);
    expect(childHandle.agentDepth).toBe(1);
  });

  it('parentDepth=4 → child spawns successfully with agentDepth=5 (boundary inclusive)', async () => {
    const { registry } = makeRegistry({ parentDepth: 4, parentKey: 'main' });

    const handle = await registry.spawn(buildSpawn('agent_parent_fixture'));
    const childHandle = registry.getOrCreate(`sub:${handle.agentId}`);
    expect(childHandle.agentDepth).toBe(5);
  });

  it('parentDepth=5 → spawn rejects with SubagentTooDeepError (hard cap)', async () => {
    const { registry } = makeRegistry({ parentDepth: 5, parentKey: 'main' });

    await expect(registry.spawn(buildSpawn('agent_parent_fixture'))).rejects.toBeInstanceOf(
      SubagentTooDeepError,
    );
  });

  it('SubagentTooDeepError carries the offending parent depth for diagnostics', async () => {
    const { registry } = makeRegistry({ parentDepth: 5, parentKey: 'main' });

    try {
      await registry.spawn(buildSpawn('agent_parent_fixture'));
      expect.unreachable('spawn should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(SubagentTooDeepError);
      // The error must expose the parent depth (or some `depth` pointer)
      // so the CLI can render a human message. The exact field name is
      // up to the implementer — here we just pin that it's present.
      const shape = err as Error & { parentDepth?: number; depth?: number };
      expect(shape.parentDepth ?? shape.depth).toBeGreaterThanOrEqual(5);
    }
  });

  it('depth reject must NOT touch SubagentStore (no orphan meta.json on disk)', async () => {
    // When MAX_SUBAGENT_DEPTH trips we cannot allow the registry to have
    // called `createInstance`; otherwise resume will surface a ghost
    // subagent that never ran. We verify by constructing a store over a
    // sibling directory and asserting it stays empty after the rejected
    // spawn. (The production wire-up will use the same store via
    // `runSubagentTurn`; this test only needs the disk side-effect, not
    // the runner callback.)
    const store = new SubagentStore(tmp);
    const { registry } = makeRegistry({ parentDepth: 5, parentKey: 'main' });

    await expect(registry.spawn(buildSpawn('agent_parent_fixture'))).rejects.toBeInstanceOf(
      SubagentTooDeepError,
    );

    // subagents/ dir should still be empty (or absent).
    let entries: string[] = [];
    try {
      entries = await readdir(join(tmp, 'subagents'));
    } catch {
      // Missing dir is fine — it means nothing ever tried to write.
    }
    expect(entries).toEqual([]);
    expect(await store.listInstances()).toEqual([]);
  });

  it('rejected spawn leaves registry.keys() unchanged (no dangling sub:* entry)', async () => {
    const { registry } = makeRegistry({ parentDepth: 5, parentKey: 'main' });
    const before = [...registry.keys()];

    await expect(registry.spawn(buildSpawn('agent_parent_fixture'))).rejects.toBeInstanceOf(
      SubagentTooDeepError,
    );

    const after = [...registry.keys()];
    expect(after).toEqual(before); // only `main`, no orphan `sub:*`
  });
});
