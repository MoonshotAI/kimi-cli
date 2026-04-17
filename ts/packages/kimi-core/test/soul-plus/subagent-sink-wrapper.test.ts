/**
 * Covers: `createSubagentSinkWrapper` (Phase 6 / 决策 #88 / v2 §6.5).
 *
 * The wrapper is the seam between a subagent Soul's EventSink and the
 * session-wide EventBus + child JournalWriter. It replaces the old
 * `createBubblingSink` which nested every child event back into the parent
 * wire under a `subagent.event` envelope.
 *
 * Post-Phase-6 contract:
 *   1. Every emitted `SoulEvent` is source-tagged and fanned out to the
 *      parent `SessionEventBus` via `emitWithSource(event, source)`.
 *   2. The `source` field NEVER lands in `wire.jsonl` — any record that
 *      does end up written to the child `JournalWriter` MUST NOT carry a
 *      `source` key.
 *   3. High-frequency ephemeral events (`content.delta`, `thinking.delta`,
 *      `tool.progress`) MUST NOT be persisted through the wrapper
 *      (铁律 5 / §3.7 "不落盘" list).
 *   4. Assistant-message / tool-result class events are persisted via
 *      `ContextState → JournalWriter` on the child side; the wrapper MUST
 *      NOT double-write them to avoid drift.
 *   5. `emit` returns `void` — the wrapper is a fire-and-forget forwarder
 *      (铁律 4); listener progress on the parent bus cannot back-pressure
 *      the Soul that emitted the event.
 *   6. Listener exceptions on the parent bus do not escape the wrapper —
 *      forwarding is isolated by the bus's own safeDispatch (§4.6.3).
 *
 * All tests are red bar until `createSubagentSinkWrapper` ships.
 */

import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { SessionEventBus } from '../../src/soul-plus/index.js';
import type { BusEvent, EventSource } from '../../src/soul-plus/session-event-bus.js';
import { createSubagentSinkWrapper } from '../../src/soul-plus/subagent-sink-wrapper.js';
import type { EventSink, SoulEvent } from '../../src/soul/index.js';
import type { JournalWriter } from '../../src/storage/journal-writer.js';
import type { AppendInput } from '../../src/storage/journal-writer.js';
import type { WireRecord } from '../../src/storage/wire-record.js';

// ── Test doubles ─────────────────────────────────────────────────────

/**
 * Capture-only JournalWriter double. Satisfies the public JournalWriter
 * contract enough for the sink wrapper to interact with it while letting
 * tests assert exactly which record shapes (if any) were appended.
 */
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
    id: 'sub_abc',
    kind: 'subagent',
    name: 'code-reviewer',
    ...overrides,
  };
}

function buildWrapper(opts?: {
  journal?: SpyJournalWriter;
  bus?: SessionEventBus;
  source?: EventSource;
}): {
  wrapper: EventSink;
  journal: SpyJournalWriter;
  bus: SessionEventBus;
  source: EventSource;
} {
  const journal = opts?.journal ?? new SpyJournalWriter();
  const bus = opts?.bus ?? new SessionEventBus();
  const source = opts?.source ?? makeSource();
  const wrapper = createSubagentSinkWrapper({
    childJournalWriter: journal,
    parentEventBus: bus,
    source,
  });
  return { wrapper, journal, bus, source };
}

describe('createSubagentSinkWrapper — source-tagged forwarding', () => {
  it('forwards a content.delta to parent bus with the injected source', () => {
    const { wrapper, bus, source } = buildWrapper();
    const seen: BusEvent[] = [];
    bus.on((e) => {
      seen.push(e);
    });

    wrapper.emit({ type: 'content.delta', delta: 'hello' });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.type).toBe('content.delta');
    expect(seen[0]?.source).toEqual(source);
  });

  it('source carries the human-readable agent_name when provided', () => {
    const { wrapper, bus } = buildWrapper({
      source: { id: 'sub_xyz', kind: 'subagent', name: 'explorer' },
    });
    const seen: BusEvent[] = [];
    bus.on((e) => {
      seen.push(e);
    });
    wrapper.emit({ type: 'step.begin', step: 0 });
    expect(seen[0]?.source?.name).toBe('explorer');
  });

  it('forwards every SoulEvent variant through the bus with source tag', () => {
    const { wrapper, bus } = buildWrapper();
    const seen: BusEvent[] = [];
    bus.on((e) => {
      seen.push(e);
    });

    const events: SoulEvent[] = [
      { type: 'step.begin', step: 0 },
      { type: 'content.delta', delta: 'a' },
      { type: 'thinking.delta', delta: 'b' },
      { type: 'tool.call', toolCallId: 'tc_1', name: 'Read', args: {} },
      { type: 'tool.progress', toolCallId: 'tc_1', update: { kind: 'stdout', text: '.' } },
      { type: 'tool.result', toolCallId: 'tc_1', output: 'ok' },
      { type: 'step.end', step: 0 },
      { type: 'compaction.begin' },
      { type: 'compaction.end', tokensBefore: 100, tokensAfter: 20 },
    ];
    for (const e of events) wrapper.emit(e);

    expect(seen).toHaveLength(events.length);
    for (const e of seen) {
      expect(e.source?.id).toBe('sub_abc');
      expect(e.source?.kind).toBe('subagent');
    }
  });
});

