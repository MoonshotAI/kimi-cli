/**
 * checkRules — pure decision function (v2 §9-E.5).
 *
 * Walks the merged rule set with strict priority `deny > ask > allow`
 * and applies the PermissionMode overlay. Contract:
 *
 *   - Pure: no `this`, no IO, no globals, no exceptions.
 *   - Deterministic for a fixed `(rules, toolName, args, mode)`.
 *   - Safe to run in parallel; cheap enough that callers typically run
 *     it synchronously inside the `beforeToolCall` closure.
 *
 * Priority rationale (Q1 coordinator decision): deny can never be
 * overridden by allow/ask — the safety posture is "locked first, then
 * ask, then allow, and default to ask when nothing matches". This holds
 * across all three modes.
 *
 * Mode overlay:
 *   - `bypassPermissions`: deny rules still win; everything else is allow.
 *   - `acceptEdits`: Edit/Write default to allow (deny still wins);
 *     other tools go through the normal rule walk.
 *   - `default`: rule walk drives the decision; unmatched → ask.
 *
 * Slice 2.3 addition: `checkRulesDetailed` returns the matched rule
 * alongside the decision so the closure can surface `rule.reason` in the
 * block reason shown to the user (reviewer N2 remediation).
 */

import { matchesRule } from './matches-rule.js';
import type { PermissionMode, PermissionRule, PermissionRuleDecision } from './types.js';

export interface CheckRulesResult {
  readonly decision: PermissionRuleDecision;
  /** Rule that produced `decision`. `undefined` for mode-overlay or default-ask. */
  readonly matchedRule?: PermissionRule | undefined;
}

export function checkRulesDetailed(
  rules: readonly PermissionRule[],
  toolName: string,
  toolInput: unknown,
  mode: PermissionMode,
): CheckRulesResult {
  // Priority 1: deny wins in every mode.
  for (const rule of rules) {
    if (rule.decision === 'deny' && matchesRule(rule, toolName, toolInput)) {
      return { decision: 'deny', matchedRule: rule };
    }
  }

  // Mode overlay: bypassPermissions treats everything non-deny as allow.
  if (mode === 'bypassPermissions') {
    return { decision: 'allow' };
  }

  // Mode overlay: acceptEdits treats Edit/Write as allow unless a deny
  // rule already fired (handled above).
  if (mode === 'acceptEdits' && (toolName === 'Edit' || toolName === 'Write')) {
    return { decision: 'allow' };
  }

  // Priority 2: ask before allow so unresolved ambiguity defers to the user.
  for (const rule of rules) {
    if (rule.decision === 'ask' && matchesRule(rule, toolName, toolInput)) {
      return { decision: 'ask', matchedRule: rule };
    }
  }

  // Priority 3: explicit allow.
  for (const rule of rules) {
    if (rule.decision === 'allow' && matchesRule(rule, toolName, toolInput)) {
      return { decision: 'allow', matchedRule: rule };
    }
  }

  // No rule matched — default posture is "ask".
  return { decision: 'ask' };
}

/**
 * Back-compat helper returning only the decision. Kept so existing
 * Slice 2.2 call-sites / tests that don't care about the matched rule
 * don't have to be rewritten.
 */
export function checkRules(
  rules: readonly PermissionRule[],
  toolName: string,
  toolInput: unknown,
  mode: PermissionMode,
): PermissionRuleDecision {
  return checkRulesDetailed(rules, toolName, toolInput, mode).decision;
}
