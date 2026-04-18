/**
 * Skill-system error types — Phase 18 §C.3.
 *
 * `NestedSkillTooDeepError` is thrown by `SkillTool.execute` when the
 * recursion cap `MAX_SKILL_QUERY_DEPTH` is hit. It's a structured error
 * (not a soft tool-error) so the Runtime can distinguish "the LLM
 * mis-dispatched a skill" from "the recursion safety net fired" and
 * surface the right telemetry / UI.
 */

export class NestedSkillTooDeepError extends Error {
  readonly skillName?: string;
  readonly depth: number;

  constructor(depth: number, skillName?: string) {
    const label = skillName !== undefined ? ` "${skillName}"` : '';
    super(
      `Nested skill invocation${label} exceeded the maximum depth of ${String(depth)} — refusing to recurse further.`,
    );
    this.name = 'NestedSkillTooDeepError';
    this.depth = depth;
    if (skillName !== undefined) this.skillName = skillName;
  }
}
