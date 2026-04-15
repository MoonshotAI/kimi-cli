/**
 * Tool / Skill filter tests — Slice 3.1.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { applyToolFilter, applySkillFilter } from '../../src/agent/filter.js';
import type { SkillDefinition } from '../../src/soul-plus/skill/types.js';
import type { Tool } from '../../src/soul/types.js';

// ── Helpers ─────────────────────────────────────────────────────────────

function makeTool(name: string): Tool {
  return {
    name,
    description: `Tool: ${name}`,
    inputSchema: z.object({}),
    execute: async () => ({ content: [] }),
  };
}

function makeSkill(name: string): SkillDefinition {
  return {
    name,
    description: `Skill: ${name}`,
    path: `/skills/${name}/SKILL.md`,
    content: '',
    metadata: {},
    source: 'builtin',
  };
}

const tools = [makeTool('shell'), makeTool('read_file'), makeTool('write_file'), makeTool('rm_rf')];
const skills = [makeSkill('commit'), makeSkill('review'), makeSkill('dangerous')];

// ── applyToolFilter ──────────────────────────────────────────────────

describe('applyToolFilter', () => {
  it('returns all tools when filter is undefined', () => {
    expect(applyToolFilter(tools)).toEqual(tools);
  });

  it('returns all tools when filter has no include/exclude', () => {
    expect(applyToolFilter(tools, {})).toEqual(tools);
  });

  it('filters to include-only list', () => {
    const result = applyToolFilter(tools, { include: ['shell', 'read_file'] });
    expect(result.map((t) => t.name)).toEqual(['shell', 'read_file']);
  });

  it('excludes from the list', () => {
    const result = applyToolFilter(tools, { exclude: ['rm_rf'] });
    expect(result.map((t) => t.name)).toEqual(['shell', 'read_file', 'write_file']);
  });

  it('applies include then exclude when both present', () => {
    const result = applyToolFilter(tools, {
      include: ['shell', 'read_file', 'rm_rf'],
      exclude: ['rm_rf'],
    });
    expect(result.map((t) => t.name)).toEqual(['shell', 'read_file']);
  });

  it('handles include with no matches', () => {
    const result = applyToolFilter(tools, { include: ['nonexistent'] });
    expect(result).toEqual([]);
  });

  it('handles exclude with no matches', () => {
    const result = applyToolFilter(tools, { exclude: ['nonexistent'] });
    expect(result).toEqual(tools);
  });
});

// ── applySkillFilter ─────────────────────────────────────────────────

describe('applySkillFilter', () => {
  it('returns all skills when filter is undefined', () => {
    expect(applySkillFilter(skills)).toEqual(skills);
  });

  it('filters to include-only list', () => {
    const result = applySkillFilter(skills, { include: ['commit'] });
    expect(result.map((s) => s.name)).toEqual(['commit']);
  });

  it('excludes from the list', () => {
    const result = applySkillFilter(skills, { exclude: ['dangerous'] });
    expect(result.map((s) => s.name)).toEqual(['commit', 'review']);
  });

  it('applies include then exclude', () => {
    const result = applySkillFilter(skills, {
      include: ['commit', 'dangerous'],
      exclude: ['dangerous'],
    });
    expect(result.map((s) => s.name)).toEqual(['commit']);
  });
});
