import { describe, it, expect, beforeEach } from 'vitest';
import type { WireMessage } from '../src/types.js';
import { MockDataSource } from '../src/mock-data-source.js';
import type { MockDataSourceOptions } from '../src/mock-data-source.js';
import { simpleChatScenario } from '../src/scenarios/simple-chat.js';
import { toolCallScenario } from '../src/scenarios/tool-call.js';
import { thinkingScenario } from '../src/scenarios/thinking.js';

// ── Helpers ───────────────────────────────────────────────────────────

async function collectN(source: AsyncIterable<WireMessage>, n: number): Promise<WireMessage[]> {
  const items: WireMessage[] = [];
  for await (const item of source) {
    items.push(item);
    if (items.length >= n) break;
  }
  return items;
}

async function collectUntilTurnEnd(source: AsyncIterable<WireMessage>): Promise<WireMessage[]> {
  const items: WireMessage[] = [];
  for await (const item of source) {
    items.push(item);
    if (item.method === 'turn.end') break;
  }
  return items;
}

function createDataSource(overrides?: Partial<MockDataSourceOptions>): MockDataSource {
  return new MockDataSource({
    delayMultiplier: 0, // instant for tests
    ...overrides,
  });
}

// ── MockDataSource prompt + subscribe ────────────────────────────────

describe('MockDataSource prompt + subscribe', () => {
  it('returns a complete event sequence via subscribe', async () => {
    const ds = createDataSource();
    const sessionId = ds.sessions.create('/tmp/test');

    // Start subscribing before prompt
    const eventStream = ds.events(sessionId);
    ds.startTurn(sessionId, 'turn_1', 'hello');

    const events = await collectUntilTurnEnd(eventStream);

    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.method).toBe('turn.begin');
    expect(events[events.length - 1]!.method).toBe('turn.end');
  });

  it('uses the default scenario resolver', async () => {
    const ds = createDataSource();
    const sessionId = ds.sessions.create('/tmp/test');

    const eventStream = ds.events(sessionId);
    ds.startTurn(sessionId, 'turn_1', 'anything');

    const events = await collectUntilTurnEnd(eventStream);

    // Default resolver uses simpleChatScenario
    const methods = events.map((e) => e.method);
    expect(methods).toContain('turn.begin');
    expect(methods).toContain('step.begin');
    expect(methods).toContain('content.delta');
    expect(methods).toContain('status.update');
    expect(methods).toContain('turn.end');
  });

  it('uses a custom scenario resolver', async () => {
    const ds = createDataSource({
      scenarioResolver: (input, sid, tid) => toolCallScenario(input, sid, tid),
    });
    const sessionId = ds.sessions.create('/tmp/test');

    const eventStream = ds.events(sessionId);
    ds.startTurn(sessionId, 'turn_1', 'list files');

    const events = await collectUntilTurnEnd(eventStream);
    const methods = events.map((e) => e.method);

    expect(methods).toContain('tool.call');
    expect(methods).toContain('tool.result');
  });

  it('includes text and think content deltas in simple chat', async () => {
    const ds = createDataSource();
    const sessionId = ds.sessions.create('/tmp/test');

    const eventStream = ds.events(sessionId);
    ds.startTurn(sessionId, 'turn_1', 'hello');

    const events = await collectUntilTurnEnd(eventStream);

    const contentEvents = events.filter((e) => e.method === 'content.delta');
    const partTypes = new Set(
      contentEvents.map((e) => {
        const data = e.data as { type: string };
        return data.type;
      }),
    );

    expect(partTypes.has('text')).toBe(true);
    expect(partTypes.has('think')).toBe(true);
  });

  it('all events have session_id and turn_id', async () => {
    const ds = createDataSource();
    const sessionId = ds.sessions.create('/tmp/test');

    const eventStream = ds.events(sessionId);
    ds.startTurn(sessionId, 'turn_1', 'hello');

    const events = await collectUntilTurnEnd(eventStream);

    for (const evt of events) {
      expect(evt.session_id).toBe(sessionId);
      expect(evt.turn_id).toBe('turn_1');
    }
  });

  it('all events have type === "event"', async () => {
    const ds = createDataSource();
    const sessionId = ds.sessions.create('/tmp/test');

    const eventStream = ds.events(sessionId);
    ds.startTurn(sessionId, 'turn_1', 'hello');

    const events = await collectUntilTurnEnd(eventStream);

    for (const evt of events) {
      expect(evt.type).toBe('event');
    }
  });
});

