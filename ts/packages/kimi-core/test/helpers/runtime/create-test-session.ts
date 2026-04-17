/**
 * TestSessionBundle — Phase 9 §3.
 *
 * Wraps the full SessionManager → SoulPlus → TurnManager stack in a
 * file-backed harness. Creates fresh temp directories for KIMI_HOME +
 * workspace, runs `sessionManager.createSession`, and exposes:
 *   - `soulPlus` / `turnManager` — the real instances
 *   - `prompt(text)` — fire a `session.prompt` and await the dispatch ack
 *   - `dispose()` — flushes state, closes session, removes temp dirs
 *
 * Most callers should use this instead of `createTestRuntime()` when
 * they need to exercise the live dispatch path (approvals, tool
 * execution, wire events).
 */

import type { KosongAdapter, Runtime } from '../../../src/soul/runtime.js';
import type { Tool } from '../../../src/soul/types.js';
import { HookEngine } from '../../../src/hooks/engine.js';
import {
  SessionEventBus,
  ToolCallOrchestrator,
  type ApprovalRuntime,
  type DispatchResponse,
  type SkillManager,
  type SoulPlus,
  type TurnManager,
} from '../../../src/soul-plus/index.js';
import {
  PathConfig,
  SessionManager,
  type ManagedSession,
} from '../../../src/session/index.js';
import { CollectingEventSink } from '../../soul/fixtures/collecting-event-sink.js';
import {
  createTempEnv,
  type TempEnvHandle,
} from '../filesystem/temp-work-dir.js';
import {
  FakeKosongAdapter,
  resolveKosongPair,
  type FakeKosongAdapterOptions,
} from '../kosong/index.js';
import { createTestApproval } from './internal-deps.js';

export interface CreateTestSessionOptions {
  readonly sessionId?: string;
  readonly workDir?: string;
  readonly shareDir?: string;
  readonly homeDir?: string;
  readonly tools?: readonly Tool[];
  readonly model?: string;
  readonly systemPrompt?: string;
  readonly kosong?: FakeKosongAdapter | KosongAdapter;
  readonly kosongOptions?: FakeKosongAdapterOptions;
  readonly approval?: ApprovalRuntime;
  readonly skillManager?: SkillManager;
}

export interface TestSessionBundle {
  readonly sessionId: string;
  readonly soulPlus: SoulPlus;
  readonly turnManager: TurnManager;
  readonly managed: ManagedSession;
  readonly sessionManager: SessionManager;
  readonly pathConfig: PathConfig;
  readonly kosong: FakeKosongAdapter;
  readonly approval: ApprovalRuntime;
  readonly sink: SessionEventBus;
  readonly events: CollectingEventSink;
  readonly runtime: Runtime;
  readonly tools: readonly Tool[];
  readonly sessionDir: string;
  readonly wireFile: string;
  readonly stateFile: string;
  readonly workDir: string;
  readonly shareDir: string;
  readonly homeDir: string;
  prompt(text: string): Promise<DispatchResponse>;
  dispose(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export async function createTestSession(
  opts?: CreateTestSessionOptions,
): Promise<TestSessionBundle> {
  let tempHandle: TempEnvHandle | undefined;
  const needsTemp =
    opts?.workDir === undefined || opts?.shareDir === undefined || opts?.homeDir === undefined;
  if (needsTemp) {
    tempHandle = await createTempEnv();
  }
  const workDir = opts?.workDir ?? tempHandle!.workDir.path;
  const shareDir = opts?.shareDir ?? tempHandle!.shareDir.path;
  const homeDir = opts?.homeDir ?? tempHandle!.homeDir.path;

  const pathConfig = new PathConfig({ home: homeDir });
  const sessionManager = new SessionManager(pathConfig);

  const suppliedKosong =
    opts?.kosong ?? (opts?.kosongOptions !== undefined ? new FakeKosongAdapter(opts.kosongOptions) : undefined);
  const { kosong, fake: fakeKosongExposed } = resolveKosongPair(suppliedKosong);

  const runtime: Runtime = { kosong };
  const approval = opts?.approval ?? createTestApproval({ yolo: true });
  const sink = new SessionEventBus();
  const events = new CollectingEventSink();
  const listener = (
    event: Parameters<Parameters<SessionEventBus['on']>[0]>[0],
  ): void => {
    events.emit(event);
  };
  sink.on(listener);

  const tools: readonly Tool[] = opts?.tools ?? [];

  // Wire the supplied ApprovalRuntime through a ToolCallOrchestrator so
  // scripted reject decisions actually veto tool execution
  // (Review M3). SessionManager accepts the orchestrator via its create
  // options; without this the approval path is skipped entirely.
  const hookEngine = new HookEngine({ executors: new Map() });
  // SessionManager allocates the session id lazily; resolve through a
  // closure so the orchestrator's first hook run sees the real id.
  let resolvedSessionId: string = opts?.sessionId ?? '';
  const orchestrator = new ToolCallOrchestrator({
    hookEngine,
    sessionId: () => resolvedSessionId,
    agentId: 'agent_main',
    approvalRuntime: approval,
    pathConfig,
  });

  const managed = await sessionManager.createSession({
    ...(opts?.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
    runtime,
    tools,
    model: opts?.model ?? 'test-model',
    ...(opts?.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
    eventBus: sink,
    workspaceDir: workDir,
    orchestrator,
    ...(opts?.skillManager !== undefined ? { skillManager: opts.skillManager } : {}),
  });
  resolvedSessionId = managed.sessionId;

  const sessionDir = pathConfig.sessionDir(managed.sessionId);
  const wireFile = pathConfig.wirePath(managed.sessionId);
  const stateFile = pathConfig.statePath(managed.sessionId);

  async function prompt(text: string): Promise<DispatchResponse> {
    return managed.soulPlus.dispatch({
      method: 'session.prompt',
      data: { input: { text } },
    });
  }

  const dispose = async (): Promise<void> => {
    sink.off(listener);
    try {
      await sessionManager.closeSession(managed.sessionId);
    } catch {
      // Swallow — SessionManager.close may throw if already closed.
    }
    if (tempHandle !== undefined) {
      await tempHandle.cleanup();
    }
  };

  return {
    sessionId: managed.sessionId,
    soulPlus: managed.soulPlus,
    turnManager: managed.soulPlus.getTurnManager(),
    managed,
    sessionManager,
    pathConfig,
    kosong: fakeKosongExposed,
    approval,
    sink,
    events,
    runtime,
    tools,
    sessionDir,
    wireFile,
    stateFile,
    workDir,
    shareDir,
    homeDir,
    prompt,
    dispose,
    [Symbol.asyncDispose]: dispose,
  };
}
