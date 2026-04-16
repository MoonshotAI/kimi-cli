/**
 * KimiCoreClient unit tests — verify the bridge behaviour against a
 * minimal fake SessionManager + SoulPlus. We drive the SessionEventBus
 * directly to assert event fan-out, and assert that `prompt` synthesises
 * turn.begin and polls to emit turn.end when the fake TurnManager clears
 * its current turn slot.
 */

import {
  SessionEventBus,
  type CreateSessionOptions,
  type DispatchRequest,
  type DispatchResponse,
  type ManagedSession,
  type Runtime,
  type Tool,
  type TurnLifecycleEvent,
  type TurnLifecycleListener,
} from '@moonshot-ai/core';
import { describe, it, expect, vi } from 'vitest';

import { KimiCoreClient } from '../../src/wire/kimi-core-client.js';
import type { WireMessage } from '../../src/wire/wire-message.js';

// ── Fake session stack ─────────────────────────────────────────────

interface FakeManagedState {
  managed: ManagedSession;
  readonly eventBus: SessionEventBus;
  currentTurnId: string | undefined;
  readonly lifecycleListeners: Set<TurnLifecycleListener>;
  fireLifecycle: (event: TurnLifecycleEvent) => void;
}

function createFakeStack(): {
  sessionManager: any;
  states: Map<string, FakeManagedState>;
  resumeCalls: string[];
} {
  const states = new Map<string, FakeManagedState>();
  const resumeCalls: string[] = [];
  let nextId = 0;

  function buildManaged(sessionId: string, eventBus: SessionEventBus): ManagedSession {
    const lifecycleListeners = new Set<TurnLifecycleListener>();
    const state: FakeManagedState = {
      managed: undefined as unknown as ManagedSession,
      eventBus,
      currentTurnId: undefined,
      lifecycleListeners,
      fireLifecycle: (event) => {
        for (const listener of lifecycleListeners) {
          listener(event);
        }
      },
    };

    const turnManager = {
      getCurrentTurnId: () => state.currentTurnId,
      addTurnLifecycleListener: (listener: TurnLifecycleListener) => {
        lifecycleListeners.add(listener);
        return () => {
          lifecycleListeners.delete(listener);
        };
      },
    };

    const soulPlus = {
      sessionId,
      async dispatch(req: DispatchRequest): Promise<DispatchResponse> {
        if (req.method === 'session.prompt') {
          state.currentTurnId = 'turn_1';
          // Slice 4.2 — TurnManager fires `begin` synchronously from
          // inside `handlePrompt` after `transitionTo('active')`. The
          // fake mirrors that ordering so KimiCoreClient's lifecycle
          // observer sees the event before `prompt` returns.
          state.fireLifecycle({
            kind: 'begin',
            turnId: 'turn_1',
            userInput: (req.data as { input: { text: string } }).input.text,
            inputKind: 'user',
            agentType: 'main',
          });
          return { turn_id: 'turn_1', status: 'started' };
        }
        if (req.method === 'session.cancel') {
          state.currentTurnId = undefined;
          return { ok: true };
        }
        return { error: 'not_implemented' };
      },
      getTurnManager: () => turnManager,
    };

    const managed = {
      sessionId,
      soulPlus: soulPlus as unknown as ManagedSession['soulPlus'],
    } as unknown as ManagedSession;

    state.managed = managed;
    states.set(sessionId, state);
    return managed;
  }

  const sessionManager = {
    async createSession(options: CreateSessionOptions): Promise<ManagedSession> {
      nextId += 1;
      const sessionId = options.sessionId ?? `ses_fake${String(nextId)}`;
      const eventBus = (options.eventBus as SessionEventBus | undefined) ?? new SessionEventBus();
      return buildManaged(sessionId, eventBus);
    },
    async resumeSession(
      sessionId: string,
      options: { eventBus?: SessionEventBus | undefined },
    ): Promise<ManagedSession> {
      resumeCalls.push(sessionId);
      const eventBus = options.eventBus ?? new SessionEventBus();
      return buildManaged(sessionId, eventBus);
    },
    async listSessions() {
      return [...states.keys()].map((id) => ({ session_id: id, created_at: 0 }));
    },
    async closeSession(_sessionId: string): Promise<void> {
      states.delete(_sessionId);
    },
    get(sessionId: string): unknown {
      return states.get(sessionId);
    },
  };

  return { sessionManager, states, resumeCalls };
}

function fakeRuntime(): Runtime {
  return {
    kosong: { chat: vi.fn() },
    compactionProvider: { run: vi.fn() },
    lifecycle: { transitionTo: vi.fn() },
    journal: { rotate: vi.fn() },
  } as unknown as Runtime;
}

