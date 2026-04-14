import { describe, it, expect, beforeEach } from 'vitest';
import type { WireEvent } from '../src/types.js';
import { MockWireClient } from '../src/mock-wire-client.js';
import type { MockWireClientOptions } from '../src/mock-wire-client.js';
import { simpleChatScenario } from '../src/scenarios/simple-chat.js';
import { toolCallScenario } from '../src/scenarios/tool-call.js';
import { thinkingScenario } from '../src/scenarios/thinking.js';

// ── Helpers ───────────────────────────────────────────────────────────

async function collect(source: AsyncIterable<WireEvent>): Promise<WireEvent[]> {
  const items: WireEvent[] = [];
  for await (const item of source) {
    items.push(item);
  }
  return items;
}

function createClient(overrides?: Partial<MockWireClientOptions>): MockWireClient {
  return new MockWireClient({
    sessionId: 'test-session',
    workDir: '/tmp/test',
    model: 'test-model',
    yolo: false,
    delayMultiplier: 0, // instant for tests
    ...overrides,
  });
}

// ── MockWireClient.prompt ─────────────────────────────────────────────

describe('MockWireClient.prompt', () => {
  it('returns a complete event sequence', async () => {
    const client = createClient();
    const events = await collect(client.prompt('hello'));

    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.type).toBe('TurnBegin');
    expect(events[events.length - 1]!.type).toBe('TurnEnd');
  });

  it('uses the default scenario resolver', async () => {
    const client = createClient();
    const events = await collect(client.prompt('anything'));

    // Default resolver uses simpleChatScenario
    const types = events.map((e) => e.type);
    expect(types).toContain('TurnBegin');
    expect(types).toContain('StepBegin');
    expect(types).toContain('ContentPart');
    expect(types).toContain('StatusUpdate');
    expect(types).toContain('TurnEnd');
  });

  it('uses a custom scenario resolver', async () => {
    const client = createClient({
      scenarioResolver: (input) => toolCallScenario(input),
    });

    const events = await collect(client.prompt('list files'));
    const types = events.map((e) => e.type);

    expect(types).toContain('ToolCall');
    expect(types).toContain('ToolResult');
  });

  it('includes text and think content in simple chat', async () => {
    const client = createClient();
    const events = await collect(client.prompt('hello'));

    const contentEvents = events.filter((e) => e.type === 'ContentPart');
    const partTypes = new Set(
      contentEvents.map((e) => {
        if (e.type === 'ContentPart') return e.part.type;
        return null;
      }),
    );

    expect(partTypes.has('text')).toBe(true);
    expect(partTypes.has('think')).toBe(true);
  });

  it('can run multiple prompts sequentially', async () => {
    const client = createClient();

    const events1 = await collect(client.prompt('first'));
    const events2 = await collect(client.prompt('second'));

    expect(events1[0]!.type).toBe('TurnBegin');
    expect(events2[0]!.type).toBe('TurnBegin');

    // Both should complete independently
    expect(events1[events1.length - 1]!.type).toBe('TurnEnd');
    expect(events2[events2.length - 1]!.type).toBe('TurnEnd');
  });
});

// ── MockWireClient.cancel ─────────────────────────────────────────────

describe('MockWireClient.cancel', () => {
  it('interrupts the event stream', async () => {
    // Use a scenario with many steps and actual delays
    const client = createClient({
      delayMultiplier: 1,
      scenarioResolver: () => thinkingScenario('test'),
    });

    const events: WireEvent[] = [];
    for await (const e of client.prompt('test')) {
      events.push(e);
      // Cancel after receiving the first StepBegin
      if (e.type === 'StepBegin') {
        client.cancel();
      }
    }

    // Stream should have terminated early
    expect(events.length).toBeLessThan(15); // Full thinking scenario has ~15+ events

    // Should end with StepInterrupted and TurnEnd if the cancellation was caught
    // during a delay; otherwise it just stops
  });
});

// ── MockWireClient.steer ──────────────────────────────────────────────

