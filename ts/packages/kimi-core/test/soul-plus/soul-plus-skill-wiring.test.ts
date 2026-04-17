/**
 * SoulPlus ↔ SkillTool / SkillManager wiring — Slice 7.1 (决策 #99).
 *
 * Pins the construction-time integration:
 *   - When `SoulPlusDeps.skillManager` is omitted, no `Skill` tool gets
 *     wired in (parity with pre-Phase-7 behaviour).
 *   - When a SkillManager is supplied but reports no invocable skills,
 *     the `Skill` tool is still NOT registered (avoids advertising an
 *     empty surface).
 *   - When at least one invocable skill exists, a `Skill` tool appears
 *     in the assembled tool list.
 *   - `SoulPlus.init()` calls `SkillManager.injectSkillListing` so the
 *     durable `<system-reminder>` reaches ContextState before the first
 *     turn.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  SessionEventBus,
  SoulPlus,
  createRuntime,
} from '../../src/soul-plus/index.js';
import type {
  SkillDefinition,
  SkillManager,
} from '../../src/soul-plus/skill/index.js';
import { InMemorySessionJournalImpl } from '../../src/storage/session-journal.js';
import { SkillTool } from '../../src/tools/skill-tool.js';
import { makeEndTurnResponse } from '../soul/fixtures/common.js';
import { ScriptedKosongAdapter } from '../soul/fixtures/scripted-kosong.js';
import {
  createHarnessContextState,
  createNoopCompactionProvider,
  createNoopJournalCapability,
  createSpyLifecycleGate,
} from './fixtures/slice3-harness.js';

function mkSkill(name: string, overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name,
    description: `desc for ${name}`,
    path: `/skills/${name}/SKILL.md`,
    content: `body of ${name}`,
    metadata: {},
    source: 'user',
    ...overrides,
  };
}

function stubSkillManager(skills: readonly SkillDefinition[]): SkillManager {
  const byName = new Map<string, SkillDefinition>();
  for (const s of skills) byName.set(s.name.toLowerCase(), s);
  return {
    getSkill: (n) => byName.get(n.toLowerCase()),
    listSkills: () => [...byName.values()],
    listInvocableSkills: () =>
      [...byName.values()].filter((s) => s.metadata.disableModelInvocation !== true),
    injectSkillListing: vi.fn(async () => {}),
    activate: vi.fn(async () => {}),
    registerBuiltinSkill: () => {},
    getSkillRoots: () => [],
    getKimiSkillsDescription: () => '',
  } satisfies SkillManager;
}

function buildSoul(skillManager?: SkillManager): SoulPlus {
  const contextState = createHarnessContextState();
  const sessionJournal = new InMemorySessionJournalImpl();
  const runtime = createRuntime({
    kosong: new ScriptedKosongAdapter({ responses: [makeEndTurnResponse('ok')] }),
    lifecycle: createSpyLifecycleGate(),
    compactionProvider: createNoopCompactionProvider(),
    journal: createNoopJournalCapability(),
  });
  const eventBus = new SessionEventBus();
  return new SoulPlus({
    sessionId: 'ses_skill_wiring',
    contextState,
    sessionJournal,
    runtime,
    eventBus,
    tools: [],
    ...(skillManager !== undefined ? { skillManager } : {}),
  });
}

describe('SoulPlus — SkillTool registration (Slice 7.1)', () => {
  it('does NOT register a Skill tool when no SkillManager is supplied', () => {
    const soul = buildSoul();
    const tools = soul.getTools();
    expect(tools.find((t) => t.name === 'Skill')).toBeUndefined();
  });

  it('does NOT register a Skill tool when the SkillManager has no invocable skills', () => {
    const manager = stubSkillManager([]);
    const soul = buildSoul(manager);
    expect(soul.getTools().find((t) => t.name === 'Skill')).toBeUndefined();
  });

  it('does NOT register a Skill tool when every skill is user-only', () => {
    const manager = stubSkillManager([
      mkSkill('private', { metadata: { disableModelInvocation: true } }),
    ]);
    const soul = buildSoul(manager);
    expect(soul.getTools().find((t) => t.name === 'Skill')).toBeUndefined();
  });

  it('registers exactly one SkillTool when at least one invocable skill exists', () => {
    const manager = stubSkillManager([mkSkill('commit'), mkSkill('release')]);
    const soul = buildSoul(manager);
    const skillTools = soul.getTools().filter((t) => t.name === 'Skill');
    expect(skillTools).toHaveLength(1);
    expect(skillTools[0]).toBeInstanceOf(SkillTool);
  });
});

describe('SoulPlus.init — injectSkillListing wiring (Slice 7.1)', () => {
  it('calls SkillManager.injectSkillListing on init when a SkillManager is supplied', async () => {
    const manager = stubSkillManager([mkSkill('commit')]);
    const soul = buildSoul(manager);
    await soul.init();
    expect(manager.injectSkillListing).toHaveBeenCalledTimes(1);
  });

  it('init() is a no-op when no SkillManager is supplied', async () => {
    const soul = buildSoul();
    await expect(soul.init()).resolves.toBeUndefined();
  });

  it('init() can be called twice without throwing (re-injection allowed)', async () => {
    const manager = stubSkillManager([mkSkill('commit')]);
    const soul = buildSoul(manager);
    await soul.init();
    await soul.init();
    expect(manager.injectSkillListing).toHaveBeenCalledTimes(2);
  });
});
