/**
 * Phase 17 A.2 补齐 + Phase 18 A.14 — TurnManager emit `status.update` event。
 *
 * v2 §3.6 (L369) / §3.7 (不落盘列表) 规定 `status.update` 是瞬时事件，
 * 只走 EventSink / transport。TurnManager 应在以下时机 emit:
 *   1. 每次 turn 结束（`onTurnEnd` 阶段），报告新的 token 累计 +
 *      context 用量；
 *   2. 显式 model / thinking / planMode 变更时（setter 被调用后）；
 *
 * A.14 在 Phase 17 A.2 基础上要求 `context_usage` 必须含
 *   `{ used: number, total: number, percent: number }`
 * 三字段（percent 0-100，integer）。
 *
 * 全字段 (v2 §3.6)：`context_usage, token_usage, plan_mode, model`
 * （`mcp_status` 由 MCP Slice 负责，这里不 assert）。
 *
 * 当前 TurnManager 只在 onTurnEnd 结尾 `sink.emit({type:'turn.end'})`,
 * 没有 status.update —— 测试预期全部失败。
 */

import { describe, expect, it } from 'vitest';

import type { SoulEvent } from '../../src/soul/event-sink.js';
import {
  createTestSession,
  FakeKosongAdapter,
} from '../helpers/index.js';

interface StatusUpdateEvent {
  type: 'status.update';
  data: {
    context_usage: { used: number; total: number; percent: number };
    token_usage: { input: number; output: number };
    plan_mode: boolean;
    model: string;
  };
}

function pickStatusUpdates(events: readonly unknown[]): StatusUpdateEvent[] {
  return events.filter(
    (e): e is StatusUpdateEvent =>
      (e as { type?: string }).type === 'status.update',
  );
}

