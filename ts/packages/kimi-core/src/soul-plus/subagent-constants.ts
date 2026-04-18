/**
 * Shared subagent-related constants (Phase 6 / 决策 #88).
 *
 * Kept in its own module so both `SoulRegistry.spawn()` and
 * `runSubagentTurn` can write `subagent_completed` records with the same
 * truncation budget — the field is denormalised into the parent wire and
 * a divergence between the two write sites would corrupt the
 * append-only log under replay.
 */

/**
 * Maximum length (UTF-16 code units) of `result_summary` on a
 * `subagent_completed` record. Long subagent outputs are truncated so
 * the parent wire never balloons; the full body lives on the child's
 * own `wire.jsonl`.
 */
export const RESULT_SUMMARY_MAX_LEN = 500;

/**
 * Phase 17 §C.3 — hard cap on `Skill → Skill` fork depth. The parent
 * SkillTool carries its own `initialQueryDepth`; each child invocation
 * increments by one and fails the tool call with an `is_error` result
 * once the cap is reached. Mirrors the Python soul's recursion guard.
 */
export const MAX_SKILL_QUERY_DEPTH = 3;

/**
 * Phase 18 §E.2 — hard cap on `subagent → subagent` recursion depth.
 * `main` counts as depth 0; the first level of subagents is depth 1; a
 * subagent attempting to spawn while its own depth is already 5 must be
 * rejected with `SubagentTooDeepError` BEFORE any persistence side
 * effects happen.
 */
export const MAX_SUBAGENT_DEPTH = 5;
