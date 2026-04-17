/**
 * DefaultSkillManager — Slice 2.5 tests.
 *
 * Covers: init() loads from discover, activate() appends user
 * message, getKimiSkillsDescription() format, registerBuiltinSkill()
 * host hook, getSkillRoots() exposure, and SkillNotFoundError.
 */

import { describe, expect, it } from 'vitest';

import {
  DefaultSkillManager,
  SkillNotFoundError,
  buildInlinePrompt,
} from '../../../src/soul-plus/skill/index.js';
import type { SkillDefinition, SkillRoot } from '../../../src/soul-plus/skill/index.js';
import { InMemoryContextState } from '../../../src/storage/context-state.js';
import type { FullContextState } from '../../../src/storage/context-state.js';
import { InMemorySessionJournalImpl } from '../../../src/storage/session-journal.js';

function mkDef(name: string, extras: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name,
    description: `desc for ${name}`,
    path: `/abs/${name}/SKILL.md`,
    content: `body of ${name}`,
    metadata: {},
    source: 'user',
    ...extras,
  };
}

function makeContext(): FullContextState {
  return new InMemoryContextState({ initialModel: 'test-model' });
}

describe('buildInlinePrompt', () => {
  it('appends args under a "User request:" suffix', () => {
    expect(buildInlinePrompt('run the thing', 'with verbosity')).toBe(
      'run the thing\n\nUser request:\nwith verbosity',
    );
  });
  it('drops the suffix when args are empty', () => {
    expect(buildInlinePrompt('run the thing', '')).toBe('run the thing');
  });
  it('ignores whitespace-only args', () => {
    expect(buildInlinePrompt('run the thing', '   \n  ')).toBe('run the thing');
  });
});

describe('DefaultSkillManager.init', () => {
  it('populates the registry from discovered skills', async () => {
    const discovered = [mkDef('commit'), mkDef('release')];
    const manager = new DefaultSkillManager({
      discover: async () => discovered,
    });
    await manager.init([{ path: '/fake/root', source: 'user' } satisfies SkillRoot]);
    expect(manager.listSkills().map((s) => s.name)).toEqual(['commit', 'release']);
    expect(manager.getSkill('commit')?.description).toBe('desc for commit');
  });

  it('is case-insensitive on getSkill', async () => {
    const manager = new DefaultSkillManager({
      discover: async () => [mkDef('Commit')],
    });
    await manager.init([{ path: '/fake', source: 'user' }]);
    expect(manager.getSkill('commit')?.name).toBe('Commit');
    expect(manager.getSkill('COMMIT')?.name).toBe('Commit');
  });

  it('preserves all skill roots in getSkillRoots even when some are empty', async () => {
    const manager = new DefaultSkillManager({ discover: async () => [] });
    await manager.init([
      { path: '/a', source: 'builtin' },
      { path: '/b', source: 'user' },
    ]);
    expect(manager.getSkillRoots()).toEqual(['/a', '/b']);
  });
});

