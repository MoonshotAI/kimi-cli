/**
 * Inheritance chain tests — Slice 3.1.
 */

import { describe, expect, it } from 'vitest';

import { AgentInheritanceCycleError } from '../../src/agent/errors.js';
import { resolveInheritance } from '../../src/agent/inherit.js';
import type { AgentSpec } from '../../src/agent/types.js';

const parentSpec: AgentSpec = {
  name: 'parent',
  description: 'Parent agent',
  systemPrompt: 'Parent prompt',
  model: 'k25',
  thinkingMode: 'auto',
  tools: { include: ['shell', 'read_file'] },
};

const childSpec: AgentSpec = {
  name: 'child',
  description: 'Child agent',
  model: 'gpt-4',
  inherits: 'parent',
};

function makeLookup(specs: AgentSpec[]): (name: string) => AgentSpec | undefined {
  const map = new Map(specs.map((s) => [s.name, s]));
  return (name: string) => map.get(name);
}

describe('resolveInheritance', () => {
  it('returns spec unchanged when no inherits', () => {
    const spec: AgentSpec = { name: 'standalone', description: 'alone' };
    const result = resolveInheritance(spec, () => {});
    expect(result).toEqual(spec);
  });

  it('child overrides parent fields', () => {
    const lookup = makeLookup([parentSpec]);
    const result = resolveInheritance(childSpec, lookup);

    expect(result.name).toBe('child');
    expect(result.description).toBe('Child agent');
    expect(result.model).toBe('gpt-4');
    expect(result.inherits).toBeUndefined();
  });

  it('child inherits undefined fields from parent', () => {
    const lookup = makeLookup([parentSpec]);
    const result = resolveInheritance(childSpec, lookup);

    expect(result.systemPrompt).toBe('Parent prompt');
    expect(result.thinkingMode).toBe('auto');
    expect(result.tools).toEqual({ include: ['shell', 'read_file'] });
  });

  it('child tools filter completely replaces parent filter', () => {
    const child: AgentSpec = {
      name: 'child',
      tools: { exclude: ['rm_rf'] },
      inherits: 'parent',
    };
    const lookup = makeLookup([parentSpec]);
    const result = resolveInheritance(child, lookup);

    expect(result.tools).toEqual({ exclude: ['rm_rf'] });
  });

  it('resolves multi-level inheritance (grandparent → parent → child)', () => {
    const grandparent: AgentSpec = {
      name: 'grandparent',
      description: 'GP',
      systemPrompt: 'GP prompt',
      model: 'base-model',
    };
    const parent: AgentSpec = {
      name: 'parent',
      model: 'mid-model',
      inherits: 'grandparent',
    };
    const child: AgentSpec = {
      name: 'child',
      description: 'final',
      inherits: 'parent',
    };
    const lookup = makeLookup([grandparent, parent]);
    const result = resolveInheritance(child, lookup);

    expect(result.name).toBe('child');
    expect(result.description).toBe('final');
    expect(result.systemPrompt).toBe('GP prompt');
    expect(result.model).toBe('mid-model');
  });

  it('detects direct cycle (A → B → A)', () => {
    const a: AgentSpec = { name: 'a', inherits: 'b' };
    const b: AgentSpec = { name: 'b', inherits: 'a' };
    const lookup = makeLookup([a, b]);

    expect(() => resolveInheritance(a, lookup)).toThrow(AgentInheritanceCycleError);
  });

  it('detects longer cycle (A → B → C → A)', () => {
    const a: AgentSpec = { name: 'a', inherits: 'b' };
    const b: AgentSpec = { name: 'b', inherits: 'c' };
    const c: AgentSpec = { name: 'c', inherits: 'a' };
    const lookup = makeLookup([a, b, c]);

    expect(() => resolveInheritance(a, lookup)).toThrow(AgentInheritanceCycleError);
  });

  it('cycle error contains the chain', () => {
    const a: AgentSpec = { name: 'a', inherits: 'b' };
    const b: AgentSpec = { name: 'b', inherits: 'a' };
    const lookup = makeLookup([a, b]);

    try {
      resolveInheritance(a, lookup);
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AgentInheritanceCycleError);
      expect((error as AgentInheritanceCycleError).chain).toContain('a');
      expect((error as AgentInheritanceCycleError).chain).toContain('b');
    }
  });

  // ── M1 regression: systemPromptPath override ─────────────────────

  it('child systemPromptPath clears parent inline systemPrompt', () => {
    const parent: AgentSpec = {
      name: 'parent',
      systemPrompt: 'Parent inline prompt',
    };
    const child: AgentSpec = {
      name: 'child',
      systemPromptPath: '/agents/child/system.md',
      inherits: 'parent',
    };
    const lookup = makeLookup([parent]);
    const result = resolveInheritance(child, lookup);

    expect(result.systemPromptPath).toBe('/agents/child/system.md');
    expect(result.systemPrompt).toBeUndefined();
  });

  it('child inline systemPrompt clears parent systemPromptPath', () => {
    const parent: AgentSpec = {
      name: 'parent',
      systemPromptPath: '/agents/parent/system.md',
    };
    const child: AgentSpec = {
      name: 'child',
      systemPrompt: 'Child inline prompt',
      inherits: 'parent',
    };
    const lookup = makeLookup([parent]);
    const result = resolveInheritance(child, lookup);

    expect(result.systemPrompt).toBe('Child inline prompt');
    expect(result.systemPromptPath).toBeUndefined();
  });

  it('both prompt sources from parent survive when child defines neither', () => {
    const parent: AgentSpec = {
      name: 'parent',
      systemPrompt: 'inline',
      systemPromptPath: '/path',
    };
    const child: AgentSpec = {
      name: 'child',
      inherits: 'parent',
    };
    const lookup = makeLookup([parent]);
    const result = resolveInheritance(child, lookup);

    // Parent had both (unusual but valid) — child didn't touch either, preserve as-is
    expect(result.systemPrompt).toBe('inline');
    expect(result.systemPromptPath).toBe('/path');
  });

  it('handles missing parent gracefully (clears inherits)', () => {
    const spec: AgentSpec = { name: 'orphan', inherits: 'nonexistent' };
    const result = resolveInheritance(spec, () => {});

    expect(result.name).toBe('orphan');
    expect(result.inherits).toBeUndefined();
  });
});
