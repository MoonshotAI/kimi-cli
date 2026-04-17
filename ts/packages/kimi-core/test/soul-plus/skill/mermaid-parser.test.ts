/**
 * Phase 17 B.5 — SkillManager mermaid flowchart parsing.
 *
 * `src/soul-plus/skill/parser.ts::parseMermaidFlowchart(markdown)` is a
 * new helper introduced in Phase 17 B.5. It scans for a fenced
 * ` ```mermaid ... ``` ` block and returns the raw string (no AST
 * parsing — raw fidelity preserved for flow dispatch later).
 *
 * `SkillDefinition.mermaid?: string` is the new optional field that
 * `parseSkillFromFile` populates when the SKILL.md body contains a
 * mermaid block.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  parseSkillFromFile,
  parseMermaidFlowchart,
} from '../../../src/soul-plus/skill/parser.js';

describe('Phase 17 B.5 — parseMermaidFlowchart helper', () => {
  it('extracts raw mermaid block from markdown', () => {
    const md = [
      '# Skill',
      '',
      'some prose',
      '',
      '```mermaid',
      'flowchart TD',
      '  A --> B',
      '  B --> C',
      '```',
      '',
      'more prose',
    ].join('\n');
    const mermaid = parseMermaidFlowchart(md);
    expect(mermaid).toContain('flowchart TD');
    expect(mermaid).toContain('A --> B');
    expect(mermaid).toContain('B --> C');
    // Fence markers are NOT included in the returned string.
    expect(mermaid).not.toContain('```');
  });

  it('returns undefined when no mermaid block present', () => {
    const md = '# Skill\n\nno flow here';
    expect(parseMermaidFlowchart(md)).toBeUndefined();
  });
});

describe('Phase 17 B.5 — parseSkillFromFile populates mermaid field', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kimi-skill-mermaid-'));
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

  it('populates SkillDefinition.mermaid from the fenced mermaid block', async () => {
    const file = await writeSkill(
      'flow-example',
      [
        '---',
        'name: flow-example',
        'description: example flow',
        '---',
        '',
        'Use this flow:',
        '',
        '```mermaid',
        'flowchart TD',
        '  Start --> Check',
        '  Check -->|ok| Done',
        '  Check -->|fail| Retry',
        '  Retry --> Check',
        '```',
      ].join('\n'),
    );
    const def = await parseSkillFromFile({
      skillMdPath: file,
      skillDirName: 'flow-example',
      source: 'user',
    });
    expect(def.mermaid).toBeDefined();
    expect(def.mermaid).toContain('flowchart TD');
    expect(def.mermaid).toContain('Start --> Check');
  });

  it('leaves mermaid undefined when SKILL.md has no mermaid block', async () => {
    const file = await writeSkill(
      'plain',
      [
        '---',
        'name: plain',
        'description: plain skill',
        '---',
        '',
        'Just do the thing.',
      ].join('\n'),
    );
    const def = await parseSkillFromFile({
      skillMdPath: file,
      skillDirName: 'plain',
      source: 'user',
    });
    expect(def.mermaid).toBeUndefined();
  });
});
