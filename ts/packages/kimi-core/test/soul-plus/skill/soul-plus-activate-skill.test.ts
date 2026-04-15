/**
 * SoulPlus.activateSkill — Slice 2.5 integration test.
 *
 * Validates that (a) the facade delegates to the injected
 * SkillManager with the session ContextState and (b) the activation
 * is visible as a user message on the next buildMessages() drain.
 */

import { describe, expect, it } from 'vitest';

import {
  DefaultSkillManager,
  SessionEventBus,
  SoulPlus,
  createRuntime,
} from '../../../src/soul-plus/index.js';
import type { SkillDefinition } from '../../../src/soul-plus/index.js';
import { InMemorySessionJournalImpl } from '../../../src/storage/session-journal.js';
import { makeEndTurnResponse } from '../../soul/fixtures/common.js';
import { ScriptedKosongAdapter } from '../../soul/fixtures/scripted-kosong.js';
import {
  createHarnessContextState,
  createNoopCompactionProvider,
  createNoopJournalCapability,
  createSpyLifecycleGate,
} from '../fixtures/slice3-harness.js';

function commitSkill(): SkillDefinition {
  return {
    name: 'commit',
    description: 'write a commit message',
    path: '/skills/commit/SKILL.md',
    content: 'Write a conventional commit based on staged diffs.',
    metadata: {},
    source: 'builtin',
  };
}

async function buildWiredSoulPlus() {
  const contextState = createHarnessContextState();
  const sessionJournal = new InMemorySessionJournalImpl();
  const runtime = createRuntime({
    kosong: new ScriptedKosongAdapter({ responses: [makeEndTurnResponse('ok')] }),
    lifecycle: createSpyLifecycleGate(),
    compactionProvider: createNoopCompactionProvider(),
    journal: createNoopJournalCapability(),
  });
  const eventBus = new SessionEventBus();
  const skillManager = new DefaultSkillManager({
    discover: async () => [commitSkill()],
  });
  await skillManager.init([{ path: '/skills', source: 'builtin' }]);
  const soulPlus = new SoulPlus({
    sessionId: 'ses_slice2_5',
    contextState,
    sessionJournal,
    runtime,
    eventBus,
    tools: [],
    skillManager,
  });
  return { soulPlus, contextState, skillManager };
}

describe('SoulPlus.activateSkill', () => {
  it('appends the skill body + args as the next user message', async () => {
    const { soulPlus, contextState } = await buildWiredSoulPlus();
    await soulPlus.activateSkill('commit', '-m "fix"');
    const messages = contextState.buildMessages();
    expect(messages).toHaveLength(1);
    const text = messages[0]?.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');
    expect(text).toContain('Write a conventional commit');
    expect(text).toContain('User request:');
    expect(text).toContain('-m "fix"');
  });

  it('throws when no SkillManager is wired', async () => {
    const contextState = createHarnessContextState();
    const sessionJournal = new InMemorySessionJournalImpl();
    const runtime = createRuntime({
      kosong: new ScriptedKosongAdapter({ responses: [makeEndTurnResponse('ok')] }),
      lifecycle: createSpyLifecycleGate(),
      compactionProvider: createNoopCompactionProvider(),
      journal: createNoopJournalCapability(),
    });
    const eventBus = new SessionEventBus();
    const soulPlus = new SoulPlus({
      sessionId: 'ses_nomanager',
      contextState,
      sessionJournal,
      runtime,
      eventBus,
      tools: [],
    });
    await expect(soulPlus.activateSkill('anything', '')).rejects.toThrow(/SkillManager/);
  });

  it('exposes the SkillManager via getSkillManager for upstream wiring', async () => {
    const { soulPlus, skillManager } = await buildWiredSoulPlus();
    expect(soulPlus.getSkillManager()).toBe(skillManager);
  });
});