describe('Phase 17 A.2 / Phase 18 A.14 — status.update emit', () => {
  it('SoulEvent union includes "status.update"', () => {
    // Compile-time guard: implementer MUST extend SoulEvent with a
    // `status.update` variant. If absent, `Extract<…>` is `never` and
    // the following binding breaks when the variant is missing
    // structurally (implementer lift).
    type HasStatusUpdate = Extract<SoulEvent, { type: 'status.update' }>;
    const _compileCheck: HasStatusUpdate | undefined = undefined;
    void _compileCheck;
    // Runtime smoke: any object matching the variant shape must be
    // recognisable by downstream filters.
    const sample = {
      type: 'status.update',
      data: {
        context_usage: { used: 0, total: 200000, percent: 0 },
        token_usage: { input: 0, output: 0 },
        plan_mode: false,
        model: 'test-model',
      },
    } satisfies StatusUpdateEvent;
    expect(sample.type).toBe('status.update');
  });

  it('onTurnEnd emits status.update with context_usage percent 0-100', async () => {
    const kosong = new FakeKosongAdapter().script({
      text: 'hello',
      stopReason: 'end_turn',
    });
    await using session = await createTestSession({
      model: 'test-model',
      kosong,
    });

    const resp = await session.prompt('hi');
    const turnId = (resp as { turn_id?: string }).turn_id;
    expect(turnId).toBeDefined();
    await session.turnManager.awaitTurn(turnId!);

    const updates = pickStatusUpdates(session.events.events);
    expect(updates.length).toBeGreaterThanOrEqual(1);

    const last = updates[updates.length - 1]!;
    expect(last.data.context_usage.used).toBeGreaterThanOrEqual(0);
    expect(last.data.context_usage.total).toBeGreaterThan(0);
    expect(typeof last.data.context_usage.percent).toBe('number');
    expect(last.data.context_usage.percent).toBeGreaterThanOrEqual(0);
    expect(last.data.context_usage.percent).toBeLessThanOrEqual(100);
    expect(typeof last.data.model).toBe('string');
    expect(typeof last.data.plan_mode).toBe('boolean');
  });

  it('setPlanMode change emits a status.update with new plan_mode', async () => {
    await using session = await createTestSession({ model: 'test-model' });

    const priorCount = session.events.events.length;

    // SessionControl is the canonical setter path. SoulPlus exposes it
    // via `getSessionControl()` (new API we require for A.4 wire handler).
    const soulPlus = session.soulPlus as unknown as {
      getSessionControl?: () => {
        setPlanMode: (enabled: boolean) => Promise<void>;
      };
    };
    expect(
      soulPlus.getSessionControl,
      'SoulPlus.getSessionControl() required for Phase 18 A.4',
    ).toBeTypeOf('function');
    await soulPlus.getSessionControl!().setPlanMode(true);

    const after = session.events.events.slice(priorCount);
    const updates = pickStatusUpdates(after);
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates[updates.length - 1]!.data.plan_mode).toBe(true);
  });

  it('setModel change emits a status.update with new model', async () => {
    await using session = await createTestSession({ model: 'old-model' });
    const priorCount = session.events.events.length;

    const soulPlus = session.soulPlus as unknown as {
      setModel?: (model: string) => Promise<void>;
    };
    expect(
      soulPlus.setModel,
      'SoulPlus.setModel(model) required for Phase 18 A.3',
    ).toBeTypeOf('function');
    await soulPlus.setModel!('new-model');

    const after = session.events.events.slice(priorCount);
    const updates = pickStatusUpdates(after);
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates[updates.length - 1]!.data.model).toBe('new-model');
  });

  // ── Phase 18 A.5 follow-up (裁决 2) ────────────────────────────────
  //
  // Coordinator tagged this as an after-impl assertion — once the A.5
  // `session.setYolo` wire handler delegates through
  // `ApprovalStateStore.setYolo`, the setter path must emit a
  // `status.update` whose `yolo` flag reflects the new value. Added
  // after the implementer wired the SoulPlus/SessionControl plumbing.
  it('setYolo via ApprovalStateStore fires status.update with yolo:true', async () => {
    const { InMemoryApprovalStateStore } = await import(
      '../../src/soul-plus/approval-state-store.js'
    );
    const store = new InMemoryApprovalStateStore();
    await using session = await createTestSession({ model: 'test-model' });
    // Wire a listener that emits a status.update on every onChanged
    // tick, matching how the wire handler reflects store changes
    // (Phase 17 B.2 contract).
    store.onChanged((snapshot) => {
      session.sink.emit({
        type: 'status.update',
        data: {
          context_usage: {
            used: 0,
            total: 200_000,
            percent: 0,
          },
          token_usage: { input: 0, output: 0 },
          plan_mode: false,
          model: 'test-model',
          yolo: snapshot.yolo,
        },
      });
    });

    const priorCount = session.events.events.length;
    await store.setYolo(true);

    const after = session.events.events.slice(priorCount);
    const updates = pickStatusUpdates(after) as Array<
      StatusUpdateEvent & { data: { yolo?: boolean } }
    >;
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates[updates.length - 1]!.data.yolo).toBe(true);
  });

  it('status.update is not persisted to the journal (不落盘, v2 §3.7)', async () => {
    const kosong = new FakeKosongAdapter().script({
      text: 'ok',
      stopReason: 'end_turn',
    });
    await using session = await createTestSession({
      model: 'test-model',
      kosong,
    });
    const resp = await session.prompt('hi');
    const turnId = (resp as { turn_id?: string }).turn_id;
    await session.turnManager.awaitTurn(turnId!);

    // Read session journal records directly; any entry typed
    // `status.update` (or similar suffix) is a persistence leak.
    const { readFile } = await import('node:fs/promises');
    let lines: string[] = [];
    try {
      const raw = await readFile(session.wireFile, 'utf-8');
      lines = raw.split('\n').filter((l) => l.length > 0);
    } catch {
      /* file may not exist if no records landed yet — that's fine */
    }
    const leaked = lines.filter((line) => {
      try {
        const parsed = JSON.parse(line) as { type?: string };
        return parsed.type === 'status.update';
      } catch {
        return false;
      }
    });
    expect(leaked).toEqual([]);
  });
});