// ── MockDataSource.cancelTurn ────────────────────────────────────────

describe('MockDataSource.cancelTurn', () => {
  it('interrupts the event stream', async () => {
    const ds = createDataSource({
      delayMultiplier: 1,
      scenarioResolver: (input, sid, tid) => thinkingScenario(input, sid, tid),
    });
    const sessionId = ds.sessions.create('/tmp/test');

    const eventStream = ds.events(sessionId);
    ds.startTurn(sessionId, 'turn_1', 'test');

    const events: WireMessage[] = [];
    for await (const e of eventStream) {
      events.push(e);
      // Cancel after receiving the first step.begin
      if (e.method === 'step.begin') {
        ds.cancelTurn(sessionId);
      }
      if (e.method === 'turn.end') break;
    }

    // Stream should have terminated early
    expect(events.length).toBeLessThan(15); // Full thinking scenario has ~15+ events
  });
});

// ── MockDataSource session management ────────────────────────────────

describe('MockDataSource session management', () => {
  let ds: MockDataSource;

  beforeEach(() => {
    ds = createDataSource();
  });

  it('creates and lists sessions', () => {
    const id1 = ds.sessions.create('/work/a');
    const id2 = ds.sessions.create('/work/a');
    const id3 = ds.sessions.create('/work/b');

    const sessionsA = ds.sessions.list('/work/a');
    expect(sessionsA).toHaveLength(2);
    expect(sessionsA.map((s) => s.id)).toContain(id1);
    expect(sessionsA.map((s) => s.id)).toContain(id2);

    const sessionsB = ds.sessions.list('/work/b');
    expect(sessionsB).toHaveLength(1);
    expect(sessionsB[0]!.id).toBe(id3);
  });

  it('lists all sessions across work directories', () => {
    ds.sessions.create('/work/a');
    ds.sessions.create('/work/b');
    ds.sessions.create('/work/c');

    const all = ds.sessions.listAll();
    expect(all).toHaveLength(3);
  });

  it('deletes a session', () => {
    const id = ds.sessions.create('/work/a');
    ds.sessions.delete(id);

    const sessions = ds.sessions.list('/work/a');
    expect(sessions).toHaveLength(0);
  });

  it('throws when deleting non-existent session', () => {
    expect(() => ds.sessions.delete('nonexistent')).toThrow('Session not found');
  });

  it('forks a session', () => {
    const id = ds.sessions.create('/work/a');
    ds.sessions.setTitle(id, 'Original');

    const forkedId = ds.sessions.fork(id);
    expect(forkedId).not.toBe(id);

    const sessions = ds.sessions.list('/work/a');
    expect(sessions).toHaveLength(2);
  });

  it('sets session title', () => {
    const id = ds.sessions.create('/work/a');
    ds.sessions.setTitle(id, 'My Session');

    const sessions = ds.sessions.list('/work/a');
    const session = sessions.find((s) => s.id === id);
    expect(session?.title).toBe('My Session');
  });

  it('throws when setting title on non-existent session', () => {
    expect(() => ds.sessions.setTitle('nonexistent', 'title')).toThrow('Session not found');
  });

  it('uses snake_case field names in SessionInfo', () => {
    const id = ds.sessions.create('/work/a');
    const info = ds.sessions.get(id);
    expect(info).toBeDefined();
    expect(info!.work_dir).toBe('/work/a');
    expect(typeof info!.created_at).toBe('number');
    expect(typeof info!.updated_at).toBe('number');
  });
});
