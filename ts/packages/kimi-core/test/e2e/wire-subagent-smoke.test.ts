/* oxlint-disable vitest/warn-todo -- Phase 12 intentionally uses it.todo
   to track src gaps. See migration-report.md §12.3. */
/**
 * Wire E2E — subagent smoke (Phase 12.3 + Slice 5.3 T5).
 *
 * Migrated from Python `tests/e2e/test_subagent_smoke_e2e.py` (789L, 7
 * scenarios). Scope: verify the Agent collaboration tool + SoulRegistry
 * + SubagentRunner chain end-to-end through the wire protocol.
 *
 * Architectural v2 divergence vs Python (决策 #88 / §4.1.1 / §6.5):
 *   - Python used a PTY harness + `find_session_dir` + `meta.json` +
 *     `output.log`. v2 drops PTY entirely; verification switches to
 *     `subagents/<aid>/wire.jsonl` (per-subagent independent wire file).
 *     `output.log` no longer exists.
 *   - Background subagent ApprovalRequests bubble through the subagent
 *     sink wrapper with `source = {kind: 'subagent', agent_id: <aid>}`
 *     (TS uses `kind: 'subagent'` — see src/storage/wire-record.ts
 *     ApprovalSource discriminator; Python's `source_kind:
 *     "background_task"` is a schema rename).
 *
 * Scope boundary (work completed outside Phase 12):
 *   - `test/e2e/subagent-foreground.test.ts` already exercises the
 *     direct Agent → SoulRegistry → runSubagentTurn path (with manual
 *     wiring). It remains as the authoritative non-wire smoke.
 *   - `test/soul-plus/subagent-independent-wire.test.ts` pins #88
 *     (`subagents/<aid>/wire.jsonl` content + parent wire only holds
 *     subagent_spawned / completed / failed).
 *   - `test/soul-plus/subagent-sink-wrapper.test.ts` pins the source
 *     envelope forwarding.
 *   - `test/soul-plus/subagent-recursive.test.ts` covers recursion.
 *
 * Slice 5.3 T5 — scenario #1 below is lifted to a real `it()` and is
 * green once C1 (SessionManager wiring) has landed. The test uses a
 * `routerOverrides` handler to thread `agentTypeRegistry` into the
 * default in-memory `session.create` path, and attaches
 * `installWireEventBridge` so SessionEventBus + TurnLifecycleTracker
 * emissions arrive on the wire as `turn.begin` / `turn.end` frames.
 *
 * Scenarios #2-#7 remain `it.todo` pending the same subagent-infra
 * default-handler gap (not a src gap — the handler itself lives in
 * `test/helpers/wire/default-handlers.ts`), plus, for #5, an approval
 * reverse-RPC bridge.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createWireE2EHarness,
  type WireE2EInMemoryHarness,
} from '../helpers/index.js';
import { FakeKosongAdapter } from '../helpers/kosong/index.js';
import {
  AgentTypeRegistry,
  type AgentTypeDefinition,
} from '../../src/soul-plus/agent-type-registry.js';
import {
  createWireRequest,
  createWireResponse,
} from '../../src/wire-protocol/message-factory.js';
import { installWireEventBridge } from './helpers/wire-event-bridge.js';

let harness: WireE2EInMemoryHarness | undefined;
let disposeBridge: (() => void) | undefined;

afterEach(async () => {
  disposeBridge?.();
  disposeBridge = undefined;
  if (harness !== undefined) {
    await harness.dispose();
    harness = undefined;
  }
});

// ── Slice 5.3 T5: foreground coder agent spawn→completed ─────────────

describe('wire subagent — #1 foreground coder agent', () => {
  // Long child summary so SubagentRunner does not trigger the
  // SUMMARY_MIN_LENGTH=200 continuation path (src/soul-plus/subagent-
  // runner.ts). Keep it >= 200 chars.
  const CHILD_SUMMARY =
    'Coder subagent finished exploring the auth module. ' +
    'Identified three stale TODOs in validateToken() and confirmed the ' +
    'token-refresh race fix from last week is still in place. No further ' +
    'actions required — the parent agent can proceed with the ticket work.';

  const CODER_DEF: AgentTypeDefinition = {
    name: 'coder',
    description: 'Code agent',
    whenToUse: 'For coding tasks',
    systemPromptSuffix: 'You are a coder subagent.',
    allowedTools: [],
    excludeTools: ['Agent'],
    defaultModel: null,
  };

  it('AgentTool → spawn → child turn → parent wire has subagent_spawned + subagent_completed, child wire.jsonl has events', { timeout: 20_000 }, async () => {
    // Scripted kosong:
    //   turn 0 (parent) → Agent(agentName="coder") tool_call
    //   turn 1 (child)  → long text (>= SUMMARY_MIN_LENGTH) + end_turn
    //   turn 2 (parent) → final text after the tool_result comes back
    const kosong = new FakeKosongAdapter({
      turns: [
        {
          toolCalls: [
            {
              id: 'tc_agent_spawn',
              name: 'Agent',
              arguments: {
                prompt: 'Explore auth module',
                description: 'Explore auth module',
                agentName: 'coder',
              },
            },
          ],
          stopReason: 'tool_use',
        },
        { text: CHILD_SUMMARY, stopReason: 'end_turn' },
        { text: 'Parent synthesised reply.', stopReason: 'end_turn' },
      ],
    });

    const agentTypeRegistry = new AgentTypeRegistry();
    agentTypeRegistry.register('coder', CODER_DEF);

    harness = await createWireE2EHarness({
      kosong,
      // Replace the default session.create handler with one that
      // forwards `agentTypeRegistry` into SessionManager. Once C1 is
      // implemented and the default handlers thread subagent infra,
      // this override becomes redundant and can collapse into the
      // default path.
      routerOverrides: (router) => {
        router.registerProcessMethod('session.create', async (msg) => {
          const payload = (msg.data ?? {}) as {
            session_id?: string;
            model?: string;
            system_prompt?: string;
          };
          const managed = await harness!.sessionManager.createSession({
            ...(payload.session_id !== undefined
              ? { sessionId: payload.session_id }
              : {}),
            runtime: { kosong },
            tools: [],
            model: payload.model ?? 'test-model',
            ...(payload.system_prompt !== undefined
              ? { systemPrompt: payload.system_prompt }
              : {}),
            eventBus: harness!.eventBus,
            workspaceDir: harness!.workDir,
            agentTypeRegistry,
          });
          return createWireResponse({
            requestId: msg.id,
            sessionId: msg.session_id,
            data: { session_id: managed.sessionId },
          });
        });
      },
    });

    // 1. Initialize + session.create
    await harness.request('initialize', {});
    const createResp = await harness.request('session.create', {
      model: 'test-model',
    });
    const sessionId = (createResp.data as { session_id: string }).session_id;

    // Install the test-local wire event bridge so SessionEventBus +
    // TurnLifecycleTracker emissions become `turn.begin` / `turn.end`
    // / `tool.call` / ... wire frames on the harness. Without this the
    // harness only round-trips request/response, and `expectEvent
    // ('turn.end')` below would hang until timeout (Phase 10 C test
    // infra — see helpers/wire-event-bridge.ts JSDoc).
    const managed = harness.sessionManager.get(sessionId);
    if (managed === undefined) throw new Error('session not materialised');
    const turnManager = managed.soulPlus.getTurnManager();
    const bridge = installWireEventBridge({
      server: harness.server,
      eventBus: harness.eventBus,
      addTurnLifecycleListener: (l) => turnManager.addTurnLifecycleListener(l),
      sessionId,
    });
    disposeBridge = bridge.dispose;

    // 2. Fire the prompt. Expect turn.begin → Agent tool.call →
    //    subagent lifecycle → tool.result → final turn.end.
    const promptReq = createWireRequest({
      method: 'session.prompt',
      sessionId,
      data: { input: 'explore auth' },
    });
    await harness.send(promptReq);

    // Wait for the final turn.end — everything interesting has been
    // emitted by then.
    await harness.expectEvent('turn.end', { timeoutMs: 15_000 });

    // 3. Parent wire.jsonl should contain subagent_spawned + completed
    const wirePath = join(harness.homeDir, 'sessions', sessionId, 'wire.jsonl');
    const wireRaw = await readFile(wirePath, 'utf-8');
    const wireLines = wireRaw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { type?: string; data?: { agent_id?: string } });
    const spawned = wireLines.find((r) => r.type === 'subagent_spawned');
    const completed = wireLines.find((r) => r.type === 'subagent_completed');
    if (spawned === undefined) {
      throw new Error('parent wire must contain subagent_spawned');
    }
    if (completed === undefined) {
      throw new Error('parent wire must contain subagent_completed');
    }
    expect(spawned).toBeDefined();
    expect(completed).toBeDefined();
    const agentId = spawned.data?.agent_id;
    if (!agentId) {
      throw new Error('subagent_spawned must carry agent_id');
    }
    expect(agentId).toBeTruthy();

    // 4. Child wire.jsonl should exist and contain events.
    const childWirePath = join(
      harness.homeDir,
      'sessions',
      sessionId,
      'subagents',
      agentId,
      'wire.jsonl',
    );
    const childRaw = await readFile(childWirePath, 'utf-8');
    const childLines = childRaw
      .split('\n')
      .filter((l) => l.trim().length > 0);
    if (childLines.length === 0) {
      throw new Error('child wire.jsonl must contain records');
    }
    expect(childLines.length).toBeGreaterThan(0);
  });
});

describe('wire subagent — #2 foreground explore agent (read-only)', () => {
  it.todo(
    'LLM Agent(agentName:"explore") → child tool-set filtered to read-only ' +
      '(no Bash/Write/Edit). Git context prefix injected on prompt per ' +
      'src/soul-plus/subagent-runner.ts:311. ' +
      '(pending: same subagent-infra default-handler gap + agent-type coder/' +
      'explore tool allowlists must be registered by test)',
  );
});

describe('wire subagent — #3 background agent completes', () => {
  it.todo(
    'LLM Agent(agentName:"coder", runInBackground:true) → tool_result returns ' +
      'immediately with task_id + agent_id + status:"running" → background ' +
      'subagent turn completes off-turn → subagents/<aid>/wire.jsonl reaches ' +
      'terminal state ("completed"). ' +
      '(pending: subagent-infra default-handler gap. Decision #88 — verify ' +
      "wire.jsonl not meta.json — already pinned by subagent-independent-wire.test.ts)",
  );
});

describe('wire subagent — #4 sequential foreground agents (coder + explore)', () => {
  it.todo(
    'Two user turns, each spawn one foreground subagent. Two distinct ' +
      'subagents/<aid>/wire.jsonl directories; session parent wire only ' +
      'contains subagent_spawned + subagent_completed (not child turn ' +
      'events). (pending: same subagent-infra default-handler gap)',
  );
});

describe('wire subagent — #5 background agent with approval (source forwarding)', () => {
  it.todo(
    'Background subagent invokes WriteFile → approval.request reverse-RPC ' +
      'bubbled to root wire with source discriminator `{kind:"subagent", ' +
      'agent_id:<child_aid>}`. Client approves → child proceeds → completes. ' +
      '(pending: subagent-infra default-handler gap + approval reverse-RPC ' +
      'bridge. Non-wire equivalent pinned by test/soul-plus/subagent-sink-' +
      'wrapper.test.ts covering source tag forwarding.)',
  );
});

describe('wire subagent — #6 summary continuation on short response', () => {
  it.todo(
    'foreground subagent first LLM reply < 200 chars → SubagentRunner ' +
      'appends continuation prompt (SUMMARY_MIN_LENGTH=200 already in ' +
      'src/soul-plus/subagent-runner.ts:60, SUMMARY_CONTINUATION_ATTEMPTS ' +
      'governed by src constant) → second reply settles. Assert via child ' +
      'wire.jsonl that two assistant_message records exist for the agent. ' +
      '(pending: subagent-infra default-handler gap)',
  );
});

describe('wire subagent — #7 no continuation when response is long', () => {
  it.todo(
    'Inverse of #6 — first reply >= 200 chars → no continuation prompt → ' +
      'single assistant_message in child wire.jsonl. ' +
      '(pending: subagent-infra default-handler gap)',
  );
});
