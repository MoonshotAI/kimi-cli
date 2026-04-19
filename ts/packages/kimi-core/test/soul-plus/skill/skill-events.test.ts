/**
 * Phase 24 T2 — Skill events (skill.invoked / skill.completed) SoulEvent.
 *
 * After Phase 24 Step 3 implementation:
 *   - SkillInlineWriter.inject() must emit `skill.invoked` SoulEvent to EventBus
 *   - SkillInlineWriter must also append `skill_completed` + emit `skill.completed`
 *   - Fields: skill_name / execution_mode / invocation_trigger / query_depth
 *
 * ALL tests here are skipped because they require:
 *   1. New `eventBus: SessionEventBus` dep on `SkillInlineWriterDeps`
 *   2. New SoulEvent variants `skill.invoked` / `skill.completed` in event-sink.ts
 *   3. Emit calls in inline-writer.ts and skill manager.ts
 *
 * Phase 24 Step 3: Implementer must unskip after adding eventBus dep + emit calls.
 */

import { describe, expect, it } from 'vitest';

import { SkillInlineWriter } from '../../../src/soul-plus/skill/inline-writer.js';
import type { SkillInlineWriterDeps } from '../../../src/soul-plus/skill/inline-writer.js';
import type { SkillDefinition } from '../../../src/soul-plus/skill/types.js';
import { SessionEventBus } from '../../../src/soul-plus/session-event-bus.js';
import { InMemoryContextState } from '../../../src/storage/context-state.js';
import { InMemorySessionJournalImpl } from '../../../src/storage/session-journal.js';
import type { BusEvent } from '../../../src/soul-plus/session-event-bus.js';

function mkSkill(name: string, content = `body of ${name}`): SkillDefinition {
  return {
    name,
    description: `desc for ${name}`,
    path: `/skills/${name}/SKILL.md`,
    content,
    metadata: {},
    source: 'user',
  };
}

function makeDeps(eventBus: SessionEventBus): SkillInlineWriterDeps {
  return {
    contextState: new InMemoryContextState({ initialModel: 'test-model' }),
    sessionJournal: new InMemorySessionJournalImpl(),
    // Phase 24 new dep — not yet on SkillInlineWriterDeps
    eventBus,
  } as unknown as SkillInlineWriterDeps;
}

// Phase 24 Step 3: Implementer must add eventBus dep to SkillInlineWriterDeps and unskip
describe('SkillInlineWriter — SoulEvent emission (Phase 24 T2)', () => {
  it('inject → EventBus receives skill.invoked with correct fields', async () => {
    const eventBus = new SessionEventBus();
    const events: BusEvent[] = [];
    eventBus.on((e) => { events.push(e); });

    const writer = new SkillInlineWriter(makeDeps(eventBus));
    await writer.inject(mkSkill('commit'), 'my args', 2, 'user-slash');

    const skillEvents = events.filter((e) => e.type === 'skill.invoked');
    expect(skillEvents).toHaveLength(1);

    const evt = skillEvents[0] as Extract<BusEvent, { type: 'skill.invoked' }>;
    expect(evt.data.skill_name).toBe('commit');
    expect(evt.data.execution_mode).toBe('inline');
    expect(evt.data.invocation_trigger).toBe('user-slash');
    expect(evt.data.query_depth).toBe(2);
  });

  it('default trigger → skill.invoked carries invocation_trigger=claude-proactive', async () => {
    const eventBus = new SessionEventBus();
    const events: BusEvent[] = [];
    eventBus.on((e) => { events.push(e); });

    const writer = new SkillInlineWriter(makeDeps(eventBus));
    // No explicit trigger → defaults to 'claude-proactive'
    await writer.inject(mkSkill('explore'), 'args', 1);

    const evt = events.find((e) => e.type === 'skill.invoked') as
      | Extract<BusEvent, { type: 'skill.invoked' }>
      | undefined;
    expect(evt).toBeDefined();
    expect(evt!.data.invocation_trigger).toBe('claude-proactive');
  });

  it('EventBus must not receive skill.invoked BEFORE appendSkillInvoked is awaited (WAL-before-emit)', async () => {
    // Wire-precedence: journal write must complete before EventBus emit (铁律 L2.5)
    const eventBus = new SessionEventBus();
    const journal = new InMemorySessionJournalImpl();
    let journalRecordCount = 0;

    eventBus.on((e) => {
      if (e.type === 'skill.invoked') {
        // At the moment of emit, the journal record must already be written
        journalRecordCount = journal.getRecordsByType('skill_invoked').length;
      }
    });

    const deps: SkillInlineWriterDeps = {
      contextState: new InMemoryContextState({ initialModel: 'test-model' }),
      sessionJournal: journal,
      eventBus,
    } as unknown as SkillInlineWriterDeps;

    await new SkillInlineWriter(deps).inject(mkSkill('test'), '', 0);

    // Journal record must have been written BEFORE the emit fired
    expect(journalRecordCount).toBe(1);
  });

  it('original_input field carries the args string', async () => {
    const eventBus = new SessionEventBus();
    const events: BusEvent[] = [];
    eventBus.on((e) => { events.push(e); });

    const writer = new SkillInlineWriter(makeDeps(eventBus));
    await writer.inject(mkSkill('search'), 'my search query', 3, 'nested-skill');

    const evt = events.find((e) => e.type === 'skill.invoked') as
      | Extract<BusEvent, { type: 'skill.invoked' }>
      | undefined;
    expect(evt).toBeDefined();
    expect(evt!.data.original_input).toBe('my search query');
    expect(evt!.data.query_depth).toBe(3);
    expect(evt!.data.invocation_trigger).toBe('nested-skill');
  });
});

// Phase 24 Step 3: manager fork path — also needs EventBus injection in manager.ts
describe('SkillManager (fork path) — SoulEvent emission (Phase 24 T2)', () => {
  it.todo('fork execution → EventBus receives skill.invoked with execution_mode=fork');
});
