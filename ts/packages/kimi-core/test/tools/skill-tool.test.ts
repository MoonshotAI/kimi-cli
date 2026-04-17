/**
 * SkillTool — Slice 7.1 (决策 #99) tests.
 *
 * Pins the contract of the collaboration tool that lets the LLM
 * autonomously invoke a registered skill. Two branches:
 *   - Inline: metadata.type is absent / 'prompt' / 'inline' — content
 *     is appended to ContextState via SkillInlineWriter.
 *   - Fork: metadata.type is 'fork' or 'standard' — a subagent is
 *     spawned through SubagentHost.spawn and the completion awaited.
 *
 * Anti-loop: recursive depth is capped by MAX_SKILL_QUERY_DEPTH.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  MAX_SKILL_QUERY_DEPTH,
  SkillTool,
  SkillToolInputSchema,
} from '../../src/tools/skill-tool.js';
import type { SkillInlineWriter } from '../../src/soul-plus/skill/inline-writer.js';
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

interface StubManager extends SkillManager {
  readonly _byName: Map<string, SkillDefinition>;
}

function stubManager(skills: readonly SkillDefinition[] = []): StubManager {
  const byName = new Map<string, SkillDefinition>();
  for (const s of skills) byName.set(s.name.toLowerCase(), s);
  const m: StubManager = {
    _byName: byName,
    getSkill: (n: string) => byName.get(n.toLowerCase()),
    listSkills: () => [...byName.values()],
    listInvocableSkills: () =>
      [...byName.values()].filter((s) => s.metadata.disableModelInvocation !== true),
    injectSkillListing: async () => {},
    activate: async () => {},
    registerBuiltinSkill: () => {},
    getSkillRoots: () => [],
    getKimiSkillsDescription: () => '',
  } as unknown as StubManager;
  return m;
}

function stubInlineWriter(): SkillInlineWriter & { inject: ReturnType<typeof vi.fn> } {
  const inject = vi.fn(async () => {});
  return { inject } as unknown as SkillInlineWriter & { inject: ReturnType<typeof vi.fn> };
}

function stubSubagentHost(
  resultText = 'fork-result',
): SubagentHost & { spawn: ReturnType<typeof vi.fn>; lastRequest: SpawnRequest | null } {
  const state: { lastRequest: SpawnRequest | null } = { lastRequest: null };
  const spawn = vi.fn(async (req: SpawnRequest): Promise<SubagentHandle> => {
    state.lastRequest = req;
    const result: AgentResult = { result: resultText, usage: { input: 1, output: 1 } };
    return {
      agentId: 'sub_42',
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

describe('SkillTool metadata / schema', () => {
  it('has the canonical "Skill" name', () => {
    const tool = new SkillTool({
      skillManager: stubManager(),
      inlineWriter: stubInlineWriter(),
      subagentHost: stubSubagentHost(),
    });
    expect(tool.name).toBe('Skill');
  });

  it('inputSchema requires `skill: string` and accepts optional `args: string`', () => {
    expect(SkillToolInputSchema.safeParse({ skill: 'commit' }).success).toBe(true);
    expect(SkillToolInputSchema.safeParse({ skill: 'commit', args: '-m fix' }).success).toBe(true);
    expect(SkillToolInputSchema.safeParse({}).success).toBe(false);
    expect(SkillToolInputSchema.safeParse({ skill: 123 }).success).toBe(false);
  });

  it('MAX_SKILL_QUERY_DEPTH is 3', () => {
    expect(MAX_SKILL_QUERY_DEPTH).toBe(3);
  });
});

describe('SkillTool.execute — lookup + user-only guards', () => {
  it('returns isError when the skill name is unknown', async () => {
    const tool = new SkillTool({
      skillManager: stubManager(),
      inlineWriter: stubInlineWriter(),
      subagentHost: stubSubagentHost(),
    });
    const signal = new AbortController().signal;
    const result = await tool.execute('tc_1', { skill: 'missing' }, signal);
    expect(result.isError).toBe(true);
    const text = typeof result.content === 'string'
      ? result.content
      : result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(text).toContain('missing');
  });

  it('returns isError when the skill has disableModelInvocation: true', async () => {
    const tool = new SkillTool({
      skillManager: stubManager([
        mkSkill('secret', { disableModelInvocation: true }),
      ]),
      inlineWriter: stubInlineWriter(),
      subagentHost: stubSubagentHost(),
    });
    const result = await tool.execute('tc_1', { skill: 'secret' }, new AbortController().signal);
    expect(result.isError).toBe(true);
    const text = typeof result.content === 'string'
      ? result.content
      : result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(text.toLowerCase()).toMatch(/user[- ]only|disabled/);
  });
});

describe('SkillTool.execute — inline mode', () => {
  it('injects the skill content via SkillInlineWriter and returns a success note', async () => {
    const writer = stubInlineWriter();
    const subagent = stubSubagentHost();
    const skill = mkSkill('commit');
    const tool = new SkillTool({
      skillManager: stubManager([skill]),
      inlineWriter: writer,
      subagentHost: subagent,
    });

    const result = await tool.execute(
      'tc_1',
      { skill: 'commit', args: 'message text' },
      new AbortController().signal,
    );

    expect(writer.inject).toHaveBeenCalledTimes(1);
    const [injectedSkill, injectedArgs, injectedDepth] = writer.inject.mock.calls[0] ?? [];
    expect(injectedSkill).toMatchObject({ name: 'commit' });
    expect(injectedArgs).toBe('message text');
    expect(injectedDepth).toBe(1);
    expect(subagent.spawn).not.toHaveBeenCalled();
    expect(result.isError).toBeFalsy();
    const text = typeof result.content === 'string'
      ? result.content
      : result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(text.toLowerCase()).toContain('inline');
  });

  it('passes depth+1 when queryDepth is non-zero (nested skill call)', async () => {
    const writer = stubInlineWriter();
    const tool = new SkillTool({
      skillManager: stubManager([mkSkill('nested')]),
      inlineWriter: writer,
      subagentHost: stubSubagentHost(),
      queryDepth: 2,
    });
    await tool.execute('tc_1', { skill: 'nested' }, new AbortController().signal);
    const [, , depth] = writer.inject.mock.calls[0] ?? [];
    expect(depth).toBe(3);
  });
});

describe('SkillTool.execute — fork mode', () => {
  it('spawns a subagent when metadata.type === "fork"', async () => {
    const subagent = stubSubagentHost('fork done');
    const writer = stubInlineWriter();
    const tool = new SkillTool({
      skillManager: stubManager([mkSkill('pipeline', { type: 'fork' })]),
      inlineWriter: writer,
      subagentHost: subagent,
    });
    const result = await tool.execute(
      'tc_1',
      { skill: 'pipeline', args: 'go' },
      new AbortController().signal,
    );
    expect(subagent.spawn).toHaveBeenCalledTimes(1);
    expect(writer.inject).not.toHaveBeenCalled();
    const text = typeof result.content === 'string'
      ? result.content
      : result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(text).toContain('fork done');
  });

  it('spawns a subagent when metadata.type === "standard"', async () => {
    const subagent = stubSubagentHost('standard ok');
    const tool = new SkillTool({
      skillManager: stubManager([mkSkill('multistep', { type: 'standard' })]),
      inlineWriter: stubInlineWriter(),
      subagentHost: subagent,
    });
    await tool.execute('tc_1', { skill: 'multistep' }, new AbortController().signal);
    expect(subagent.spawn).toHaveBeenCalled();
  });

  it('forwards the parent AbortSignal into the SpawnRequest (M-1)', async () => {
    const subagent = stubSubagentHost();
    const tool = new SkillTool({
      skillManager: stubManager([mkSkill('long-running', { type: 'fork' })]),
      inlineWriter: stubInlineWriter(),
      subagentHost: subagent,
    });
    const controller = new AbortController();
    await tool.execute('tc_1', { skill: 'long-running' }, controller.signal);
    const req = subagent.lastRequest;
    expect(req).not.toBeNull();
    // Same signal instance so a parent abort cascades into the child.
    expect(req?.signal).toBe(controller.signal);
  });

  it('forwards skillContext.queryDepth = depth+1 into the SpawnRequest', async () => {
    const subagent = stubSubagentHost();
    const tool = new SkillTool({
      skillManager: stubManager([mkSkill('inner', { type: 'fork' })]),
      inlineWriter: stubInlineWriter(),
      subagentHost: subagent,
      queryDepth: 1,
    });
    await tool.execute('tc_1', { skill: 'inner' }, new AbortController().signal);
    const req = subagent.lastRequest;
    expect(req).not.toBeNull();
    // The skillContext payload carries the new depth so the child
    // SkillTool (if it fires another Skill call) knows how to cap recursion.
    const ctx = (req as unknown as { skillContext?: { queryDepth?: number } }).skillContext;
    expect(ctx?.queryDepth).toBe(2);
  });
});

describe('SkillTool.execute — recursion depth guard', () => {
  it('returns isError when queryDepth already exceeds MAX_SKILL_QUERY_DEPTH', async () => {
    const writer = stubInlineWriter();
    const subagent = stubSubagentHost();
    const tool = new SkillTool({
      skillManager: stubManager([mkSkill('loopy')]),
      inlineWriter: writer,
      subagentHost: subagent,
      queryDepth: MAX_SKILL_QUERY_DEPTH, // next depth is MAX+1
    });
    const result = await tool.execute('tc_1', { skill: 'loopy' }, new AbortController().signal);
    expect(result.isError).toBe(true);
    expect(writer.inject).not.toHaveBeenCalled();
    expect(subagent.spawn).not.toHaveBeenCalled();
    const text = typeof result.content === 'string'
      ? result.content
      : result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(text).toMatch(/depth|recurs/i);
  });
});
