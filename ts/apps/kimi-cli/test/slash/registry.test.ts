/**
 * SlashCommandRegistry unit tests.
 */

import { describe, it, expect } from 'vitest';

import {
  SlashCommandRegistry,
  parseSlashInput,
} from '../../src/slash/registry.js';
import type { SlashCommandDef } from '../../src/slash/registry.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makeDef(name: string, aliases: string[] = [], mode: 'agent' | 'shell' | 'both' = 'both'): SlashCommandDef {
  return {
    name,
    aliases,
    description: `${name} command`,
    mode,
    async execute() {
      return { type: 'ok', message: name };
    },
  };
}

// ── Registry tests ──────────────────────────────────────────────────

describe('SlashCommandRegistry', () => {
  it('registers and finds a command by name', () => {
    const reg = new SlashCommandRegistry();
    reg.register(makeDef('exit', ['quit']));
    expect(reg.find('exit')?.name).toBe('exit');
  });

  it('finds a command by alias', () => {
    const reg = new SlashCommandRegistry();
    reg.register(makeDef('exit', ['quit', 'q']));
    expect(reg.find('quit')?.name).toBe('exit');
    expect(reg.find('q')?.name).toBe('exit');
  });

  it('returns null for unknown command', () => {
    const reg = new SlashCommandRegistry();
    reg.register(makeDef('exit'));
    expect(reg.find('unknown')).toBeNull();
  });

  it('search returns commands matching prefix', () => {
    const reg = new SlashCommandRegistry();
    reg.register(makeDef('help', ['h']));
    reg.register(makeDef('history'));
    reg.register(makeDef('exit'));

    const results = reg.search('h');
    expect(results.map((r) => r.name)).toEqual(['help', 'history']);
  });

  it('search returns empty array for no match', () => {
    const reg = new SlashCommandRegistry();
    reg.register(makeDef('exit'));
    expect(reg.search('z')).toEqual([]);
  });

  it('search matches via alias prefix', () => {
    const reg = new SlashCommandRegistry();
    reg.register(makeDef('exit', ['quit']));
    const results = reg.search('qu');
    expect(results.map((r) => r.name)).toEqual(['exit']);
  });

  it('search does not return duplicates when name and alias both match', () => {
    const reg = new SlashCommandRegistry();
    reg.register(makeDef('help', ['he']));
    const results = reg.search('he');
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('help');
  });

  it('listAll returns all commands sorted by name', () => {
    const reg = new SlashCommandRegistry();
    reg.register(makeDef('zebra'));
    reg.register(makeDef('alpha'));
    reg.register(makeDef('mid'));
    const all = reg.listAll();
    expect(all.map((c) => c.name)).toEqual(['alpha', 'mid', 'zebra']);
  });

  it('listAll filters by mode', () => {
    const reg = new SlashCommandRegistry();
    reg.register(makeDef('agent-only', [], 'agent'));
    reg.register(makeDef('shell-only', [], 'shell'));
    reg.register(makeDef('both-cmd', [], 'both'));

    const agentCmds = reg.listAll('agent');
    expect(agentCmds.map((c) => c.name)).toEqual(['agent-only', 'both-cmd']);

    const shellCmds = reg.listAll('shell');
    expect(shellCmds.map((c) => c.name)).toEqual(['both-cmd', 'shell-only']);
  });

  it('size reflects number of unique commands', () => {
    const reg = new SlashCommandRegistry();
    reg.register(makeDef('exit', ['quit', 'q']));
    reg.register(makeDef('help'));
    expect(reg.size).toBe(2);
  });
});

// ── parseSlashInput tests ───────────────────────────────────────────

describe('parseSlashInput', () => {
  it('parses a simple command', () => {
    expect(parseSlashInput('/help')).toEqual({ name: 'help', args: '' });
  });

  it('parses command with args', () => {
    expect(parseSlashInput('/model gpt-4')).toEqual({ name: 'model', args: 'gpt-4' });
  });

  it('parses command with multi-word args', () => {
    expect(parseSlashInput('/title My Session Title')).toEqual({
      name: 'title',
      args: 'My Session Title',
    });
  });

  it('returns null for non-slash input', () => {
    expect(parseSlashInput('hello')).toBeNull();
  });

  it('returns null for empty slash', () => {
    expect(parseSlashInput('/')).toBeNull();
  });

  it('returns null for slash with only spaces', () => {
    expect(parseSlashInput('/   ')).toBeNull();
  });

  it('trims whitespace around args', () => {
    expect(parseSlashInput('/yolo   on  ')).toEqual({ name: 'yolo', args: 'on' });
  });
});
