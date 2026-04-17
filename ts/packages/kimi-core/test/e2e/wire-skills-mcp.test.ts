/* oxlint-disable vitest/warn-todo -- Phase 17 B.4 defers MCP-wire
   round-trip to the CLI Phase. The flow-mermaid parser assertion is
   now a passing test under `test/soul-plus/skill/mermaid-parser.test.ts`
   (B.5). */
/**
 * Wire E2E — skills + MCP surface.
 *
 * Phase 17 B.4 / B.5 status:
 *   #1 skill_prompt_injects_skill_text — CLI Phase follow-up
 *      (decision #99 user-slash direct path; needs slash → wire bridge).
 *   #2 flow_skill mermaid — parser now in place (B.5); wire-surface
 *      nested-turn assertion stays CLI Phase follow-up because the
 *      nested-turn bridge is out of Phase 17 scope.
 *   #3 mcp_tool_call — CLI Phase follow-up (real MCP connection +
 *      mcp.loading / status.update wire event emission).
 *
 * Scaffold kept so lift is mechanical once the wire surface ships.
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

describe('wire skills — #1 /skill: injects SKILL.md body as user_message', () => {
  it.todo(
    '/skill:test-skill → wire.jsonl contains user_message record with SKILL.md body (CLI Phase follow-up — needs slash → wire bridge per decision #99)',
  );
});

describe('wire skills — #2 /flow: triggers nested turns (mermaid)', () => {
  it.todo(
    '/flow:test-flow with mermaid flowchart → two turn.begin + two turn.end wire events (CLI Phase follow-up — parser now exists per Phase 17 B.5; nested-turn bridge still pending)',
  );
});

describe('wire mcp — #3 MCP tool call + loading + approval', () => {
  it.todo(
    'spawn node mcp ping server → tool call + mcp.loading + status.update + approval round-trip (CLI Phase follow-up — real MCP connection owned by independent MCP slice)',
  );
});
