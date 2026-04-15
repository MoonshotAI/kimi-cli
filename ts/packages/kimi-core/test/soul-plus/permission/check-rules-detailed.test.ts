/**
 * Covers: checkRulesDetailed (Slice 2.3) — returns matchedRule alongside
 * the decision so the closure can surface `rule.reason` in the block
 * reason (Slice 2.2 reviewer N2 remediation).
 */

import { describe, expect, it } from 'vitest';

import { checkRulesDetailed } from '../../../src/soul-plus/permission/check-rules.js';
import type { PermissionRule } from '../../../src/soul-plus/permission/types.js';

describe('checkRulesDetailed', () => {
  it('returns matchedRule for deny decisions', () => {
    const rule: PermissionRule = {
      decision: 'deny',
      scope: 'project',
      pattern: 'Write',
      reason: 'production filesystem is read-only',
    };
    const result = checkRulesDetailed([rule], 'Write', { path: '/etc/x' }, 'default');
    expect(result.decision).toBe('deny');
    expect(result.matchedRule?.reason).toBe('production filesystem is read-only');
  });

  it('returns matchedRule for ask decisions', () => {
    const rule: PermissionRule = {
      decision: 'ask',
      scope: 'user',
      pattern: 'Bash',
      reason: 'double-check every shell',
    };
    const result = checkRulesDetailed([rule], 'Bash', { command: 'ls' }, 'default');
    expect(result.decision).toBe('ask');
    expect(result.matchedRule?.reason).toBe('double-check every shell');
  });

  it('returns matchedRule for allow decisions', () => {
    const rule: PermissionRule = {
      decision: 'allow',
      scope: 'turn-override',
      pattern: 'Read',
    };
    const result = checkRulesDetailed([rule], 'Read', {}, 'default');
    expect(result.decision).toBe('allow');
    expect(result.matchedRule).toBe(rule);
  });

  it('returns no matchedRule for the default-ask fallback', () => {
    const result = checkRulesDetailed([], 'Bash', { command: 'ls' }, 'default');
    expect(result.decision).toBe('ask');
    expect(result.matchedRule).toBeUndefined();
  });

  it('returns no matchedRule when bypassPermissions overrides a non-deny', () => {
    const result = checkRulesDetailed([], 'Bash', { command: 'ls' }, 'bypassPermissions');
    expect(result.decision).toBe('allow');
    expect(result.matchedRule).toBeUndefined();
  });

  it('deny rule still wins in bypassPermissions mode and carries matchedRule', () => {
    const rule: PermissionRule = {
      decision: 'deny',
      scope: 'project',
      pattern: 'Write',
      reason: 'never in bypass',
    };
    const result = checkRulesDetailed([rule], 'Write', {}, 'bypassPermissions');
    expect(result.decision).toBe('deny');
    expect(result.matchedRule?.reason).toBe('never in bypass');
  });
});
