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

interface FakeStack {
  sessionManager: any;
  states: Map<string, FakeManagedState>;
  resumeCalls: string[];
  renameCalls: Array<{ id: string; title: string }>;
  setStubStatus: (status: string) => void;
  setStubUsage: (usage: {
    total_input_tokens: number;
    total_output_tokens: number;
    total_cache_read_tokens: number;
    total_cache_write_tokens: number;
    total_cost_usd: number;
  }) => void;
  setStubList: (
    list: Array<{
      session_id: string;
      created_at: number;
      workspace_dir?: string;
      title?: string;
      last_activity?: number;
    }>,
  ) => void;
}

function createFakeStack(): FakeStack {
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
      // Phase 17 §D.1 — KimiCoreClient.emitStatusUpdate reads
      // `managed.contextState.tokenCountWithPending`; provide a stub
      // so lifecycle observers don't throw.
      contextState: {
        tokenCountWithPending: 0,
      } as unknown as ManagedSession['contextState'],
    } as unknown as ManagedSession;

    state.managed = managed;
    states.set(sessionId, state);
    return managed;
  }

  // Slice 5.1 — wire-level test capture for the four upgraded methods.
  const renameCalls: Array<{ id: string; title: string }> = [];
  let stubStatusReturn: string = 'idle';
  let stubUsageReturn = {
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cache_read_tokens: 0,
    total_cache_write_tokens: 0,
    total_cost_usd: 0,
  };
  let stubListReturn: Array<{
    session_id: string;
    created_at: number;
    workspace_dir?: string;
    title?: string;
    last_activity?: number;
  }> = [];

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
      if (stubListReturn.length > 0) return stubListReturn;
      return [...states.keys()].map((id) => ({ session_id: id, created_at: 0 }));
    },
    async closeSession(_sessionId: string): Promise<void> {
      states.delete(_sessionId);
    },
    async renameSession(sessionId: string, title: string): Promise<void> {
      renameCalls.push({ id: sessionId, title });
    },
    async getSessionStatus(_sessionId: string): Promise<string> {
      return stubStatusReturn;
    },
    async getSessionUsage(_sessionId: string): Promise<typeof stubUsageReturn> {
      return stubUsageReturn;
    },
    get(sessionId: string): unknown {
      return states.get(sessionId);
    },
  };

  return {
    sessionManager,
    states,
    resumeCalls,
    renameCalls,
    setStubStatus: (s: string): void => { stubStatusReturn = s; },
    setStubUsage: (u: typeof stubUsageReturn): void => { stubUsageReturn = u; },
    setStubList: (l: typeof stubListReturn): void => { stubListReturn = l; },
  };
}

function fakeRuntime(): Runtime {
  return {
    kosong: { chat: vi.fn() },
    compactionProvider: { run: vi.fn() },
    lifecycle: { transitionTo: vi.fn() },
    journal: { rotate: vi.fn() },
  } as unknown as Runtime;
}

// Phase 17 §D.1 — KimiCoreClient construction now requires `config` +
// `kaos` for hook wiring. Tests don't run hooks, so a minimal KimiConfig
// with no hooks + a stub Kaos is enough to let the constructor finish
// without throwing.
function fakeConfig(): import('@moonshot-ai/core').KimiConfig {
  return {
    providers: {},
    hooks: [],
  };
}

