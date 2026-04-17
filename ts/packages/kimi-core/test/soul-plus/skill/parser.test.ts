/**
 * SKILL.md parser — Slice 2.5 unit tests.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SkillParseError,
  UnsupportedSkillTypeError,
  parseSkillFromFile,
} from '../../../src/soul-plus/skill/parser.js';

describe('parseSkillFromFile', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kimi-skill-parser-'));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writeSkill(name: string, contents: string): Promise<string> {
    const dir = path.join(tmpDir, name);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'SKILL.md');
    await writeFile(file, contents, 'utf8');
    return file;
  }

  it('parses name + description + body from a well-formed SKILL.md', async () => {
    const file = await writeSkill(
      'commit',
      [
        '---',
        'name: commit',
        'description: write a commit message',
        '---',
        '',
        'Do the work.',
      ].join('\n'),
    );
    const def = await parseSkillFromFile({
      skillMdPath: file,
      skillDirName: 'commit',
      source: 'user',
    });
    expect(def.name).toBe('commit');
    expect(def.description).toBe('write a commit message');
    expect(def.content).toBe('Do the work.');
    expect(def.source).toBe('user');
    expect(def.path).toBe(path.resolve(file));
  });

  it('falls back to directory name when name is missing', async () => {
    const file = await writeSkill(
      'release',
      ['---', 'description: release helper', '---', 'body'].join('\n'),
    );
    const def = await parseSkillFromFile({
      skillMdPath: file,
      skillDirName: 'release',
      source: 'user',
    });
    expect(def.name).toBe('release');
  });

  it('falls back to a default description when frontmatter omits it', async () => {
    const file = await writeSkill('orphan', ['---', 'name: orphan', '---', 'body'].join('\n'));
    const def = await parseSkillFromFile({
      skillMdPath: file,
      skillDirName: 'orphan',
      source: 'user',
    });
    expect(def.description).toBe('No description provided.');
  });

  it('accepts missing frontmatter entirely (uses dir name + default description)', async () => {
    const file = await writeSkill('bare', 'just body text without frontmatter');
    const def = await parseSkillFromFile({
      skillMdPath: file,
      skillDirName: 'bare',
      source: 'project',
    });
    expect(def.name).toBe('bare');
    expect(def.description).toBe('No description provided.');
    expect(def.content).toBe('just body text without frontmatter');
  });

  it('maps kebab-case allowed-tools → camelCase allowedTools', async () => {
    const file = await writeSkill(
      'with-tools',
      ['---', 'name: with-tools', 'allowed-tools: [Bash, Read]', '---', 'body'].join('\n'),
    );
    const def = await parseSkillFromFile({
      skillMdPath: file,
      skillDirName: 'with-tools',
      source: 'user',
    });
    expect(def.metadata.allowedTools).toEqual(['Bash', 'Read']);
  });

  it('also accepts snake_case allowed_tools', async () => {
    const file = await writeSkill(
      'snake-tools',
      ['---', 'name: snake-tools', 'allowed_tools: [Grep]', '---', 'body'].join('\n'),
    );
    const def = await parseSkillFromFile({
      skillMdPath: file,
      skillDirName: 'snake-tools',
      source: 'user',
    });
    expect(def.metadata.allowedTools).toEqual(['Grep']);
  });

  it('preserves unknown frontmatter fields without rejecting the skill', async () => {
    const file = await writeSkill(
      'exotic',
      [
        '---',
        'name: exotic',
        'description: has mystery fields',
        'author: alice',
        'version: 2',
        '---',
        'body',
      ].join('\n'),
    );
    const def = await parseSkillFromFile({
      skillMdPath: file,
      skillDirName: 'exotic',
      source: 'user',
    });
    expect(def.metadata['author']).toBe('alice');
    expect(def.metadata['version']).toBe(2);
  });

  it('throws UnsupportedSkillTypeError on type: flow', async () => {
    const file = await writeSkill(
      'flow-thing',
      ['---', 'name: flow-thing', 'type: flow', '---', 'body'].join('\n'),
    );
    await expect(
      parseSkillFromFile({
        skillMdPath: file,
        skillDirName: 'flow-thing',
        source: 'user',
      }),
    ).rejects.toBeInstanceOf(UnsupportedSkillTypeError);
  });

  it('accepts type: prompt and type: standard as equivalent', async () => {
    const f1 = await writeSkill(
      'a',
      ['---', 'name: a', 'type: prompt', '---', 'body-a'].join('\n'),
    );
    const f2 = await writeSkill(
      'b',
      ['---', 'name: b', 'type: standard', '---', 'body-b'].join('\n'),
    );
    const d1 = await parseSkillFromFile({ skillMdPath: f1, skillDirName: 'a', source: 'user' });
    const d2 = await parseSkillFromFile({ skillMdPath: f2, skillDirName: 'b', source: 'user' });
    expect(d1.name).toBe('a');
    expect(d2.name).toBe('b');
  });

  it('wraps frontmatter parse errors in SkillParseError', async () => {
    const file = await writeSkill('bad', ['---', 'name: "unterminated', '---', 'body'].join('\n'));
    await expect(
      parseSkillFromFile({ skillMdPath: file, skillDirName: 'bad', source: 'user' }),
    ).rejects.toBeInstanceOf(SkillParseError);
  });

  // ── Slice 7.1 — SkillMetadata extension (whenToUse / disableModelInvocation / safe) ──

  it('parses `when-to-use` frontmatter into metadata.whenToUse (kebab→camel)', async () => {
    const file = await writeSkill(
      'with-when',
      [
        '---',
        'name: with-when',
        'description: a scoped skill',
        'when-to-use: "when the user asks to ship a release"',
        '---',
        'body',
      ].join('\n'),
    );
    const def = await parseSkillFromFile({
      skillMdPath: file,
      skillDirName: 'with-when',
      source: 'user',
    });
    expect(def.metadata['whenToUse']).toBe('when the user asks to ship a release');
  });

  it('accepts `whenToUse` in camelCase directly', async () => {
    const file = await writeSkill(
      'camel-when',
      ['---', 'name: camel-when', 'whenToUse: on demand', '---', 'body'].join('\n'),
    );
    const def = await parseSkillFromFile({
      skillMdPath: file,
      skillDirName: 'camel-when',
      source: 'user',
    });
    expect(def.metadata['whenToUse']).toBe('on demand');
  });

  it('parses `disable-model-invocation: true` into metadata.disableModelInvocation', async () => {
    const file = await writeSkill(
      'user-only',
      [
        '---',
        'name: user-only',
        'description: only the user may invoke this',
        'disable-model-invocation: true',
        '---',
        'body',
      ].join('\n'),
    );
    const def = await parseSkillFromFile({
      skillMdPath: file,
      skillDirName: 'user-only',
      source: 'user',
    });
    expect(def.metadata['disableModelInvocation']).toBe(true);
  });

  it('parses `safe: true` into metadata.safe (auto-approve opt-in)', async () => {
    const file = await writeSkill(
      'trusted',
      ['---', 'name: trusted', 'safe: true', '---', 'body'].join('\n'),
    );
    const def = await parseSkillFromFile({
      skillMdPath: file,
      skillDirName: 'trusted',
      source: 'user',
    });
    expect(def.metadata['safe']).toBe(true);
  });

  it('leaves whenToUse / disableModelInvocation / safe undefined when omitted', async () => {
    const file = await writeSkill(
      'plain',
      ['---', 'name: plain', '---', 'body'].join('\n'),
    );
    const def = await parseSkillFromFile({
      skillMdPath: file,
      skillDirName: 'plain',
      source: 'user',
    });
    expect(def.metadata['whenToUse']).toBeUndefined();
    expect(def.metadata['disableModelInvocation']).toBeUndefined();
    expect(def.metadata['safe']).toBeUndefined();
  });
});