describe('DefaultSkillManager.activate', () => {
  it('appends a user message with the skill content + args', async () => {
    const manager = new DefaultSkillManager({
      discover: async () => [mkDef('commit', { content: 'commit body' })],
    });
    await manager.init([{ path: '/r', source: 'user' }]);
    const contextState = makeContext();
    await manager.activate('commit', '-m "fix"', { contextState });
    const messages = contextState.buildMessages();
    expect(messages).toHaveLength(1);
    const text = messages[0]?.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');
    expect(text).toContain('commit body');
    expect(text).toContain('User request:');
    expect(text).toContain('-m "fix"');
  });

  it('throws SkillNotFoundError for unknown names', async () => {
    const manager = new DefaultSkillManager({ discover: async () => [] });
    await manager.init([]);
    await expect(
      manager.activate('nope', '', { contextState: makeContext() }),
    ).rejects.toBeInstanceOf(SkillNotFoundError);
  });

  it('works on case-insensitive lookups', async () => {
    const manager = new DefaultSkillManager({
      discover: async () => [mkDef('Greet', { content: 'hello' })],
    });
    await manager.init([{ path: '/r', source: 'user' }]);
    const contextState = makeContext();
    await manager.activate('GREET', '', { contextState });
    expect(contextState.buildMessages()).toHaveLength(1);
  });

  // ── Slice 7.1 (决策 #99) — user-slash invocation_trigger record ─────

  it('writes a skill_invoked record with invocation_trigger=user-slash when sessionJournal is supplied (M-3)', async () => {
    const manager = new DefaultSkillManager({
      discover: async () => [mkDef('commit', { content: 'commit body' })],
    });
    await manager.init([{ path: '/r', source: 'user' }]);
    const contextState = makeContext();
    const sessionJournal = new InMemorySessionJournalImpl();
    await manager.activate('commit', 'message text', {
      contextState,
      sessionJournal,
      turnId: 't_42',
    });
    const records = sessionJournal.getRecordsByType('skill_invoked');
    expect(records).toHaveLength(1);
    expect(records[0]?.data.skill_name).toBe('commit');
    expect(records[0]?.data.execution_mode).toBe('inline');
    expect(records[0]?.data.original_input).toBe('message text');
    expect(records[0]?.data.invocation_trigger).toBe('user-slash');
    expect(records[0]?.turn_id).toBe('t_42');
  });

  it('skips the skill_invoked record when sessionJournal is omitted (legacy callers)', async () => {
    const manager = new DefaultSkillManager({
      discover: async () => [mkDef('commit')],
    });
    await manager.init([{ path: '/r', source: 'user' }]);
    const contextState = makeContext();
    // Should not throw without sessionJournal.
    await expect(manager.activate('commit', '', { contextState })).resolves.toBeUndefined();
  });
});

describe('DefaultSkillManager.getKimiSkillsDescription', () => {
  it('formats each skill as three markdown lines', async () => {
    const manager = new DefaultSkillManager({
      discover: async () => [
        mkDef('commit', { path: '/skills/commit/SKILL.md' }),
        mkDef('release', {
          path: '/skills/release/SKILL.md',
          description: 'Cut a release',
        }),
      ],
    });
    await manager.init([{ path: '/r', source: 'user' }]);
    const text = manager.getKimiSkillsDescription();
    expect(text).toBe(
      [
        '- commit',
        '  - Path: /skills/commit/SKILL.md',
        '  - Description: desc for commit',
        '- release',
        '  - Path: /skills/release/SKILL.md',
        '  - Description: Cut a release',
      ].join('\n'),
    );
  });

  it('returns an empty string when there are no skills', async () => {
    const manager = new DefaultSkillManager({ discover: async () => [] });
    await manager.init([]);
    expect(manager.getKimiSkillsDescription()).toBe('');
  });
});

// ── Slice 7.1 — listInvocableSkills + injectSkillListing ────────────────

interface InvocableApi {
  listInvocableSkills(): readonly SkillDefinition[];
  injectSkillListing(contextState: FullContextState): Promise<void>;
}
function asInvocable(m: DefaultSkillManager): InvocableApi {
  return m as unknown as InvocableApi;
}

describe('DefaultSkillManager.listInvocableSkills (Slice 7.1)', () => {
  it('returns every registered skill when none opts out', async () => {
    const manager = new DefaultSkillManager({
      discover: async () => [mkDef('commit'), mkDef('release')],
    });
    await manager.init([{ path: '/r', source: 'user' }]);
    const names = asInvocable(manager)
      .listInvocableSkills()
      .map((s) => s.name);
    expect(names).toEqual(['commit', 'release']);
  });

  it('excludes skills flagged disableModelInvocation: true', async () => {
    const manager = new DefaultSkillManager({
      discover: async () => [
        mkDef('commit'),
        mkDef('forbidden', { metadata: { disableModelInvocation: true } }),
        mkDef('release'),
      ],
    });
    await manager.init([{ path: '/r', source: 'user' }]);
    const names = asInvocable(manager)
      .listInvocableSkills()
      .map((s) => s.name);
    expect(names).toEqual(['commit', 'release']);
  });
});

