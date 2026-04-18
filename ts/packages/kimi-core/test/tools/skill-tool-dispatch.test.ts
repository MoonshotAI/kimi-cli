/**
 * SkillTool dispatch — Phase 18 Section C.1 / C.3 edge tests.
 *
 * Complements the canonical `skill-tool.test.ts`. Pins behaviours that
 * sit at the Phase 18 boundary (已部分实装, but with gaps for depth
 * and dispatch semantics):
 *
 *   - C.1 SkillTool dispatch closure: inline vs fork branching under
 *     edge conditions (missing skill, user-only guards, sub-Soul
 *     skillContext propagation).
 *   - C.3 queryDepth boundary semantics: depth=0 -> claude-proactive
 *     trigger, depth>0 -> nested-skill trigger, depth=3 boundary.
 *
 * These tests RED when the implementation does not yet:
 *   - pass invocationTrigger through to the inline writer
 *   - throw `NestedSkillTooDeepError` at the hard cap (only a soft
 *     tool-error is currently returned)
 */

import { describe, expect, it, vi } from 'vitest';

import {
  MAX_SKILL_QUERY_DEPTH,
  SkillTool,
} from '../../src/tools/skill-tool.js';
import type { SkillInlineWriter } from '../../src/soul-plus/skill/inline-writer.js';
import { NestedSkillTooDeepError } from '../../src/soul-plus/skill/errors.js';
import type {
  SkillDefinition,
  SkillManager,
  SkillMetadata,
} from '../../src/soul-plus/skill/types.js';
import type {
  AgentResult,
  SpawnRequest,
  SubagentHandle,
  SubagentHost,
} from '../../src/soul-plus/subagent-types.js';

function mkSkill(name: string, metadata: SkillMetadata = {}): SkillDefinition {
  return {
    name,
    description: `desc for ${name}`,
    path: `/skills/${name}/SKILL.md`,
    content: `body of ${name}`,
    metadata,
    source: 'user',
  };
}

function stubManager(skills: readonly SkillDefinition[] = []): SkillManager {
  const byName = new Map<string, SkillDefinition>();
  for (const s of skills) byName.set(s.name.toLowerCase(), s);
  return {
    getSkill: (n: string) => byName.get(n.toLowerCase()),
    listSkills: () => [...byName.values()],
    listInvocableSkills: () =>
      [...byName.values()].filter((s) => s.metadata.disableModelInvocation !== true),
    injectSkillListing: async () => {},
    activate: async () => {},
    registerBuiltinSkill: () => {},
    getSkillRoots: () => [],
    getKimiSkillsDescription: () => '',
  } as SkillManager;
}

interface StubInlineWriter {
  readonly inject: ReturnType<typeof vi.fn>;
  readonly calls: Array<{
    skill: SkillDefinition;
    args: string;
    depth: number;
    trigger?: string;
  }>;
}

function stubInlineWriter(): StubInlineWriter & SkillInlineWriter {
  const calls: StubInlineWriter['calls'] = [];
  const inject = vi.fn(
    async (skill: SkillDefinition, args: string, depth: number, trigger?: string) => {
      calls.push({ skill, args, depth, ...(trigger === undefined ? {} : { trigger }) });
    },
  );
  return { inject, calls } as unknown as StubInlineWriter & SkillInlineWriter;
}

function stubSubagentHost(
  resultText = 'ok',
): SubagentHost & { spawn: ReturnType<typeof vi.fn>; lastRequest: SpawnRequest | null } {
  const state: { lastRequest: SpawnRequest | null } = { lastRequest: null };
  const spawn = vi.fn(async (req: SpawnRequest): Promise<SubagentHandle> => {
    state.lastRequest = req;
    const result: AgentResult = { result: resultText, usage: { input: 1, output: 1 } };
    return {
      agentId: 'sub_1',
      parentToolCallId: req.parentToolCallId,
      completion: Promise.resolve(result),
    };
  });
  return {
    spawn,
    get lastRequest() {
      return state.lastRequest;
    },
  } as unknown as SubagentHost & { spawn: typeof spawn; lastRequest: SpawnRequest | null };
}

// ── C.1 edge cases ───────────────────────────────────────────────────

