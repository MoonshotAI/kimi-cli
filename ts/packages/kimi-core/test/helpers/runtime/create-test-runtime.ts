/**
 * TestRuntimeBundle — Phase 9 §3.
 *
 * Replaces Python's 12-field `runtime` fixture with a single factory
 * that builds every component needed to drive Soul / SoulPlus / tool
 * tests. The bundle is dispose-safe and composable:
 *
 *   using bundle = await createTestRuntime();
 *   // later:
 *   await bundle.dispose();    // or `await using` auto-cleanup
 *
 * Everything is lightweight (in-memory) — file-backed session / wire
 * harnesses live in `createTestSession` and the wire harness.
 */

import type { KosongAdapter, Runtime } from '../../../src/soul/runtime.js';
import type { Tool } from '../../../src/soul/types.js';
import type { ApprovalRuntime } from '../../../src/soul-plus/approval-runtime.js';
import { SessionEventBus } from '../../../src/soul-plus/session-event-bus.js';
import { SoulRegistry } from '../../../src/soul-plus/soul-registry.js';
import {
  InMemoryContextState,
  type FullContextState,
} from '../../../src/storage/context-state.js';
import {
  InMemorySessionJournalImpl,
  type InMemorySessionJournal,
} from '../../../src/storage/session-journal.js';
import { CollectingEventSink } from '../../soul/fixtures/collecting-event-sink.js';
import {
  FakeKosongAdapter,
  resolveKosongPair,
  type FakeKosongAdapterOptions,
} from '../kosong/index.js';
import {
  createTestApproval,
  createTestEnvironment,
  type CreateTestEnvironmentOptions,
  type TestEnvironment,
} from './internal-deps.js';

export interface TestRuntimeBundle {
  readonly runtime: Runtime;
  readonly kosong: FakeKosongAdapter;
  readonly contextState: FullContextState;
  readonly sessionJournal: InMemorySessionJournal;
  /** Session-event bus that fans out to both SoulPlus listeners and the collecting sink below. */
  readonly sink: SessionEventBus;
  /** Pre-subscribed to the bus; inspect `.events` to assert on what Soul emitted. */
  readonly events: CollectingEventSink;
  readonly approval: ApprovalRuntime;
  readonly environment: TestEnvironment;
  readonly tools: readonly Tool[];
  readonly soulRegistry: SoulRegistry;
  readonly sessionId: string;
  readonly agentId: string;
  dispose(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface CreateTestRuntimeOptions {
  readonly kosong?: FakeKosongAdapter | KosongAdapter;
  readonly kosongOptions?: FakeKosongAdapterOptions;
  readonly contextState?: FullContextState;
  readonly sessionJournal?: InMemorySessionJournal;
  readonly sink?: SessionEventBus;
  readonly approval?: ApprovalRuntime;
  readonly environment?: TestEnvironment;
  readonly environmentOptions?: CreateTestEnvironmentOptions;
  readonly tools?: readonly Tool[];
  readonly model?: string;
  readonly systemPrompt?: string;
  readonly sessionId?: string;
  readonly agentId?: string;
}

/**
 * Build a ready-to-use in-memory runtime bundle. Individual components
 * can be swapped via options — unspecified fields use the defaults
 * (`FakeKosongAdapter` / `InMemoryContextState` / `AlwaysAllowApprovalRuntime`
 * / empty `SessionEventBus`).
 */
export function createTestRuntime(opts?: CreateTestRuntimeOptions): TestRuntimeBundle {
  const sessionId = opts?.sessionId ?? 'ses_test';
  const agentId = opts?.agentId ?? 'agent_main';

  // Resolve the adapter pair. If the caller supplied only
  // `kosongOptions`, build a fresh FakeKosongAdapter with those.
  const suppliedKosong =
    opts?.kosong ?? (opts?.kosongOptions !== undefined ? new FakeKosongAdapter(opts.kosongOptions) : undefined);
  const { kosong: kosongImpl, fake: fakeKosongExposed } = resolveKosongPair(suppliedKosong);

  const contextState: FullContextState =
    opts?.contextState ??
    new InMemoryContextState({
      initialModel: opts?.model ?? 'test-model',
      ...(opts?.systemPrompt !== undefined ? { initialSystemPrompt: opts.systemPrompt } : {}),
    });

  const sessionJournal: InMemorySessionJournal =
    opts?.sessionJournal ?? new InMemorySessionJournalImpl();

  const sink = opts?.sink ?? new SessionEventBus();
  const events = new CollectingEventSink();
  const listener = (event: Parameters<Parameters<SessionEventBus['on']>[0]>[0]): void => {
    events.emit(event);
  };
  sink.on(listener);

  const approval = opts?.approval ?? createTestApproval({ yolo: true });
  const environment =
    opts?.environment ??
    createTestEnvironment(opts?.environmentOptions);
  const tools = opts?.tools ?? [];

  const soulRegistry = new SoulRegistry({
    createHandle: (key, agentDepth) => ({
      key,
      agentId: key === 'main' ? agentId : key.replace('sub:', ''),
      abortController: new AbortController(),
      agentDepth,
    }),
  });

  const runtime: Runtime = { kosong: kosongImpl };

  const dispose = async (): Promise<void> => {
    sink.off(listener);
  };

  return {
    runtime,
    kosong: fakeKosongExposed,
    contextState,
    sessionJournal,
    sink,
    events,
    approval,
    environment,
    tools,
    soulRegistry,
    sessionId,
    agentId,
    dispose,
    [Symbol.asyncDispose]: dispose,
  };
}

