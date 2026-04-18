/**
 * Phase 21 §D.2 — slash → skill fallthrough.
 *
 * Unit-tests the pure `tryDispatchSkill` helper + the built-in-wins
 * rule by combining the helper with `createDefaultRegistry` (the
 * registry `.find()` lookup is what filters out skills whose name
 * shadows a real slash command).
 */

import { describe, expect, it, vi } from 'vitest';

import { createDefaultRegistry } from '../../src/slash/index.js';
import { tryDispatchSkill } from '../../src/slash/skill-dispatch.js';
import type { WireClient } from '../../src/wire/index.js';

function makeWire(overrides: Partial<WireClient>): WireClient {
  return overrides as WireClient;
}

describe('tryDispatchSkill', () => {
  it('activates a skill when listSkills reports the name', async () => {
    const listSkills = vi.fn(async () => ({
      skills: [{ name: 'unknown', description: 'a test skill' }],
    }));
    const activateSkill = vi.fn(async () => {});
    const wire = makeWire({ listSkills, activateSkill });

    const result = await tryDispatchSkill(wire, 'session-1', 'unknown', 'foo bar');

    expect(listSkills).toHaveBeenCalledWith('session-1');
    expect(activateSkill).toHaveBeenCalledWith('session-1', 'unknown', 'foo bar');
    expect(result).toEqual({ matched: true, message: 'Skill "unknown" activated.' });
  });

  it('falls through to "Unknown command" when listSkills is empty', async () => {
    const listSkills = vi.fn(async () => ({ skills: [] as never[] }));
    const activateSkill = vi.fn(async () => {});
    const wire = makeWire({ listSkills, activateSkill });

    const result = await tryDispatchSkill(wire, 'session-1', 'unknown', '');

    expect(activateSkill).not.toHaveBeenCalled();
    expect(result).toEqual({ matched: false, message: 'Unknown command: /unknown' });
  });

  it('degrades when the client does not implement listSkills', async () => {
    const wire = makeWire({});

    const result = await tryDispatchSkill(wire, 'session-1', 'unknown', '');

    expect(result).toEqual({ matched: false, message: 'Unknown command: /unknown' });
  });

  it('annotates the error when the listSkills call fails', async () => {
    const listSkills = vi.fn(async () => {
      throw new Error('transport dead');
    });
    const wire = makeWire({ listSkills, activateSkill: vi.fn() });

    const result = await tryDispatchSkill(wire, 'session-1', 'unknown', '');

    expect(result.matched).toBe(false);
    expect(result.message).toContain('skill lookup failed: transport dead');
  });
});

describe('slash → skill precedence', () => {
  it('built-in command wins over a skill of the same name', () => {
    // The dispatcher in `executeSlashCommand` first runs
    // `registry.find(name)` and only falls through to `tryDispatchSkill`
    // when that returns null. Assert the core of that ordering: `/help`
    // resolves to a registered built-in even if a skill of the same
    // name exists at the other end of the wire.
    const registry = createDefaultRegistry();
    const builtIn = registry.find('help');
    expect(builtIn?.name).toBe('help');
  });
});