function fakeKaos(): import('@moonshot-ai/kaos').Kaos {
  return {} as unknown as import('@moonshot-ai/kaos').Kaos;
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
      config: fakeConfig(),
      kaos: fakeKaos(),
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
      config: fakeConfig(),
      kaos: fakeKaos(),
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
      config: fakeConfig(),
      kaos: fakeKaos(),
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
      config: fakeConfig(),
      kaos: fakeKaos(),
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

// ── Slice 5.1 — wire-level coverage of session-info methods ──────────

describe('KimiCoreClient session-info methods (Slice 5.1)', () => {
  it('rename forwards to sessionManager.renameSession', async () => {
    const stack = createFakeStack();
    const client = new KimiCoreClient({
      sessionManager: stack.sessionManager as never,
      runtime: fakeRuntime(),
      model: 'm',
      systemPrompt: '',
      buildTools: (): Tool[] => [],
      config: fakeConfig(),
      kaos: fakeKaos(),
    });
    await client.rename('ses_x', 'My title');
    expect(stack.renameCalls).toEqual([{ id: 'ses_x', title: 'My title' }]);
    await client.dispose();
  });

  it('getStatus surfaces sessionManager.getSessionStatus', async () => {
    const stack = createFakeStack();
    stack.setStubStatus('active');
    const client = new KimiCoreClient({
      sessionManager: stack.sessionManager as never,
      runtime: fakeRuntime(),
      model: 'm',
      systemPrompt: '',
      buildTools: (): Tool[] => [],
      config: fakeConfig(),
      kaos: fakeKaos(),
    });
    expect(await client.getStatus('ses_x')).toEqual({ state: 'active' });
    await client.dispose();
  });

  it('getUsage surfaces sessionManager.getSessionUsage', async () => {
    const stack = createFakeStack();
    stack.setStubUsage({
      total_input_tokens: 100,
      total_output_tokens: 50,
      total_cache_read_tokens: 10,
      total_cache_write_tokens: 5,
      total_cost_usd: 0,
    });
    const client = new KimiCoreClient({
      sessionManager: stack.sessionManager as never,
      runtime: fakeRuntime(),
      model: 'm',
      systemPrompt: '',
      buildTools: (): Tool[] => [],
      config: fakeConfig(),
      kaos: fakeKaos(),
    });
    const usage = await client.getUsage('ses_x');
    expect(usage.total_input_tokens).toBe(100);
    expect(usage.total_output_tokens).toBe(50);
    expect(usage.total_cost_usd).toBe(0);
    await client.dispose();
  });

  it('listSessions forwards title and last_activity through wire layer (B1 fix)', async () => {
    const stack = createFakeStack();
    stack.setStubList([
      {
        session_id: 'ses_titled',
        created_at: 1_700_000_000,
        workspace_dir: '/proj',
        title: 'My demo',
        last_activity: 1_700_010_000,
      },
      {
        session_id: 'ses_legacy',
        created_at: 1_690_000_000,
      },
    ]);
    const client = new KimiCoreClient({
      sessionManager: stack.sessionManager as never,
      runtime: fakeRuntime(),
      model: 'm',
      systemPrompt: '',
      buildTools: (): Tool[] => [],
      config: fakeConfig(),
      kaos: fakeKaos(),
    });
    const { sessions } = await client.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({
      id: 'ses_titled',
      work_dir: '/proj',
      title: 'My demo',
      created_at: 1_700_000_000,
      updated_at: 1_700_010_000,
    });
    // Legacy session: title falls back to null, updated_at to created_at
    expect(sessions[1]).toMatchObject({
      id: 'ses_legacy',
      title: null,
      created_at: 1_690_000_000,
      updated_at: 1_690_000_000,
    });
    await client.dispose();
  });

  it('clear throws for an unknown session id (round-5 review)', async () => {
    // Before the fix, `clear` silently returned when the session id
    // was unknown, which let InteractiveMode clear the TUI transcript
    // on a stale id while the real session kept its history. Throwing
    // forces performReload down the failure branch and keeps the
    // transcript intact.
    const stack = createFakeStack();
    const client = new KimiCoreClient({
      sessionManager: stack.sessionManager as never,
      runtime: fakeRuntime(),
      model: 'm',
      systemPrompt: '',
      buildTools: (): Tool[] => [],
      config: fakeConfig(),
      kaos: fakeKaos(),
    });

    await expect(client.clear('ses_does_not_exist')).rejects.toThrow(
      /unknown session/i,
    );

    await client.dispose();
  });
});