describe('createSubagentSinkWrapper — persistence (铁律 5 — source never hits disk)', () => {
  it('any record appended to the child journal is FREE of a source field', () => {
    const { wrapper, journal } = buildWrapper();

    const events: SoulEvent[] = [
      { type: 'step.begin', step: 0 },
      { type: 'content.delta', delta: 'x' },
      { type: 'tool.call', toolCallId: 'tc_1', name: 'Read', args: {} },
      { type: 'tool.result', toolCallId: 'tc_1', output: 'ok' },
      { type: 'compaction.begin' },
      { type: 'compaction.end', tokensBefore: 1, tokensAfter: 1 },
      { type: 'step.end', step: 0 },
    ];
    for (const e of events) wrapper.emit(e);

    for (const record of journal.appended) {
      expect(record as unknown as Record<string, unknown>).not.toHaveProperty('source');
      const data = (record as { data?: Record<string, unknown> }).data;
      if (data !== undefined) {
        expect(data).not.toHaveProperty('source');
      }
    }
  });

  it('content.delta does NOT reach the child journal (ephemeral, §3.7 不落盘)', () => {
    const { wrapper, journal } = buildWrapper();
    wrapper.emit({ type: 'content.delta', delta: 'hello' });
    wrapper.emit({ type: 'content.delta', delta: 'world' });
    expect(journal.appended).toHaveLength(0);
  });

  it('thinking.delta does NOT reach the child journal (ephemeral)', () => {
    const { wrapper, journal } = buildWrapper();
    wrapper.emit({ type: 'thinking.delta', delta: 'reasoning' });
    expect(journal.appended).toHaveLength(0);
  });

  it('tool.progress does NOT reach the child journal (ephemeral, §3.7 不落盘)', () => {
    const { wrapper, journal } = buildWrapper();
    wrapper.emit({
      type: 'tool.progress',
      toolCallId: 'tc_1',
      update: { kind: 'stdout', text: 'x' },
    });
    expect(journal.appended).toHaveLength(0);
  });

  it('assistant_message / tool_result durable records are NOT double-written by the wrapper', () => {
    // These records are owned by ContextState on the child side; the wrapper
    // must stay out of that lane to avoid drift. The only SoulEvent types
    // that overlap in spirit are `tool.call` (mirrors the assistant_message
    // tool_calls field) and `tool.result`. Emit them both — neither should
    // appear in the journal under the `assistant_message` / `tool_result`
    // record types. If the wrapper writes anything else (e.g. audit rows),
    // that is fine — we only pin the no-double-write rule.
    const { wrapper, journal } = buildWrapper();
    wrapper.emit({ type: 'tool.call', toolCallId: 'tc_1', name: 'Read', args: {} });
    wrapper.emit({ type: 'tool.result', toolCallId: 'tc_1', output: 'ok' });

    const types = journal.appended.map((r) => r.type);
    expect(types).not.toContain('assistant_message');
    expect(types).not.toContain('tool_result');
  });
});

describe('createSubagentSinkWrapper — type & isolation contract', () => {
  it('emit returns void (铁律 4 — fire-and-forget, no back-pressure)', () => {
    const { wrapper } = buildWrapper();
    const r: void = wrapper.emit({ type: 'step.begin', step: 0 });
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    r;
    expect(r).toBeUndefined();
  });

  it('EventSink.emit return type stays void (type-level guard)', () => {
    expectTypeOf<ReturnType<EventSink['emit']>>().toBeVoid();
  });

  it('a throwing parent-bus listener does not propagate out of wrapper.emit', () => {
    const bus = new SessionEventBus();
    bus.on(() => {
      throw new Error('bad listener');
    });
    const { wrapper } = buildWrapper({ bus });
    expect(() => {
      wrapper.emit({ type: 'step.begin', step: 0 });
    }).not.toThrow();
  });

  it('other listeners still receive the sourced event when one listener throws', () => {
    const bus = new SessionEventBus();
    const good = vi.fn();
    bus.on(() => {
      throw new Error('bad listener');
    });
    bus.on(good);
    const { wrapper, source } = buildWrapper({ bus });

    wrapper.emit({ type: 'step.begin', step: 1 });

    expect(good).toHaveBeenCalledTimes(1);
    const arg = good.mock.calls[0]?.[0] as BusEvent;
    expect(arg.source).toEqual(source);
  });
});
