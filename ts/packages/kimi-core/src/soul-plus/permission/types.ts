/**
 * Permission system types (v2 §9-E.3.1).
 *
 * Flat, declarative rule schema consumed by `checkRules` and the closure
 * produced by `buildBeforeToolCall`. Soul itself has zero knowledge of
 * these types — they live entirely inside SoulPlus.
 */

export type PermissionRuleDecision = 'allow' | 'deny' | 'ask';

/**
 * Rule provenance. Slice 2.2 implements `turn-override` + static
 * `project` / `user` loading; `session-runtime` is reserved for Slice 2.3
 * (UI-driven "approve for session" learning).
 */
export type PermissionRuleScope = 'turn-override' | 'session-runtime' | 'project' | 'user';

/**
 * Top-level user-facing permission posture. Controls how non-deny rules
 * are treated when the closure is constructed. Independent of rule
 * merging: deny rules always fire regardless of mode.
 *
 *   - `default`           — rule set drives decision; unmatched tool calls ask
 *   - `acceptEdits`       — Edit/Write default to allow (deny rules still block)
 *   - `bypassPermissions` — only deny rules can block; everything else allows
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions';

/**
 * A single permission rule. `pattern` is the DSL form (`Read(/etc/**)`,
 * `Bash(rm *)`, or bare `Write`). See `parse-pattern.ts` for the parser
 * and `matches-rule.ts` for the matcher.
 */
export interface PermissionRule {
  readonly decision: PermissionRuleDecision;
  readonly scope: PermissionRuleScope;
  readonly pattern: string;
  readonly reason?: string | undefined;
}
