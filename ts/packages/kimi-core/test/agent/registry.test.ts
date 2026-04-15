/**
 * AgentRegistry tests — Slice 3.1.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentNotFoundError } from '../../src/agent/errors.js';
import { AgentRegistry } from '../../src/agent/registry.js';
import type { AgentSpec } from '../../src/agent/types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(
    tmpdir(),
    `kimi-registry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('AgentRegistry', () => {
  it('has built-in default agent on construction', () => {
    const registry = new AgentRegistry();
    const def = registry.get('default');
    expect(def).toBeDefined();
    expect(def!.name).toBe('default');
  });

  it('registers and retrieves an agent', () => {
    const registry = new AgentRegistry();
    const spec: AgentSpec = { name: 'custom', description: 'Custom agent' };
    registry.register(spec);

    expect(registry.get('custom')).toEqual(spec);
  });

  it('overwrites existing agent on re-register', () => {
    const registry = new AgentRegistry();
    registry.register({ name: 'a', description: 'v1' });
    registry.register({ name: 'a', description: 'v2' });

    expect(registry.get('a')!.description).toBe('v2');
  });

  it('lists all agents', () => {
    const registry = new AgentRegistry();
    registry.register({ name: 'extra', description: 'extra' });

    const names = registry.listAgents().map((a) => a.name);
    expect(names).toContain('default');
    expect(names).toContain('extra');
  });

  it('resolve returns resolved agent with inheritance', () => {
    const registry = new AgentRegistry();
    const child: AgentSpec = {
      name: 'child',
      description: 'Child',
      inherits: 'default',
      model: 'custom-model',
    };
    registry.register(child);

    const resolved = registry.resolve('child');
    expect(resolved.name).toBe('child');
    expect(resolved.model).toBe('custom-model');
    // Inherited from default
    expect(resolved.systemPrompt).toBeDefined();
    expect(resolved.inherits).toBeUndefined();
  });

  it('resolve throws AgentNotFoundError for unknown agent', () => {
    const registry = new AgentRegistry();
    expect(() => registry.resolve('nonexistent')).toThrow(AgentNotFoundError);
  });

  it('scans directory for agent files', () => {
    // Create agent dirs
    const agentDir = join(tmpDir, 'my-agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'agent.yaml'), 'name: my-agent\ndescription: scanned', 'utf-8');

    const registry = new AgentRegistry();
    registry.scanDirectory(tmpDir);

    const agent = registry.get('my-agent');
    expect(agent).toBeDefined();
    expect(agent!.description).toBe('scanned');
  });

  it('scanDirectory skips invalid agent files with warning', () => {
    const agentDir = join(tmpDir, 'bad-agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'agent.yaml'), '  invalid: yaml', 'utf-8');

    const warnings: string[] = [];
    const registry = new AgentRegistry();
    registry.scanDirectory(tmpDir, (msg) => warnings.push(msg));

    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('bad-agent');
  });

  it('scanDirectory handles nonexistent directory gracefully', () => {
    const registry = new AgentRegistry();
    // Should not throw
    expect(() => registry.scanDirectory(join(tmpDir, 'nonexistent'))).not.toThrow();
  });
});
