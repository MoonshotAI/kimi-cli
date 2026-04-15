/**
 * matchesRule — pure function that decides whether a PermissionRule
 * applies to a given tool call (v2 §9-E.3.1 / §9-E.5).
 *
 * Contract:
 *   - No side effects, no `this`, no IO, no exceptions.
 *   - Deterministic: same `(rule, toolName, args)` → same result.
 *   - Returns boolean only; decision semantics (deny/ask/allow) are a
 *     caller concern (see `check-rules.ts`).
 */

import { globToRegex } from './glob.js';
import { parsePattern } from './parse-pattern.js';
import type { PermissionRule } from './types.js';

/**
 * Tool-specific argument field convention (v2 §9-E.3.1 Phase-1 tool
 * field table). When a rule uses an arg pattern (`Read(./src/**)`), we
 * extract the listed field from the tool call args and match the glob
 * against its value.
 *
 * Unknown tools fall back to `undefined`, which means "arg pattern
 * cannot match" — rules with an arg pattern on an unknown tool will
 * never fire. Rules without an arg pattern (`UnknownTool`) still match
 * on name alone.
 */
function extractArgField(toolName: string, args: unknown): string | undefined {
  if (args === null || typeof args !== 'object') return undefined;
  const rec = args as Record<string, unknown>;

  switch (toolName) {
    case 'Bash':
    case 'Shell':
    case 'Background':
      return typeof rec['command'] === 'string' ? rec['command'] : undefined;
    case 'Read':
    case 'Write':
    case 'Edit':
      return typeof rec['path'] === 'string' ? rec['path'] : undefined;
    case 'Grep':
    case 'Glob':
      return typeof rec['pattern'] === 'string' ? rec['pattern'] : undefined;
    case 'Task':
    case 'Agent':
      return typeof rec['subagent_type'] === 'string' ? rec['subagent_type'] : undefined;
    default:
      return undefined;
  }
}

/**
 * Decide whether a single rule matches a specific tool call.
 *
 * Algorithm:
 *   1. Parse `rule.pattern` into `{toolName, argPattern?}`.
 *   2. If parsed toolName is `*`, skip name check; otherwise compare with
 *      glob semantics so `mcp__github__*` matches `mcp__github__list`.
 *   3. If the rule has no argPattern, name match → rule fires.
 *   4. Otherwise extract the tool-specific field value and match against
 *      the glob. Handle the leading `!` negation prefix by flipping the
 *      final boolean.
 */
export function matchesRule(rule: PermissionRule, toolName: string, args: unknown): boolean {
  let parsed;
  try {
    parsed = parsePattern(rule.pattern);
  } catch {
    // Malformed patterns never match. The loader is responsible for
    // surfacing DSL errors at load time; matcher stays total.
    return false;
  }

  // 1. Tool-name match (support `*` wildcard + glob-style tool names)
  const nameGlob = parsed.toolName;
  if (nameGlob !== '*') {
    const nameRegex = globToRegex(nameGlob);
    if (!nameRegex.test(toolName)) return false;
  }

  // 2. No arg pattern → name match is enough
  if (parsed.argPattern === undefined) return true;

  // 3. Arg pattern — resolve negation and glob-match the field
  const rawPattern = parsed.argPattern;
  const negated = rawPattern.startsWith('!');
  const positivePattern = negated ? rawPattern.slice(1) : rawPattern;

  const fieldValue = extractArgField(toolName, args);
  if (typeof fieldValue !== 'string') {
    // No extractable field → positive pattern cannot match; negation
    // semantics here mean "the field is not in the disallowed set",
    // which by missing-field convention we treat as a non-match to
    // avoid accidentally firing deny rules on malformed args.
    return false;
  }

  const regex = globToRegex(positivePattern);
  const hit = regex.test(fieldValue);
  return negated ? !hit : hit;
}
