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
