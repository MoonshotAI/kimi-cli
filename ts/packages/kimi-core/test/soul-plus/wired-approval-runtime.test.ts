/* oxlint-disable vitest/warn-todo -- Phase 11 intentionally records src-gap
   placeholders via `it.todo`. Each todo carries a P-level + unblock recipe
   pointing at MIGRATION_REPORT_phase_11.md §附录 B. Do not convert to
   passing tests without landing the referenced src change. */
/**
 * WiredApprovalRuntime — end-to-end regression suite for Slice 2.3.
 *
 * Coverage map (§9 坑位清单 + §5 Python parity):
 *   - Happy path: request → journal append → resolve → waiter settles
 *   - Short-circuit on auto-approve cache
 *   - P0-1: journal append ordering — waiter never settles before WAL
 *   - P0-2: timeout / abort / cancelBySource all write synthetic
 *   - P0-3: approve_for_session cascade resolves same-action pending
 *     without re-entrant recursion
 *   - recoverPendingOnStartup idempotency
 *   - State.json persistence + rule injection
 *   - ingestRemoteRequest / resolveRemote NotImplementedError
 */

import { describe, expect, it, vi } from 'vitest';

import { NotImplementedError } from '../../src/soul-plus/approval-runtime.js';
import { InMemoryApprovalStateStore } from '../../src/soul-plus/approval-state-store.js';
import type { PermissionRule } from '../../src/soul-plus/permission/types.js';
import { WiredApprovalRuntime } from '../../src/soul-plus/wired-approval-runtime.js';
import { InMemorySessionJournalImpl } from '../../src/storage/session-journal.js';
import type { ApprovalDisplay, ApprovalSource, WireRecord } from '../../src/storage/wire-record.js';

function buildRequest(
  overrides: Partial<Parameters<WiredApprovalRuntime['request']>[0]> = {},
): Parameters<WiredApprovalRuntime['request']>[0] {
  return {
    toolCallId: 'tc_1',
    toolName: 'Bash',
    action: 'run command',
    display: { kind: 'command', command: 'ls' } satisfies ApprovalDisplay,
    source: { kind: 'soul', agent_id: 'agent_main' } satisfies ApprovalSource,
    turnId: 'turn_1',
    step: 1,
    ...overrides,
  };
}

function makeRuntime(opts?: {
  records?: readonly WireRecord[];
  initialActions?: Iterable<string>;
  ruleInjector?: (rule: PermissionRule) => void;
}): {
  runtime: WiredApprovalRuntime;
  journal: InMemorySessionJournalImpl;
  store: InMemoryApprovalStateStore;
} {
  const journal = new InMemorySessionJournalImpl();
  const store = new InMemoryApprovalStateStore(opts?.initialActions);
  const runtime = new WiredApprovalRuntime({
    sessionJournal: journal,
    stateStore: store,
    loadJournalRecords: async () => opts?.records ?? [],
    ruleInjector: opts?.ruleInjector,
    allocateRequestId: (() => {
      let counter = 0;
      return () => {
        counter += 1;
        return `req_${String(counter)}`;
      };
    })(),
  });
  return { runtime, journal, store };
}

describe('WiredApprovalRuntime — happy path', () => {
  it('request → journal append → resolve → waiter settles approved', async () => {
    const { runtime, journal } = makeRuntime();
    const promise = runtime.request(buildRequest());

    // Let the WAL append tick so the waiter is installed.
    await new Promise((r) => setImmediate(r));

    expect(runtime.pendingCount).toBe(1);
    const requests = journal.getRecordsByType('approval_request');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.data.request_id).toBe('req_1');

    runtime.resolve('req_1', { response: 'approved' });
    const result = await promise;
    expect(result.approved).toBe(true);

    const responses = journal.getRecordsByType('approval_response');
    expect(responses).toHaveLength(1);
    expect(responses[0]!.data).toMatchObject({ request_id: 'req_1', response: 'approved' });
    expect(runtime.pendingCount).toBe(0);
  });

  it('unknown requestId resolve is a silent no-op', async () => {
    const { runtime } = makeRuntime();
    expect(() => {
      runtime.resolve('missing', { response: 'approved' });
    }).not.toThrow();
  });
});