describe('SkillTool.execute — C.1 dispatch closure edges', () => {
  it('returns a tool error (not a throw) when the skill is unknown', async () => {
    const tool = new SkillTool({
      skillManager: stubManager(),
      inlineWriter: stubInlineWriter(),
      subagentHost: stubSubagentHost(),
    });
    const res = await tool.execute('tc_1', { skill: 'nope' }, new AbortController().signal);
    expect(res.isError).toBe(true);
    // must not throw — LLM sees a graceful tool error
  });

  it('rejects disableModelInvocation skills with a "user-only" error message', async () => {
    const tool = new SkillTool({
      skillManager: stubManager([mkSkill('secret', { disableModelInvocation: true })]),
      inlineWriter: stubInlineWriter(),
      subagentHost: stubSubagentHost(),
    });
    const res = await tool.execute('tc_1', { skill: 'secret' }, new AbortController().signal);
    expect(res.isError).toBe(true);
    const text = typeof res.content === 'string'
      ? res.content
      : res.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    // v2 §15.2 D-B: exact phrase "can only be triggered by the user" — Phase 18
    // tightens the wording to match the spec.
    expect(text.toLowerCase()).toMatch(/can only be triggered by the user/);
  });

  it('fork-mode spawn carries skillContext with allowedTools / disallowedTools', async () => {
    const subagent = stubSubagentHost('ok');
    const tool = new SkillTool({
      skillManager: stubManager([
        mkSkill('review', {
          type: 'fork',
          allowedTools: ['Bash', 'Read'],
          disallowedTools: ['Write'],
        }),
      ]),
      inlineWriter: stubInlineWriter(),
      subagentHost: subagent,
    });
    await tool.execute('tc_1', { skill: 'review' }, new AbortController().signal);
    const req = subagent.lastRequest;
    const sc = (req as unknown as {
      skillContext?: {
        queryDepth?: number;
        allowedTools?: readonly string[];
        disallowedTools?: readonly string[];
      };
    }).skillContext;
    // Phase 18: skillContext must carry the tool whitelists so the sub-Soul
    // can instantiate its ToolRegistry with the correct set (v2 §15.9.3).
    expect(sc?.allowedTools).toEqual(['Bash', 'Read']);
    expect(sc?.disallowedTools).toEqual(['Write']);
  });
});

// ── C.3 depth / trigger propagation ──────────────────────────────────

describe('SkillTool.execute — C.3 trigger + depth propagation', () => {
  it('queryDepth=0 passes trigger="claude-proactive" to the inline writer', async () => {
    const writer = stubInlineWriter();
    const tool = new SkillTool({
      skillManager: stubManager([mkSkill('commit')]),
      inlineWriter: writer,
      subagentHost: stubSubagentHost(),
      queryDepth: 0,
    });
    await tool.execute('tc_1', { skill: 'commit' }, new AbortController().signal);
    expect(writer.calls.length).toBe(1);
    expect(writer.calls[0]?.trigger).toBe('claude-proactive');
  });

  it('queryDepth>0 passes trigger="nested-skill" to the inline writer', async () => {
    const writer = stubInlineWriter();
    const tool = new SkillTool({
      skillManager: stubManager([mkSkill('inner')]),
      inlineWriter: writer,
      subagentHost: stubSubagentHost(),
      queryDepth: 1,
    });
    await tool.execute('tc_1', { skill: 'inner' }, new AbortController().signal);
    expect(writer.calls[0]?.trigger).toBe('nested-skill');
  });

  it('queryDepth=2 fork-mode spawn sets child skillContext.queryDepth=3', async () => {
    const subagent = stubSubagentHost();
    const tool = new SkillTool({
      skillManager: stubManager([mkSkill('nested', { type: 'fork' })]),
      inlineWriter: stubInlineWriter(),
      subagentHost: subagent,
      queryDepth: 2,
    });
    await tool.execute('tc_1', { skill: 'nested' }, new AbortController().signal);
    const sc = (subagent.lastRequest as unknown as {
      skillContext?: { queryDepth?: number };
    }).skillContext;
    expect(sc?.queryDepth).toBe(3);
  });

  it('queryDepth=MAX_SKILL_QUERY_DEPTH throws NestedSkillTooDeepError (hard stop)', async () => {
    const writer = stubInlineWriter();
    const tool = new SkillTool({
      skillManager: stubManager([mkSkill('loop')]),
      inlineWriter: writer,
      subagentHost: stubSubagentHost(),
      queryDepth: MAX_SKILL_QUERY_DEPTH,
    });
    // Phase 18 C.3: once the recursion hard cap is hit, the tool throws a
    // structured error rather than returning a soft tool-error. This pins
    // the upgrade.
    await expect(
      tool.execute('tc_1', { skill: 'loop' }, new AbortController().signal),
    ).rejects.toBeInstanceOf(NestedSkillTooDeepError);
  });
});
