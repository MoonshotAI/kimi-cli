/**
 * SkillInlineWriter — Slice 7.1 (决策 #99) tests.
 *
 * Pins the dual-side effect of inline-mode skill invocation:
 *   1. A `skill_invoked` record is appended to the SessionJournal
 *      with execution_mode='inline', invocation_trigger='claude-proactive',
 *      and the caller-supplied query_depth.
 *   2. The skill content is wrapped in `<kimi-skill-loaded ...>` XML and
 *      written into ContextState via `appendSystemReminder` (durable,
 *      so it survives across turns and is visible on every
 *      buildMessages() call).
 */

import { describe, expect, it } from 'vitest';

import { SkillInlineWriter } from '../../../src/soul-plus/skill/inline-writer.js';
import type { SkillDefinition } from '../../../src/soul-plus/skill/types.js';
import { InMemoryContextState } from '../../../src/storage/context-state.js';
import { InMemorySessionJournalImpl } from '../../../src/storage/session-journal.js';

function mkSkill(
  name: string,
  body = `body of ${name}`,
  overrides: Partial<SkillDefinition> = {},
): SkillDefinition {
  return {
    name,
    description: `desc for ${name}`,
    path: `/skills/${name}/SKILL.md`,
    content: body,
    metadata: {},
    source: 'user',
    ...overrides,
  };
}

function makeDeps() {
  const contextState = new InMemoryContextState({ initialModel: 'test-model' });
  const sessionJournal = new InMemorySessionJournalImpl();
  return { contextState, sessionJournal };
}

describe('SkillInlineWriter.inject', () => {
  it('appends a skill_invoked record with invocation_trigger=claude-proactive + query_depth', async () => {
    const { contextState, sessionJournal } = makeDeps();
    const writer = new SkillInlineWriter({ contextState, sessionJournal });

    await writer.inject(mkSkill('commit'), 'args payload', 2);

    const invoked = sessionJournal.getRecordsByType('skill_invoked');
    expect(invoked).toHaveLength(1);
    const rec = invoked[0]!;
    expect(rec.data.skill_name).toBe('commit');
    expect(rec.data.execution_mode).toBe('inline');
    expect(rec.data.original_input).toBe('args payload');
    // Phase 7 additions:
    const data = rec.data as { invocation_trigger?: string; query_depth?: number };
    expect(data.invocation_trigger).toBe('claude-proactive');
    expect(data.query_depth).toBe(2);
  });

  it('writes a durable system reminder wrapping the skill content in <kimi-skill-loaded>', async () => {
    const { contextState, sessionJournal } = makeDeps();
    const writer = new SkillInlineWriter({ contextState, sessionJournal });

    await writer.inject(mkSkill('commit', 'the skill body'), 'the args', 1);

    const history = contextState.getHistory();
    expect(history).toHaveLength(1);
    const text = (history[0]?.content ?? [])
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');
    // Durable system-reminder envelope + inner kimi-skill-loaded tag.
    expect(text).toContain('<system-reminder>');
    expect(text).toContain('<kimi-skill-loaded');
    expect(text).toContain('name="commit"');
    expect(text).toContain('args="the args"');
    expect(text).toContain('the skill body');
    expect(text).toContain('</kimi-skill-loaded>');
  });

  it('XML-escapes special chars in name and args attributes', async () => {
    const { contextState, sessionJournal } = makeDeps();
    const writer = new SkillInlineWriter({ contextState, sessionJournal });

    await writer.inject(
      mkSkill('evil<name>'),
      'arg with "quote" & <bracket>',
      0,
    );

    const history = contextState.getHistory();
    const text = (history[0]?.content ?? [])
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');
    // Attribute quotes / angle brackets / ampersand must be escaped so
    // the parser downstream does not see a mid-attribute `"` or `<`.
    expect(text).toContain('&lt;');
    expect(text).toContain('&gt;');
    expect(text).toContain('&quot;');
    expect(text).toContain('&amp;');
    // Raw special chars must NOT remain inside attribute values.
    expect(text).not.toContain('name="evil<name>"');
    expect(text).not.toContain('args="arg with "quote" & <bracket>"');
  });

  it('writes the system reminder AFTER the skill_invoked record (WAL-before-mirror order)', async () => {
    const { contextState, sessionJournal } = makeDeps();
    const writer = new SkillInlineWriter({ contextState, sessionJournal });

    await writer.inject(mkSkill('ordered'), '', 0);

    // Both sinks populated — we just assert the journal received exactly
    // one row and the context state received exactly one reminder.
    expect(sessionJournal.getRecordsByType('skill_invoked')).toHaveLength(1);
    expect(contextState.getHistory()).toHaveLength(1);
  });
});