describe('WiredApprovalRuntime — auto-approve cache short-circuit', () => {
  it('skips wire append when action is already in the cache', async () => {
    const { runtime, journal } = makeRuntime({ initialActions: ['run command'] });
    const result = await runtime.request(buildRequest());
    expect(result.approved).toBe(true);
    expect(journal.getRecordsByType('approval_request')).toHaveLength(0);
    expect(journal.getRecordsByType('approval_response')).toHaveLength(0);
  });
});

describe('WiredApprovalRuntime — journal ordering (P0-1)', () => {
  it('appendApprovalRequest must settle BEFORE waiter is installed', async () => {
    // Mock sessionJournal that delays the append completion and lets us
    // assert the waiter map is empty during the await window.
    let releaseAppend: (() => void) | undefined;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });

    const store = new InMemoryApprovalStateStore();
    const records: WireRecord[] = [];
    const journal = {
      appendApprovalRequest: vi.fn(async (rec) => {
        records.push(rec as WireRecord);
        await appendGate;
      }),
      appendApprovalResponse: vi.fn(async (rec) => {
        records.push(rec as WireRecord);
      }),
      // Unused methods — stub as throws so accidental use is loud.
      appendTurnBegin: vi.fn(),
      appendTurnEnd: vi.fn(),
      appendSkillInvoked: vi.fn(),
      appendSkillCompleted: vi.fn(),
      appendTeamMail: vi.fn(),
      appendToolCallDispatched: vi.fn(),
      appendPermissionModeChanged: vi.fn(),
      appendToolDenied: vi.fn(),
      appendNotification: vi.fn(),
      appendSystemReminder: vi.fn(),
      appendOwnershipChanged: vi.fn(),
    };

    const runtime = new WiredApprovalRuntime({
      sessionJournal: journal as never,
      stateStore: store,
      loadJournalRecords: async () => [],
      allocateRequestId: () => 'req_1',
    });

    const requestPromise = runtime.request(buildRequest());

    // Wait a tick so `request()` has kicked off the append.
    await new Promise((r) => setImmediate(r));
    expect(journal.appendApprovalRequest).toHaveBeenCalledTimes(1);
    // Waiter is NOT installed until the append resolves.
    expect(runtime.pendingCount).toBe(0);

    // Now release the append — waiter must appear on the next tick.
    releaseAppend!();
    await new Promise((r) => setImmediate(r));
    expect(runtime.pendingCount).toBe(1);

    // Resolve and let the caller await settle.
    runtime.resolve('req_1', { response: 'approved' });
    const result = await requestPromise;
    expect(result.approved).toBe(true);
  });
});

describe('WiredApprovalRuntime — timeout / abort / cancelBySource (P0-2)', () => {
  it('abort signal writes a synthetic cancelled response', async () => {
    const { runtime, journal } = makeRuntime();
    const controller = new AbortController();
    const promise = runtime.request(buildRequest(), controller.signal);
    await new Promise((r) => setImmediate(r));
    controller.abort();
    const result = await promise;
    expect(result.approved).toBe(false);
    expect(result.feedback).toContain('cancelled');
    const responses = journal.getRecordsByType('approval_response');
    expect(responses).toHaveLength(1);
    expect(responses[0]!.data.synthetic).toBe(true);
  });

  it('M1 — signal aborted during WAL await still resolves immediately (no 300 s leak)', async () => {
    // Repro: caller aborts the signal while `appendApprovalRequest` is
    // still pending. With the old code the listener was attached AFTER
    // the await, so the already-dispatched abort event was lost and the
    // pending entry sat there until the runtime's hard 300 s timeout
    // cleaned it up. Reviewer M1.
    let releaseAppend: (() => void) | undefined;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });

    const store = new InMemoryApprovalStateStore();
    const responses: unknown[] = [];
    const journal = {
      appendApprovalRequest: vi.fn(async () => {
        await appendGate;
      }),
      appendApprovalResponse: vi.fn(async (rec) => {
        responses.push(rec);
      }),
      appendTurnBegin: vi.fn(),
      appendTurnEnd: vi.fn(),
      appendSkillInvoked: vi.fn(),
      appendSkillCompleted: vi.fn(),
      appendTeamMail: vi.fn(),
      appendToolCallDispatched: vi.fn(),
      appendPermissionModeChanged: vi.fn(),
      appendToolDenied: vi.fn(),
      appendNotification: vi.fn(),
      appendSystemReminder: vi.fn(),
      appendOwnershipChanged: vi.fn(),
    };

    // With no internal runtime timeout (Codex R2 M3), this test relies
    // purely on the abort retroactive trigger — if the trigger fails the
    // request hangs and vitest's default 5 s test timeout kills it.
    const runtime = new WiredApprovalRuntime({
      sessionJournal: journal as never,
      stateStore: store,
      loadJournalRecords: async () => [],
      allocateRequestId: () => 'req_race',
    });

    const controller = new AbortController();
    const promise = runtime.request(buildRequest(), controller.signal);

    // Let `request()` enter the `await appendApprovalRequest` window.
    await new Promise((r) => setImmediate(r));

    // Abort while WAL append is still pending — the abort event is
    // dispatched but no listener is installed yet.
    controller.abort();

    // Now release the WAL append so the listener installation finishes.
    releaseAppend!();

    const result = await promise;
    expect(result.approved).toBe(false);
    expect(result.feedback).toContain('cancelled');
    expect(responses).toHaveLength(1);
    expect((responses[0] as { data: { synthetic?: boolean } }).data.synthetic).toBe(true);
    expect(runtime.pendingCount).toBe(0);
  });

  it('cancelBySource writes synthetic cancelled record and matches source', async () => {
    const { runtime, journal } = makeRuntime();
    const pending1 = runtime.request(
      buildRequest({ toolCallId: 'tc_1', source: { kind: 'subagent', agent_id: 'sub_a' } }),
    );
    const pending2 = runtime.request(
      buildRequest({
        toolCallId: 'tc_2',
        source: { kind: 'subagent', agent_id: 'sub_b' },
      }),
    );
    await new Promise((r) => setImmediate(r));
    expect(runtime.pendingCount).toBe(2);

    runtime.cancelBySource({ kind: 'subagent', agent_id: 'sub_a' });
    const r1 = await pending1;
    expect(r1.approved).toBe(false);
    expect(runtime.pendingCount).toBe(1);

    const responses = journal.getRecordsByType('approval_response');
    expect(responses).toHaveLength(1);
    expect(responses[0]!.data.synthetic).toBe(true);

    // Resolve pending2 separately to drain.
    runtime.resolve('req_2', { response: 'approved' });
    await pending2;
  });
});

