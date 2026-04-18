/**
 * Phase 21 §D.2 — slash → skill fallthrough.
 *
 * When the user types `/cmd args` and `cmd` is not a registered
 * built-in slash command, ask the core (`session.listSkills`) whether a
 * skill of that name exists. If so, activate it via
 * `session.activateSkill`; otherwise report "Unknown command".
 *
 * Built-ins always win (the caller performs the built-in lookup first).
 * Name matching is case-sensitive to mirror core's `SkillManager.get`
 * which normalises both sides of the comparison with `toLowerCase()` —
 * if callers pass the exact typed name both the built-in registry and
 * the skill list behave the same way.
 */

import type { WireClient } from '../wire/index.js';

export interface SkillDispatchResult {
  /** True when a skill of `name` was found and activation was attempted. */
  readonly matched: boolean;
  /** User-facing message to surface in the transcript. */
  readonly message: string;
}

/**
 * Attempt to dispatch `/name args` as a skill activation.
 * Returns `{matched:false}` when either the wire client lacks skill
 * support or the name does not match any invocable skill — callers
 * surface "Unknown command" in that case.
 */
export async function tryDispatchSkill(
  wireClient: WireClient,
  sessionId: string,
  name: string,
  args: string,
): Promise<SkillDispatchResult> {
  if (wireClient.listSkills === undefined || wireClient.activateSkill === undefined) {
    return { matched: false, message: `Unknown command: /${name}` };
  }
  let skills: ReadonlyArray<{ name: string }>;
  try {
    const listed = await wireClient.listSkills(sessionId);
    skills = listed.skills;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { matched: false, message: `Unknown command: /${name} (skill lookup failed: ${msg})` };
  }
  const exists = skills.some((s) => s.name === name);
  if (!exists) {
    return { matched: false, message: `Unknown command: /${name}` };
  }
  try {
    await wireClient.activateSkill(sessionId, name, args);
    return { matched: true, message: `Skill "${name}" activated.` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { matched: true, message: `Skill "${name}" failed: ${msg}` };
  }
}
