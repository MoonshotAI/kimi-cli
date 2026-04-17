/* oxlint-disable vitest/warn-todo -- Phase 12 intentionally uses it.todo
   to track src gaps. See migration-report.md §12.2. */
/**
 * Wire E2E — skills + MCP (Phase 12.2).
 *
 * Migrated from Python `tests_e2e/test_wire_skills_mcp.py` (427L, 3
 * scenarios). Scope boundary (见 todo/phase-12-integration-e2e.md §12.2):
 *
 *   #1 skill_prompt_injects_skill_text
 *      - Python: `/skill:test-skill` → SkillManager writes a `user_message`
 *        WAL record containing the SKILL.md body, validated by scanning
 *        `context.jsonl`.
 *      - v2 divergence (§4.1): `context.jsonl` is merged into
 *        `wire.jsonl`. The test must filter `wire.jsonl` for
 *        `type:'user_message'` records (see §R8 + src/storage/wire-record.ts).
 *
 *   #2 flow_skill
 *      - Python: `/flow:test-flow` → SKILL.md mermaid flowchart triggers
 *        nested turn (two turn.begin + two turn.end wire events).
 *      - TS: no mermaid parser in src/soul-plus/skill/manager.ts
 *        (grep'd — no `flowchart` / `mermaid` references). Gap.
 *
 *   #3 mcp_tool_call
 *      - Python fastmcp-based ping server exposes `ping(text)` → LLM
 *        calls → MCPLoading events + mcp_status StatusUpdate +
 *        ApprovalRequest → approve → ToolResult "pong:hi".
 *      - TS uses `@modelcontextprotocol/sdk` (already a dep per
 *        packages/kimi-core/package.json) — Phase 12 §R4 方案 B would
 *        wire a node-based stub MCP server via `mcp-server-stub.ts`.
 *        The wire surface for MCP tool calls + mcp_status still needs
 *        the per-session MCP loading bridge (`src/soul-plus/mcp/manager.ts`)
 *        to emit `mcp.loading` / `status.update` wire events.
 *
 * Scaffold strategy:
 *   - Keep the file as `it.todo` with precise pointers to src files /
 *     fields so the lift is mechanical when the bridges land.
 *   - Do NOT build a premature MCP stub server in this pass — R4 方案
 *     B is conditional on the mcp.loading / status.update wire events
 *     existing in src; without them the test would be a no-op.
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

void createWireE2EHarness; // reserved for lift

describe('wire skills — #1 /skill: injects SKILL.md body as user_message', () => {
  it.todo(
    "/skill:test-skill → wire.jsonl contains user_message record whose " +
      'content includes the SKILL.md body. ' +
      '(pending src: in-memory wire harness has no user-slash parse path; ' +
      'SkillManager consumes slash input via SoulPlus.dispatch, but the ' +
      'default-handlers session.prompt just forwards text as-is. Need ' +
      'either a prompt-preprocess hook or a dedicated skill dispatch ' +
      'method on the wire. — 决策 #99 user-slash direct path; R8)',
  );
});

describe('wire skills — #2 /flow: triggers nested turns (mermaid)', () => {
  it.todo(
    "/flow:test-flow with SKILL.md mermaid flowchart → two turn.begin + " +
      'two turn.end wire events (parent + nested). ' +
      '(pending src: src/soul-plus/skill/manager.ts does not parse ' +
      'mermaid `flowchart` blocks; `/flow:` is not distinguished from ' +
      "`/skill:` today. Migration issue candidate: 'Skill flow mermaid " +
      "parser'.)",
  );
});

describe('wire mcp — #3 MCP tool call + loading + approval', () => {
  it.todo(
    'spawn node mcp ping server (R4 方案 B via @modelcontextprotocol/sdk) → ' +
      'LLM invokes `ping` → wire emits mcp.loading(begin/end) + ' +
      'status.update (mcp_status) + approval.request(reverse-RPC) → ' +
      'approve → wire tool.result content=`pong:hi`. ' +
      '(pending src: MCP manager does not emit mcp.loading / mcp_status ' +
      'wire events; approval reverse-RPC bridge also missing. Covered as ' +
      'one compound dependency — both land together in Phase 11.)',
  );
});
