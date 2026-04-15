/**
 * Covers: matchesRule (v2 §9-E.3.1 / §9-E.5).
 *
 * Pins:
 *   - bare tool name → name-only match
 *   - `*` matches all tools
 *   - tool-specific field convention (Bash/command, Read/path, Task/subagent_type, …)
 *   - negation prefix flips the field match
 *   - unknown tool + argPattern never matches
 *   - malformed pattern returns false (no throw — matcher stays total)
 */

import { describe, expect, it } from 'vitest';

import { matchesRule } from '../../../src/soul-plus/permission/matches-rule.js';
import type { PermissionRule } from '../../../src/soul-plus/permission/types.js';

function rule(pattern: string, decision: 'allow' | 'deny' | 'ask' = 'allow'): PermissionRule {
  return { decision, scope: 'turn-override', pattern };
}

describe('matchesRule', () => {
  it('bare tool name matches any args', () => {
    expect(matchesRule(rule('Write'), 'Write', { path: '/tmp/a' })).toBe(true);
    expect(matchesRule(rule('Write'), 'Read', { path: '/tmp/a' })).toBe(false);
  });

  it('wildcard * matches every tool', () => {
    expect(matchesRule(rule('*'), 'AnyTool', {})).toBe(true);
  });

  it('Read(/etc/**) matches paths under /etc', () => {
    const r = rule('Read(/etc/**)');
    expect(matchesRule(r, 'Read', { path: '/etc/passwd' })).toBe(true);
    expect(matchesRule(r, 'Read', { path: '/etc/ssl/certs/x.pem' })).toBe(true);
    expect(matchesRule(r, 'Read', { path: '/home/user/file' })).toBe(false);
  });

  it('Bash(git *) matches git commands', () => {
    const r = rule('Bash(git *)');
    expect(matchesRule(r, 'Bash', { command: 'git status' })).toBe(true);
    expect(matchesRule(r, 'Bash', { command: 'git log --oneline' })).toBe(true);
    expect(matchesRule(r, 'Bash', { command: 'npm test' })).toBe(false);
  });

  it('Edit(!./src/**) negation — matches paths outside src/', () => {
    const r = rule('Edit(!./src/**)', 'deny');
    expect(matchesRule(r, 'Edit', { path: './tests/foo.ts' })).toBe(true);
    expect(matchesRule(r, 'Edit', { path: './src/foo.ts' })).toBe(false);
  });

  it('Task(review-*) matches subagent_type field', () => {
    const r = rule('Task(review-*)');
    expect(matchesRule(r, 'Task', { subagent_type: 'review-code' })).toBe(true);
    expect(matchesRule(r, 'Task', { subagent_type: 'code-architect' })).toBe(false);
  });

  it('Grep(.*) matches Grep tool pattern field', () => {
    const r = rule('Grep(secret*)');
    expect(matchesRule(r, 'Grep', { pattern: 'secret_key' })).toBe(true);
    expect(matchesRule(r, 'Grep', { pattern: 'hello' })).toBe(false);
  });

  it('rule with argPattern on unknown tool never matches', () => {
    const r = rule('CustomTool(foo*)');
    // No field convention for CustomTool → extracted field is undefined → no match
    expect(matchesRule(r, 'CustomTool', { arbitrary: 'foo1' })).toBe(false);
  });

  it('bare rule on unknown tool still matches by name', () => {
    const r = rule('CustomTool');
    expect(matchesRule(r, 'CustomTool', { anything: 42 })).toBe(true);
  });

  it('malformed pattern (missing close paren) never throws, returns false', () => {
    const r = rule('Read(/etc/**');
    expect(matchesRule(r, 'Read', { path: '/etc/passwd' })).toBe(false);
  });

  it('mcp__github__* matches github mcp tools', () => {
    const r = rule('mcp__github__*');
    expect(matchesRule(r, 'mcp__github__list_issues', {})).toBe(true);
    expect(matchesRule(r, 'mcp__slack__send', {})).toBe(false);
  });

  it('non-string arg field → rule misses', () => {
    const r = rule('Bash(git *)');
    expect(matchesRule(r, 'Bash', { command: 42 })).toBe(false);
    expect(matchesRule(r, 'Bash', null)).toBe(false);
  });
});