async function collect(
  iter: AsyncIterable<WireMessage>,
  count: number,
  timeoutMs = 500,
): Promise<WireMessage[]> {
  const out: WireMessage[] = [];
  const started = Date.now();
  const iterator = iter[Symbol.asyncIterator]();
  while (out.length < count) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `timed out waiting for ${String(count)} messages (got ${String(out.length)})`,
      );
    }
    const race = await Promise.race([
      iterator.next(),
      new Promise<IteratorResult<WireMessage>>((resolve) => {
        setTimeout(() => resolve({ value: undefined as unknown as WireMessage, done: true }), 50);
      }),
    ]);
    if (race.done) continue;
    out.push(race.value);
  }
  return out;
}

// ── Tests ──────────────────────────────────────────────────────────

describe('KimiCoreClient', () => {
  it('createSession allocates an id and returns it', async () => {
    const { sessionManager } = createFakeStack();
    const client = new KimiCoreClient({
      sessionManager: sessionManager as never,
      runtime: fakeRuntime(),
      model: 'test-model',
      systemPrompt: 'test',
      buildTools: (): Tool[] => [],
    });
    const { session_id } = await client.createSession('/tmp');
    expect(session_id).toBe('ses_fake1');
    await client.dispose();
  });

  it('prompt dispatches, forwards turn.begin from lifecycle observer, and emits turn.end', async () => {
    const { sessionManager, states } = createFakeStack();
    const client = new KimiCoreClient({
      sessionManager: sessionManager as never,
      runtime: fakeRuntime(),
      model: 'test-model',
      systemPrompt: 'test',
      buildTools: (): Tool[] => [],
    });
    const { session_id } = await client.createSession('/tmp');
    const state = states.get(session_id)!;

    const stream = client.subscribe(session_id);
    const collectTask = collect(stream, 3);

    const { turn_id } = await client.prompt(session_id, 'hello');
    expect(turn_id).toBe('turn_1');

    // Drive a SoulEvent through the event bus.
    state.eventBus.emit({ type: 'content.delta', delta: 'world' });

    // Slice 4.2 — fire the `end` lifecycle event directly; no 40 ms
    // watchdog poll. `turn.end` should appear in the stream synchronously.
    state.currentTurnId = undefined;
    state.fireLifecycle({
      kind: 'end',
      turnId: 'turn_1',
      reason: 'done',
      success: true,
      agentType: 'main',
    });

    const messages = await collectTask;
    expect(messages[0]!.method).toBe('turn.begin');
    expect(messages[1]!.method).toBe('content.delta');
    expect(messages[1]!.data).toEqual({ type: 'text', text: 'world' });
    expect(messages[2]!.method).toBe('turn.end');
    expect(messages[2]!.data).toMatchObject({
      turn_id: 'turn_1',
      reason: 'done',
      success: true,
    });

    await client.dispose();
  });

  it('forwards SoulEvent tool.call and tool.progress through the adapter', async () => {
    const { sessionManager, states } = createFakeStack();

    const client = new KimiCoreClient({
      sessionManager: sessionManager as never,
      runtime: fakeRuntime(),
      model: 'test-model',
      systemPrompt: 'test',
      buildTools: (): Tool[] => [],
    });
    const { session_id } = await client.createSession('/tmp');
    const state = states.get(session_id)!;

    // Simulate Soul reporting a tool call and then a progress update.
    // The tool.result synthetic event emitted by the wrapped tool
    // execute path is covered by kimi-core's turn integration tests —
    // here we only assert the adapter forwarding path.
    state.currentTurnId = 'turn_1';
    const stream = client.subscribe(session_id);
    const collectTask = collect(stream, 2);

    state.eventBus.emit({
      type: 'tool.call',
      toolCallId: 'tc_1',
      name: 'Echo',
      args: { ping: 1 },
    });
    state.eventBus.emit({
      type: 'tool.progress',
      toolCallId: 'tc_1',
      update: { kind: 'status', text: 'running' },
    });

    const messages = await collectTask;
    expect(messages[0]!.method).toBe('tool.call');
    expect(messages[0]!.data).toMatchObject({ id: 'tc_1', name: 'Echo' });
    expect(messages[1]!.method).toBe('tool.progress');

    await client.dispose();
  });

  it('resumeSession routes through sessionManager.resumeSession and drives the event bus', async () => {
    const { sessionManager, states, resumeCalls } = createFakeStack();
    const client = new KimiCoreClient({
      sessionManager: sessionManager as never,
      runtime: fakeRuntime(),
      model: 'test-model',
      systemPrompt: 'test',
      buildTools: (): Tool[] => [],
    });

    const { session_id } = await client.resumeSession('ses_existing');
    expect(session_id).toBe('ses_existing');
    expect(resumeCalls).toEqual(['ses_existing']);

    // The resumed session must also drive the event bus → wire queue
    // pipeline so prompts immediately work after resume.
    const stream = client.subscribe(session_id);
    const collectTask = collect(stream, 1);
    const state = states.get(session_id)!;
    state.eventBus.emit({ type: 'content.delta', delta: 'resumed' });
    const [msg] = await collectTask;
    expect(msg!.method).toBe('content.delta');
    expect(msg!.data).toEqual({ type: 'text', text: 'resumed' });

    await client.dispose();
  });
});