describe('WiredApprovalRuntime — approve_for_session cascade (P0-3)', () => {
  it('cascades resolve to other same-action pending on approve_for_session', async () => {
    const rules: PermissionRule[] = [];
    const { runtime, store } = makeRuntime({
      ruleInjector: (r) => rules.push(r),
    });

    const p1 = runtime.request(buildRequest({ toolCallId: 'tc_1', action: 'edit file' }));
    const p2 = runtime.request(buildRequest({ toolCallId: 'tc_2', action: 'edit file' }));
    const p3 = runtime.request(buildRequest({ toolCallId: 'tc_3', action: 'run command' }));
    await new Promise((r) => setImmediate(r));
    expect(runtime.pendingCount).toBe(3);

    runtime.resolve('req_1', { response: 'approved', scope: 'session' });

    const r1 = await p1;
    const r2 = await p2;
    expect(r1.approved).toBe(true);
    expect(r2.approved).toBe(true);
    // p3 has a different action — still pending.
    expect(runtime.pendingCount).toBe(1);

    // Session state + rule injected once per approve_for_session call.
    expect(store.snapshot().has('edit file')).toBe(true);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      decision: 'allow',
      scope: 'session-runtime',
    });

    // Drain p3.
    runtime.resolve('req_3', { response: 'rejected', feedback: 'nope' });
    const r3 = await p3;
    expect(r3.approved).toBe(false);
  });

  it('subsequent same-action requests hit the auto-approve short-circuit', async () => {
    const { runtime, journal } = makeRuntime();
    const p1 = runtime.request(buildRequest({ action: 'edit file' }));
    await new Promise((r) => setImmediate(r));
    runtime.resolve('req_1', { response: 'approved', scope: 'session' });
    await p1;

    const requestCountBefore = journal.getRecordsByType('approval_request').length;
    const r2 = await runtime.request(buildRequest({ action: 'edit file' }));
    expect(r2.approved).toBe(true);
    // No new wire record appended — short-circuited.
    expect(journal.getRecordsByType('approval_request').length).toBe(requestCountBefore);
  });
});