describe('MockWireClient.steer', () => {
  it('injects SteerInput events into the stream', async () => {
    const client = createClient({
      delayMultiplier: 1,
      scenarioResolver: (input) => ({
        name: 'steer-test',
        description: 'test steer injection',
        steps: [
          { kind: 'event', event: { type: 'TurnBegin', userInput: input } },
          { kind: 'delay', ms: 50 },
          { kind: 'event', event: { type: 'StepBegin', n: 1 } },
          { kind: 'delay', ms: 100 }, // Give time for steer injection
          { kind: 'event', event: { type: 'ContentPart', part: { type: 'text', text: 'response' } } },
          { kind: 'event', event: { type: 'TurnEnd' } },
        ],
      }),
    });

    const events: WireEvent[] = [];
    let steered = false;

    for await (const e of client.prompt('initial')) {
      events.push(e);
      if (e.type === 'StepBegin' && !steered) {
        client.steer('follow up');
        steered = true;
      }
    }

    // Check that a SteerInput event was injected
    const steerEvents = events.filter((e) => e.type === 'SteerInput');
    expect(steerEvents.length).toBeGreaterThanOrEqual(1);
    if (steerEvents[0]!.type === 'SteerInput') {
      expect(steerEvents[0]!.userInput).toBe('follow up');
    }
  });
});

// ── MockWireClient.replay ─────────────────────────────────────────────

describe('MockWireClient.replay', () => {
  it('returns an empty stream', async () => {
    const client = createClient();
    const events = await collect(client.replay());
    expect(events).toEqual([]);
  });
});

// ── MockWireClient session management ─────────────────────────────────

describe('MockWireClient session management', () => {
  let client: MockWireClient;

  beforeEach(() => {
    client = createClient();
  });

  it('creates and lists sessions', async () => {
    const id1 = await client.createSession('/work/a');
    const id2 = await client.createSession('/work/a');
    const id3 = await client.createSession('/work/b');

    const sessionsA = await client.listSessions('/work/a');
    expect(sessionsA).toHaveLength(2);
    expect(sessionsA.map((s) => s.id)).toContain(id1);
    expect(sessionsA.map((s) => s.id)).toContain(id2);

    const sessionsB = await client.listSessions('/work/b');
    expect(sessionsB).toHaveLength(1);
    expect(sessionsB[0]!.id).toBe(id3);
  });

  it('lists all sessions across work directories', async () => {
    await client.createSession('/work/a');
    await client.createSession('/work/b');
    await client.createSession('/work/c');

    const all = await client.listAllSessions();
    expect(all).toHaveLength(3);
  });

  it('continues the most recent session', async () => {
    await client.createSession('/work/a');
    const id2 = await client.createSession('/work/a');

    // The most recently created session should be continued
    const continued = await client.continueSession('/work/a');
    expect(continued).toBe(id2);
  });

  it('returns null when no session to continue', async () => {
    const continued = await client.continueSession('/work/empty');
    expect(continued).toBeNull();
  });

  it('deletes a session', async () => {
    const id = await client.createSession('/work/a');
    await client.deleteSession(id);

    const sessions = await client.listSessions('/work/a');
    expect(sessions).toHaveLength(0);
  });

  it('throws when deleting non-existent session', async () => {
    await expect(client.deleteSession('nonexistent')).rejects.toThrow('Session not found');
  });

  it('forks a session', async () => {
    const id = await client.createSession('/work/a');
    await client.setSessionTitle(id, 'Original');

    const forkedId = await client.forkSession(id);
    expect(forkedId).not.toBe(id);

    const sessions = await client.listSessions('/work/a');
    expect(sessions).toHaveLength(2);
  });

  it('sets session title', async () => {
    const id = await client.createSession('/work/a');
    await client.setSessionTitle(id, 'My Session');

    const sessions = await client.listSessions('/work/a');
    const session = sessions.find((s) => s.id === id);
    expect(session?.title).toBe('My Session');
  });

  it('throws when setting title on non-existent session', async () => {
    await expect(client.setSessionTitle('nonexistent', 'title')).rejects.toThrow(
      'Session not found',
    );
  });
});

// ── MockWireClient.dispose ────────────────────────────────────────────

describe('MockWireClient.dispose', () => {
  it('completes without error', async () => {
    const client = createClient();
    await expect(client.dispose()).resolves.toBeUndefined();
  });
});
