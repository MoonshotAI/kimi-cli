/* oxlint-disable vitest/warn-todo -- Phase 12 intentionally uses it.todo
   to track src gaps. See migration-report.md §12.3. */
/**
 * Wire E2E — subagent smoke (Phase 12.3).
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
 * Gap (applies to all 7 `it.todo` below):
 *   - The in-memory wire harness default `session.create` handler
 *     (`test/helpers/wire/default-handlers.ts`) does NOT inject
 *     `subagentStore` / `agentTypeRegistry` into SoulPlus. Without
 *     those SoulPlus skips `new AgentTool(soulRegistry, ...)` —
 *     LLM-driven Agent spawn through wire is impossible until the
 *     handler (or a test-local override) threads subagent infra.
 *     Phase 11 (`--wire` runner) will do this for production.
 *   - #5 additionally depends on the approval reverse-RPC bridge
 *     (same gap as 12.1). #6/#7 exercise the existing summary-
 *     continuation logic (src/soul-plus/subagent-runner.ts
 *     SUMMARY_MIN_LENGTH=200 — present) but need the wire surface
 *     to see the child turn emissions, which is a superset of the
 *     spawn gap above.
 *
 * Each scenario below pins the lift recipe: the assertion and the
 * dependency it unblocks, so when the session.create handler gains
 * subagent infra the tests become mechanical rewrites.
 */

import { afterEach, describe, it } from 'vitest';

import {
  createWireE2EHarness,
  type WireE2EInMemoryHarness,
} from '../helpers/index.js';

let harness: WireE2EInMemoryHarness | undefined;

afterEach(async () => {
  if (harness !== undefined) {
    await harness.dispose();
    harness = undefined;
  }
});

void createWireE2EHarness;

describe('wire subagent — #1 foreground coder agent', () => {
  it.todo(
    'LLM Agent(agentName:"coder") → spawn → child Read tool → complete → parent ' +
      'receives final text via subagent sink wrapper (source.kind:"subagent"). ' +
      'Assert: subagents/<aid>/wire.jsonl contains turn.begin / turn.end records ' +
      '+ tool_call for Read. (pending: default-handlers session.create needs ' +
      'to inject subagentStore + agentTypeRegistry.register("coder", {...}))',
  );
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