describe('WiredApprovalRuntime — recoverPendingOnStartup', () => {
  it('writes synthetic cancelled responses for dangling requests', async () => {
    const danglingRequest: WireRecord = {
      type: 'approval_request',
      seq: 1,
      time: 0,
      turn_id: 'turn_x',
      step: 7,
      data: {
        request_id: 'dangling_1',
        tool_call_id: 'tc_a',
        tool_name: 'Bash',
        action: 'run command',
        display: { kind: 'command', command: 'echo' },
        source: { kind: 'soul', agent_id: 'agent_main' },
      },
    };

    const { runtime, journal } = makeRuntime({ records: [danglingRequest] });
    await runtime.recoverPendingOnStartup();

    const responses = journal.getRecordsByType('approval_response');
    expect(responses).toHaveLength(1);
    expect(responses[0]!.data).toMatchObject({
      request_id: 'dangling_1',
      response: 'cancelled',
      synthetic: true,
    });
    expect(responses[0]!.turn_id).toBe('turn_x');
    expect(responses[0]!.step).toBe(7);
  });

  it('is idempotent — running a second time sees no dangling', async () => {
    // After first run, subsequent loadJournalRecords() should reflect the
    // now-balanced state. Simulate with a records supplier that switches.
    const journal = new InMemorySessionJournalImpl();
    const store = new InMemoryApprovalStateStore();
    let records: WireRecord[] = [
      {
        type: 'approval_request',
        seq: 1,
        time: 0,
        turn_id: 'turn_x',
        step: 1,
        data: {
          request_id: 'd1',
          tool_call_id: 'tc_a',
          tool_name: 'Bash',
          action: 'run command',
          display: { kind: 'command', command: 'ls' },
          source: { kind: 'soul', agent_id: 'agent_main' },
        },
      },
    ];

    const runtime = new WiredApprovalRuntime({
      sessionJournal: journal,
      stateStore: store,
      loadJournalRecords: async () => records,
    });

    await runtime.recoverPendingOnStartup();
    expect(journal.getRecordsByType('approval_response')).toHaveLength(1);

    // The next boot sees both the original request + the synthetic
    // response we just wrote — so `pendingMap` becomes empty.
    records = [
      ...records,
      ...journal.getRecordsByType('approval_response').map((r) => r as WireRecord),
    ];
    await runtime.recoverPendingOnStartup();
    // Still only 1 response — no duplicate synthetic written.
    expect(journal.getRecordsByType('approval_response')).toHaveLength(1);
  });
});

// ── Codex Round 2 regression tests ──────────────────────────────────

describe('WiredApprovalRuntime — C1: WAL failure rejects waiter instead of orphan', () => {
  it('resolve path rejects the caller when appendApprovalResponse throws', async () => {
    const store = new InMemoryApprovalStateStore();
    const journal = {
      appendApprovalRequest: vi.fn(async () => {}),
      appendApprovalResponse: vi.fn(async () => {
        throw new Error('disk full');
      }),
      appendTurnBegin: vi.fn(),
      appendTurnEnd: vi.fn(),
      appendSkillInvoked: vi.fn(),
      appendSkillCompleted: vi.fn(),
      appendTeamMail: vi.fn(),
      appendToolCallDispatched: vi.fn(),
      appendPermissionModeChanged: vi.fn(),
      appendToolDenied: vi.fn(),
      appendNotification: vi.fn(),
      appendSystemReminder: vi.fn(),
      appendOwnershipChanged: vi.fn(),
    };

    const runtime = new WiredApprovalRuntime({
      sessionJournal: journal as never,
      stateStore: store,
      loadJournalRecords: async () => [],
      allocateRequestId: () => 'req_1',
    });

    const pending = runtime.request(buildRequest());
    // Attach rejection handler early to prevent PromiseRejectionHandledWarning
    const guarded = pending.catch((error: unknown) => {
      throw error;
    });
    await new Promise((r) => setImmediate(r));

    runtime.resolve('req_1', { response: 'approved' });
    await expect(guarded).rejects.toThrow('disk full');
    expect(runtime.pendingCount).toBe(0);
  });

  it('cancelOne path rejects the caller when appendApprovalResponse throws', async () => {
    const store = new InMemoryApprovalStateStore();
    const journal = {
      appendApprovalRequest: vi.fn(async () => {}),
      appendApprovalResponse: vi.fn(async () => {
        throw new Error('disk full');
      }),
      appendTurnBegin: vi.fn(),
      appendTurnEnd: vi.fn(),
      appendSkillInvoked: vi.fn(),
      appendSkillCompleted: vi.fn(),
      appendTeamMail: vi.fn(),
      appendToolCallDispatched: vi.fn(),
      appendPermissionModeChanged: vi.fn(),
      appendToolDenied: vi.fn(),
      appendNotification: vi.fn(),
      appendSystemReminder: vi.fn(),
      appendOwnershipChanged: vi.fn(),
    };

    const runtime = new WiredApprovalRuntime({
      sessionJournal: journal as never,
      stateStore: store,
      loadJournalRecords: async () => [],
      allocateRequestId: () => 'req_1',
    });

    const controller = new AbortController();
    const pending = runtime.request(buildRequest(), controller.signal);
    // Attach rejection handler early to prevent PromiseRejectionHandledWarning
    const guarded = pending.catch((error: unknown) => {
      throw error;
    });
    await new Promise((r) => setImmediate(r));

    controller.abort();
    await expect(guarded).rejects.toThrow('disk full');
    expect(runtime.pendingCount).toBe(0);
  });
});

