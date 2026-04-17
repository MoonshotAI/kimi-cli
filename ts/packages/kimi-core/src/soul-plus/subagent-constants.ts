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