describe('DefaultSkillManager.injectSkillListing (Slice 7.1)', () => {
  it('writes a durable system reminder with the invocable-skill listing', async () => {
    const manager = new DefaultSkillManager({
      discover: async () => [
        mkDef('commit', {
          path: '/skills/commit/SKILL.md',
          description: 'Write a commit message for staged changes',
          metadata: { whenToUse: 'when the user has staged changes and asks to commit' },
        }),
        mkDef('release', {
          path: '/skills/release/SKILL.md',
          description: 'Cut a release',
          metadata: {},
        }),
      ],
    });
    await manager.init([{ path: '/r', source: 'user' }]);
    const contextState = makeContext();

    await asInvocable(manager).injectSkillListing(contextState);

    // One durable user message holding the <system-reminder>...</system-reminder> XML.
    const history = contextState.getHistory();
    expect(history).toHaveLength(1);
    const text = (history[0]?.content ?? [])
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');
    expect(text).toContain('<system-reminder>');
    expect(text).toContain('DISREGARD any earlier skill listings');
    expect(text).toContain('Current available skills:');
    expect(text).toContain('- commit: Write a commit message for staged changes');
    expect(text).toContain('When to use: when the user has staged changes and asks to commit');
    expect(text).toContain('Path: /skills/commit/SKILL.md');
    expect(text).toContain('- release: Cut a release');
  });

  it('is a no-op when there are no invocable skills', async () => {
    const manager = new DefaultSkillManager({ discover: async () => [] });
    await manager.init([]);
    const contextState = makeContext();
    await asInvocable(manager).injectSkillListing(contextState);
    expect(contextState.getHistory()).toHaveLength(0);
  });

  it('skips skills flagged disableModelInvocation in the listing', async () => {
    const manager = new DefaultSkillManager({
      discover: async () => [
        mkDef('public-one', { description: 'public' }),
        mkDef('secret', {
          description: 'human-only',
          metadata: { disableModelInvocation: true },
        }),
      ],
    });
    await manager.init([{ path: '/r', source: 'user' }]);
    const contextState = makeContext();
    await asInvocable(manager).injectSkillListing(contextState);
    const history = contextState.getHistory();
    const text = (history[0]?.content ?? [])
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');
    expect(text).toContain('public-one');
    expect(text).not.toContain('secret');
  });

  it('truncates description to 250 chars in the listing', async () => {
    const longDesc = 'A'.repeat(500);
    const manager = new DefaultSkillManager({
      discover: async () => [mkDef('verbose', { description: longDesc })],
    });
    await manager.init([{ path: '/r', source: 'user' }]);
    const contextState = makeContext();
    await asInvocable(manager).injectSkillListing(contextState);
    const text = (contextState.getHistory()[0]?.content ?? [])
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');
    // Should contain exactly 250 A's but not 251.
    expect(text).toContain('A'.repeat(250));
    expect(text).not.toContain('A'.repeat(251));
  });
});

describe('DefaultSkillManager.registerBuiltinSkill', () => {
  it('allows host code to register a builtin skill', async () => {
    const manager = new DefaultSkillManager({ discover: async () => [] });
    await manager.init([]);
    manager.registerBuiltinSkill(mkDef('host-skill', { source: 'user' }));
    const registered = manager.getSkill('host-skill');
    expect(registered?.source).toBe('builtin'); // normalised
  });

  it('filesystem-scanned skill wins over a host-registered one with the same name', async () => {
    const manager = new DefaultSkillManager({
      discover: async () => [mkDef('dupe', { content: 'from-fs' })],
    });
    manager.registerBuiltinSkill(mkDef('dupe', { content: 'from-host', source: 'builtin' }));
    await manager.init([{ path: '/r', source: 'user' }]);
    expect(manager.getSkill('dupe')?.content).toBe('from-fs');
  });

  it('host-registered skill is kept when no filesystem skill shadows it', async () => {
    const manager = new DefaultSkillManager({ discover: async () => [] });
    manager.registerBuiltinSkill(mkDef('hosted', { content: 'host-only' }));
    await manager.init([]);
    expect(manager.getSkill('hosted')?.content).toBe('host-only');
  });
});