describe('WiredApprovalRuntime — M1: approve_for_session catches WAL-window request', () => {
  it('retroactively auto-approves a request stuck in WAL window during approve_for_session', async () => {
    let releaseB!: () => void;
    const gateB = new Promise<void>((r) => (releaseB = r));

    const store = new InMemoryApprovalStateStore();
    let idCounter = 0;
    const journal = {
      appendApprovalRequest: vi.fn(async (rec: { data: { request_id: string } }) => {
        if (rec.data.request_id === 'req_2') await gateB;
      }),
      appendApprovalResponse: vi.fn(async () => {}),
      appendTurnBegin: vi.fn(),
      appendTurnEnd: vi.fn(),
      appendSkillInvoked: vi.fn(),
      appendSkillCompleted: vi.fn(),
      appendTeamMail: vi.fn(),
      appendToolCallDispatched: vi.fn(),
      appendPermissionModeChanged: vi.fn(),
      appendToolDenied: vi.fn(),
      appendNotification: vi.fn(),
      appendSystemReminder: vi.fn(),
      appendOwnershipChanged: vi.fn(),
    };

    const runtime = new WiredApprovalRuntime({
      sessionJournal: journal as never,
      stateStore: store,
      loadJournalRecords: async () => [],
      allocateRequestId: () => {
        idCounter += 1;
        return `req_${String(idCounter)}`;
      },
    });

    const pA = runtime.request(buildRequest({ toolCallId: 'a', action: 'edit file' }));
    await new Promise((r) => setImmediate(r));

    // req_2 starts but blocks in WAL append — not yet in pending
    const pB = runtime.request(buildRequest({ toolCallId: 'b', action: 'edit file' }));
    await new Promise((r) => setImmediate(r));

    // approve_for_session resolves req_1 and adds "edit file" to cache
    runtime.resolve('req_1', { response: 'approved', scope: 'session' });
    await pA;

    // Release req_2 from WAL — it should retroactively auto-approve
    releaseB();
    const resultB = await pB;
    expect(resultB.approved).toBe(true);
    expect(runtime.pendingCount).toBe(0);
  });
});

describe('WiredApprovalRuntime — M2: cancelBySource catches WAL-window request', () => {
  it('retroactively cancels a request stuck in WAL window during cancelBySource', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    const store = new InMemoryApprovalStateStore();
    const journal = {
      appendApprovalRequest: vi.fn(async () => {
        await gate;
      }),
      appendApprovalResponse: vi.fn(async () => {}),
      appendTurnBegin: vi.fn(),
      appendTurnEnd: vi.fn(),
      appendSkillInvoked: vi.fn(),
      appendSkillCompleted: vi.fn(),
      appendTeamMail: vi.fn(),
      appendToolCallDispatched: vi.fn(),
      appendPermissionModeChanged: vi.fn(),
      appendToolDenied: vi.fn(),
      appendNotification: vi.fn(),
      appendSystemReminder: vi.fn(),
      appendOwnershipChanged: vi.fn(),
    };

    const runtime = new WiredApprovalRuntime({
      sessionJournal: journal as never,
      stateStore: store,
      loadJournalRecords: async () => [],
      allocateRequestId: () => 'req_1',
    });

    const p = runtime.request(buildRequest({ source: { kind: 'subagent', agent_id: 'sub_a' } }));
    await new Promise((r) => setImmediate(r));

    // Cancel while request is still in WAL window
    runtime.cancelBySource({ kind: 'subagent', agent_id: 'sub_a' });

    // Release WAL — retroactive check should cancel
    release();
    const result = await p;
    expect(result.approved).toBe(false);
    expect(result.feedback).toContain('cancelled by source');
    expect(runtime.pendingCount).toBe(0);
  });
});

