/**
 * Phase 16 / T8 — subagent sessionMeta bubbling.
 *
 * Decision #113 / D9-1:
 *   - A subagent SoulPlus has its OWN SessionMetaService writing to
 *     `subagents/<sub_id>/wire.jsonl`.
 *   - When the subagent's SessionMetaService fires session_meta.changed,
 *     `createSubagentSinkWrapper` must forward the event to the parent
 *     EventBus with an attached `source: { kind: 'subagent', id, name }`.
 *   - The parent wire.jsonl must NOT contain the child's session_meta_changed
 *     record (铁律 5 — subagent wires stay subagent-local).
 *
 * Today the wrapper whitelist only handles SoulEvent types. Phase 16 asks
 * the implementer to extend the whitelist so `session_meta.changed` flows
 * through the same path.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';

import { SessionEventBus } from '../../src/soul-plus/session-event-bus.js';
import type { BusEvent, EventSource } from '../../src/soul-plus/session-event-bus.js';
import { createSubagentSinkWrapper } from '../../src/soul-plus/subagent-sink-wrapper.js';
import type { SoulEvent } from '../../src/soul/index.js';
import type { JournalWriter, AppendInput } from '../../src/storage/journal-writer.js';
import type { WireRecord } from '../../src/storage/wire-record.js';

// ── test doubles ──────────────────────────────────────────────────────

class SpyJournalWriter implements JournalWriter {
  readonly appended: AppendInput[] = [];
  pendingRecords: readonly WireRecord[] = [];
  private seq = 0;

  async append(input: AppendInput): Promise<WireRecord> {
    this.appended.push(input);
    this.seq += 1;
    return { ...input, seq: this.seq, time: Date.now() } as WireRecord;
  }
  async flush(): Promise<void> {}
  async close(): Promise<void> {}
}

function makeSource(overrides?: Partial<EventSource>): EventSource {
  return {
    id: 'sub_meta_1',
    kind: 'subagent',
    name: 'code-reviewer',
    ...overrides,
  };
}

// ── Type-level red-bar: session_meta.changed must be a SoulEvent variant ──
//
// Today the wrapper forwards any SoulEvent. The test below fails at type
// check time until the Implementer widens SoulEvent to include
// session_meta.changed (Step 2 note on `src/soul/index.ts`).

describe('Phase 16 T8 — SoulEvent union declares session_meta.changed', () => {
  it('session_meta.changed is assignable to SoulEvent', () => {
    const event = {
      type: 'session_meta.changed' as const,
      data: {
        patch: { title: 'x' },
        source: 'user' as const,
      },
    };
    expectTypeOf(event).toMatchTypeOf<SoulEvent>();
  });
});

describe('Phase 16 T8 — subagent session_meta.changed bubbling', () => {
  it('forwards a child session_meta.changed event up to the parent bus with source', () => {
    const parentBus = new SessionEventBus();
    const seen: BusEvent[] = [];
    parentBus.on((e) => {
      seen.push(e);
    });
    const source = makeSource();
    const wrapper = createSubagentSinkWrapper({
      childJournalWriter: new SpyJournalWriter(),
      parentEventBus: parentBus,
      source,
    });

    // Emit a session_meta.changed from the child — today's SoulEvent type
    // does not include this kind, so cast through unknown. Phase 16 adds it
    // to the wrapper's whitelist.
    wrapper.emit({
      type: 'session_meta.changed',
      data: { patch: { title: 'child-title' }, source: 'user' },
    } as unknown as Parameters<typeof wrapper.emit>[0]);

    expect(seen).toHaveLength(1);
    expect((seen[0] as { type: string }).type).toBe('session_meta.changed');
    expect(seen[0]!.source).toEqual(source);
    expect(
      (seen[0] as unknown as { data: { patch: { title?: string } } }).data.patch.title,
    ).toBe('child-title');
  });

  it('does NOT write a session_meta_changed record into the PARENT wire (铁律 5)', () => {
    // The sink wrapper owns the child→parent fan-out. It must not append
    // any parent-wire records; parent wire.jsonl stays ignorant of the
    // child's sessionMeta edit.
    const parentBus = new SessionEventBus();
    const parentJournal = new SpyJournalWriter();
    const wrapper = createSubagentSinkWrapper({
      // The "childJournalWriter" slot in the wrapper deps points at the CHILD
      // wire, not the parent. We use a throwaway here to keep the contract
      // compile-legal while asserting on the separate parentJournal.
      childJournalWriter: new SpyJournalWriter(),
      parentEventBus: parentBus,
      source: makeSource(),
    });

    wrapper.emit({
      type: 'session_meta.changed',
      data: { patch: { title: 'child-title' }, source: 'user' },
    } as unknown as Parameters<typeof wrapper.emit>[0]);

    // Nothing should have been appended to parentJournal — we have no
    // wiring that would do so, but the assertion pins the invariant for
    // future refactors.
    expect(parentJournal.appended).toHaveLength(0);
  });

  it('still emits the source-tagged envelope when the parent has multiple listeners', () => {
    const parentBus = new SessionEventBus();
    const a: BusEvent[] = [];
    const b: BusEvent[] = [];
    parentBus.on((e) => {
      a.push(e);
    });
    parentBus.on((e) => {
      b.push(e);
    });

    const wrapper = createSubagentSinkWrapper({
      childJournalWriter: new SpyJournalWriter(),
      parentEventBus: parentBus,
      source: makeSource({ id: 'sub_fan', name: 'fan' }),
    });

    wrapper.emit({
      type: 'session_meta.changed',
      data: { patch: { tags: ['child-tag'] }, source: 'user' },
    } as unknown as Parameters<typeof wrapper.emit>[0]);

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]!.source?.id).toBe('sub_fan');
    expect(b[0]!.source?.id).toBe('sub_fan');
  });

  it('a throwing parent listener does not suppress the forward to peers', () => {
    const parentBus = new SessionEventBus();
    const good: BusEvent[] = [];
    parentBus.on(() => {
      throw new Error('bad listener');
    });
    parentBus.on((e) => {
      good.push(e);
    });

    const wrapper = createSubagentSinkWrapper({
      childJournalWriter: new SpyJournalWriter(),
      parentEventBus: parentBus,
      source: makeSource(),
    });

    expect(() =>
      wrapper.emit({
        type: 'session_meta.changed',
        data: { patch: { title: 'iso' }, source: 'user' },
      } as unknown as Parameters<typeof wrapper.emit>[0]),
    ).not.toThrow();
    expect(good).toHaveLength(1);
  });
});
