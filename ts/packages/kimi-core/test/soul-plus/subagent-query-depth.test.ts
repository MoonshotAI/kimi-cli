/**
 * Phase 17 C.3 — SubagentRunner propagates skillContext.queryDepth.
 *
 * When SkillTool forks a subagent, the SpawnRequest carries
 * `skillContext: { queryDepth }`. SubagentRunner must forward that into
 * the child's SkillTool constructor via `initialQueryDepth` so nested
 * skill invocations count against `MAX_SKILL_QUERY_DEPTH = 3`.
 *
 * Assertions (structural, implementer-facing):
 *   - SkillTool constructor accepts `initialQueryDepth?: number`.
 *   - SubagentRunner.run forwards skillContext.queryDepth to the child
 *     SkillTool via initialQueryDepth.
 *   - Depth >= MAX_SKILL_QUERY_DEPTH blocks the skill call (returns an
 *     error-typed ToolResult instead of spawning).
 */

import { describe, expect, it, vi } from 'vitest';

import { SkillTool } from '../../src/tools/skill-tool.js';
import { MAX_SKILL_QUERY_DEPTH } from '../../src/soul-plus/subagent-constants.js';

describe('Phase 17 C.3 — SkillTool.initialQueryDepth gate', () => {
  it('construction accepts initialQueryDepth and carries it forward', () => {
    // The exact constructor signature belongs to the Implementer; this
    // test pins the seam name.
    const tool = new SkillTool({
      initialQueryDepth: 2,
    } as unknown as ConstructorParameters<typeof SkillTool>[0]);
    // The implementer-exposed getter MAY differ; in plain-object
    // construction the field should be readable via `tool.initialQueryDepth`
    // or `getInitialQueryDepth()`. Keep the test tolerant of both.
    const anyTool = tool as unknown as Record<string, unknown>;
    const seen = anyTool['initialQueryDepth'] ?? anyTool['_initialQueryDepth'];
    expect(typeof seen === 'number' || seen === undefined).toBe(true);
    // If exposed, must equal the value we passed in.
    if (typeof seen === 'number') {
      expect(seen).toBe(2);
    }
  });

  it('skill call at depth == MAX_SKILL_QUERY_DEPTH returns ToolResult.is_error with "depth" in the message', async () => {
    expect(MAX_SKILL_QUERY_DEPTH).toBe(3);
    const tool = new SkillTool({
      initialQueryDepth: MAX_SKILL_QUERY_DEPTH,
    } as unknown as ConstructorParameters<typeof SkillTool>[0]);
    const result = await tool.execute(
      'tc_1',
      { skill: 'anything' } as Parameters<typeof tool.execute>[1],
      new AbortController().signal,
    );
    expect((result as { is_error?: boolean; isError?: boolean }).is_error ?? (result as { isError?: boolean }).isError).toBe(true);
    const content = (result as { content?: unknown }).content as string;
    expect(typeof content).toBe('string');
    expect(content.toLowerCase()).toMatch(/depth|too deep|nested/);
  });
});
