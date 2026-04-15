/**
 * Covers: checkRules — the core decision function (v2 §9-E.5).
 *
 * Pins:
 *   - deny > ask > allow priority across all modes
 *   - default posture (no rule match) → ask
 *   - bypassPermissions → allow for everything non-deny
 *   - bypassPermissions + matching deny rule → deny (deny still wins)
 *   - acceptEdits → Edit/Write default allow
 *   - acceptEdits + matching deny Edit/Write rule → deny (deny still wins)
 *   - acceptEdits does NOT relax other tools
 *   - function is a pure function (no `this`, no globals, no exceptions)
 */

import { describe, expect, it } from 'vitest';

import { checkRules } from '../../../src/soul-plus/permission/check-rules.js';
import type { PermissionMode, PermissionRule } from '../../../src/soul-plus/permission/types.js';

function rule(
  decision: PermissionRule['decision'],
  pattern: string,
  scope: PermissionRule['scope'] = 'turn-override',
): PermissionRule {
  return { decision, scope, pattern };
}

describe('checkRules — default mode', () => {
  const mode: PermissionMode = 'default';

  it('empty rule set → ask', () => {
    expect(checkRules([], 'Write', { path: '/tmp/a' }, mode)).toBe('ask');
  });

  it('matching allow rule → allow', () => {
    const rules = [rule('allow', 'Write')];
    expect(checkRules(rules, 'Write', { path: '/tmp/a' }, mode)).toBe('allow');
  });

  it('matching deny rule → deny', () => {
    const rules = [rule('deny', 'Write')];
    expect(checkRules(rules, 'Write', {}, mode)).toBe('deny');
  });

  it('matching ask rule → ask', () => {
    const rules = [rule('ask', 'Write')];
    expect(checkRules(rules, 'Write', {}, mode)).toBe('ask');
  });

  it('deny beats allow regardless of order', () => {
    const rulesA = [rule('allow', 'Write'), rule('deny', 'Write')];
    const rulesB = [rule('deny', 'Write'), rule('allow', 'Write')];
    expect(checkRules(rulesA, 'Write', {}, mode)).toBe('deny');
    expect(checkRules(rulesB, 'Write', {}, mode)).toBe('deny');
  });

  it('ask beats allow regardless of order', () => {
    const rulesA = [rule('allow', 'Write'), rule('ask', 'Write')];
    const rulesB = [rule('ask', 'Write'), rule('allow', 'Write')];
    expect(checkRules(rulesA, 'Write', {}, mode)).toBe('ask');
    expect(checkRules(rulesB, 'Write', {}, mode)).toBe('ask');
  });

  it('non-matching rule set → ask (default fallthrough)', () => {
    const rules = [rule('allow', 'Read')];
    expect(checkRules(rules, 'Write', {}, mode)).toBe('ask');
  });

  it('Bash(git *) allow matches git status', () => {
    const rules = [rule('allow', 'Bash(git *)')];
    expect(checkRules(rules, 'Bash', { command: 'git status' }, mode)).toBe('allow');
    expect(checkRules(rules, 'Bash', { command: 'rm -rf /' }, mode)).toBe('ask');
  });
});

describe('checkRules — bypassPermissions mode', () => {
  const mode: PermissionMode = 'bypassPermissions';

  it('empty rules → allow', () => {
    expect(checkRules([], 'Write', {}, mode)).toBe('allow');
  });

  it('matching deny still denies', () => {
    const rules = [rule('deny', 'Write')];
    expect(checkRules(rules, 'Write', {}, mode)).toBe('deny');
  });

  it('non-deny rules ignored', () => {
    const rules = [rule('ask', 'Write')];
    expect(checkRules(rules, 'Write', {}, mode)).toBe('allow');
  });

  it('Bash(rm **) deny still fires under bypassPermissions', () => {
    // Use `**` to cross slashes — command strings may contain `/`
    // (e.g. `rm -rf /tmp/x`) and segment-bound `*` would miss them.
    const rules = [rule('deny', 'Bash(rm **)')];
    expect(checkRules(rules, 'Bash', { command: 'rm -rf /' }, mode)).toBe('deny');
    expect(checkRules(rules, 'Bash', { command: 'git status' }, mode)).toBe('allow');
  });
});

describe('checkRules — acceptEdits mode', () => {
  const mode: PermissionMode = 'acceptEdits';

  it('Edit default allow', () => {
    expect(checkRules([], 'Edit', { path: '/tmp/a' }, mode)).toBe('allow');
  });

  it('Write default allow', () => {
    expect(checkRules([], 'Write', { path: '/tmp/a' }, mode)).toBe('allow');
  });

  it('non-Edit/Write tools fall through to default rule walk', () => {
    expect(checkRules([], 'Bash', { command: 'ls' }, mode)).toBe('ask');
  });

  it('Edit deny rule still wins over mode allow', () => {
    const rules = [rule('deny', 'Edit(/etc/**)')];
    expect(checkRules(rules, 'Edit', { path: '/etc/passwd' }, mode)).toBe('deny');
    expect(checkRules(rules, 'Edit', { path: '/tmp/a' }, mode)).toBe('allow');
  });

  it('Write deny rule still wins', () => {
    const rules = [rule('deny', 'Write(/etc/**)')];
    expect(checkRules(rules, 'Write', { path: '/etc/shadow' }, mode)).toBe('deny');
  });

  it('does not short-circuit Bash ask', () => {
    const rules = [rule('ask', 'Bash')];
    expect(checkRules(rules, 'Bash', { command: 'ls' }, mode)).toBe('ask');
  });
});

describe('checkRules — purity guarantees', () => {
  it('does not mutate the rules array', () => {
    const rules = [rule('allow', 'Read')];
    const snapshot = JSON.stringify(rules);
    checkRules(rules, 'Read', { path: '/tmp' }, 'default');
    expect(JSON.stringify(rules)).toBe(snapshot);
  });

  it('does not throw on malformed rule pattern', () => {
    const rules: PermissionRule[] = [
      { decision: 'deny', scope: 'turn-override', pattern: 'Bad(unclosed' },
    ];
    // malformed → never matches → fallthrough to "ask"
    expect(() => checkRules(rules, 'Bad', {}, 'default')).not.toThrow();
    expect(checkRules(rules, 'Bad', {}, 'default')).toBe('ask');
  });

  it('same input same output', () => {
    const rules = [rule('allow', 'Write')];
    const a = checkRules(rules, 'Write', { path: '/x' }, 'default');
    const b = checkRules(rules, 'Write', { path: '/x' }, 'default');
    expect(a).toBe(b);
  });
});