describe('WiredApprovalRuntime — M3: no internal timer, timeout from outer wrapper', () => {
  it('runtime has no internal timeout — pending entry survives until signal abort', async () => {
    // Without internal timeout, the runtime entry stays pending
    // indefinitely. Only signal abort cleans it up.
    const { runtime, journal } = makeRuntime();
    const controller = new AbortController();
    const promise = runtime.request(buildRequest(), controller.signal);
    await new Promise((r) => setImmediate(r));

    // No internal timer — entry is still pending well after any realistic
    // inner timeout would have fired.
    await new Promise((r) => setTimeout(r, 50));
    expect(runtime.pendingCount).toBe(1);

    // Signal abort cleans up
    controller.abort();
    const result = await promise;
    expect(result.approved).toBe(false);
    expect(result.feedback).toContain('cancelled');
    expect(runtime.pendingCount).toBe(0);

    const responses = journal.getRecordsByType('approval_response');
    expect(responses).toHaveLength(1);
    expect(responses[0]!.data.synthetic).toBe(true);
  });
});

// ── Phase 11.5 — caller-driven timeout + subagent_type passthrough ───

describe('WiredApprovalRuntime — Phase 11.5 caller-driven timeout', () => {
  it('caller AbortController + setTimeout() cancels pending request with synthetic response', async () => {
    // Python parity: `tests/core/test_approval_runtime.py:208` wait_for_response(timeout=0.05).
    // TS v2 M3: runtime has NO internal timer. Caller is the sole timeout source.
    // Fake timers per Phase 11 R3 — advance the clock deterministically so
    // the test is not wall-clock bound.
    vi.useFakeTimers();
    try {
      const { runtime, journal } = makeRuntime();
      const controller = new AbortController();
      setTimeout(() => {
        controller.abort();
      }, 50);

      const resultPromise = runtime.request(buildRequest(), controller.signal);

      // Advance past the caller-configured deadline. The abort fires,
      // synthetic cancelled response lands on the waiter.
      await vi.advanceTimersByTimeAsync(50);
      const result = await resultPromise;

      expect(result.approved).toBe(false);
      expect(result.feedback).toContain('cancelled');

      const responses = journal.getRecordsByType('approval_response');
      expect(responses).toHaveLength(1);
      expect(responses[0]!.data).toMatchObject({
        response: 'cancelled',
        synthetic: true,
      });
      expect(runtime.pendingCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('WiredApprovalRuntime — Phase 11.5 subagent_type passthrough', () => {
  // P2 — see MIGRATION_REPORT_phase_11.md §附录 B gap #1.
  // Python L122 asserts the ApprovalRequest envelope carries source_kind /
  // agent_id / subagent_type to the wire hub. TS ApprovalSource.subagent
  // currently carries only {kind, agent_id}.
  //
  // Unblock recipe (when Phase 8 / 12 decides to add the field):
  //   1. Extend `src/storage/wire-record.ts:246-251` ApprovalSource union
  //      with `subagent_type?: string` on the subagent branch.
  //   2. Extend `ApprovalSourceSchema` zod schema likewise (~ :695-718).
  //   3. Propagate from `turn-manager.ts:417-420` where `approvalSource`
  //      is constructed for subagent turns — read the agent's type from
  //      `this.agentType` / SubagentStore record.
  //   4. Replace this todo with a passing assertion on the appended
  //      `approval_request` wire record's `data.source.subagent_type`.
  it.todo(
    '[P2] subagent source carries subagent_type end-to-end (src gap: ApprovalSource.subagent.subagent_type — see MIGRATION_REPORT §B#1)',
  );
});

describe('WiredApprovalRuntime — remote stubs', () => {
  it('ingestRemoteRequest throws NotImplementedError', async () => {
    const { runtime } = makeRuntime();
    await expect(
      runtime.ingestRemoteRequest({
        request_id: 'x',
        tool_call_id: 'tc',
        tool_name: 'Bash',
        action: 'run command',
        display: { kind: 'command', command: 'ls' },
        source: { kind: 'soul', agent_id: 'agent_main' },
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });

  it('resolveRemote throws NotImplementedError', () => {
    const { runtime } = makeRuntime();
    expect(() => {
      runtime.resolveRemote({ request_id: 'x', response: 'approved' });
    }).toThrow(NotImplementedError);
  });
});
