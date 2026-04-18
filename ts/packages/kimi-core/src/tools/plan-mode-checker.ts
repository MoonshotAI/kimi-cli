/**
 * PlanModeChecker — Phase 18 §D.5.
 *
 * Host-injected query surface used by Write / Edit / Bash to apply the
 * plan-mode hard-block policy. v2 §11 flipped the pre-Phase-18 "soft
 * reminder" policy: while plan mode is active, any mutation outside the
 * current plan file MUST fail the tool call with `isError: true` and a
 * message that points the LLM at `ExitPlanMode`.
 *
 * The type is intentionally tiny — we don't want the tool layer coupled
 * to `SessionMetaService` or the plan-file manager directly. Hosts wire
 * the checker by closing over whatever runtime source of truth they
 * have (e.g. TurnManager's plan-mode flag + PlanFileManager.getCurrentPlanPath).
 */
export interface PlanModeChecker {
  /** `true` iff plan mode is currently active. */
  isPlanModeActive(): boolean;
  /**
   * Absolute path of the current plan file (the only file Write/Edit
   * may mutate while plan mode is active), or `null` when no plan file
   * has been assigned yet.
   */
  getPlanFilePath(): string | null;
}

/**
 * Shared error message surface used by Write / Edit so the LLM always
 * sees a consistent "here's the exit" hint regardless of which tool
 * tripped the block.
 */
export function planModeWriteBlockMessage(planPath: string | null): string {
  const target = planPath ?? '(no plan file selected yet)';
  return (
    'Plan mode is active. You may only write to the current plan file: ' +
    `${target}. Call ExitPlanMode to exit plan mode before editing other files.`
  );
}

/**
 * Shared error message surface for Bash mutation blocks.
 */
export function planModeBashBlockMessage(): string {
  return (
    'Plan mode is active. This command would mutate the filesystem; plan ' +
    'mode forbids that. Call ExitPlanMode to exit plan mode before running ' +
    'mutation commands.'
  );
}

/**
 * Classify a shell command as "mutation" vs read-only. Used exclusively
 * by the plan-mode hard block — the detector is conservative: the tests
 * pin seven concrete cases (rm, redirect `>`, `>>`, sed -i, git commit,
 * plus `ls` / `cat` that must NOT trip the gate). The detector leans
 * toward under-blocking (unknown-first-word = allow) so plan-mode
 * doesn't interfere with legitimate read-only explorations.
 *
 * This deliberately does NOT attempt to be a full shell parser. Known
 * and accepted false positives:
 *   - Quoted strings containing `>` are blocked (e.g.
 *     `echo "hello > world"`) because the regex does not track quote
 *     state. Plan-mode callers can work around this by avoiding
 *     redirect-like substrings in quoted output.
 *   - `&>` / `&>>` (bash stderr+stdout combined redirect) is *not*
 *     detected; those are legitimate file writes but the policy's
 *     7-case test pin does not cover them.
 *
 * Stricter parsing is out of scope for Phase 18; hosts that need
 * tighter policy should wrap or replace this helper.
 */
export function isMutatingBashCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;

  // Output redirect `>` or `>>` pointing to a file. Excluded patterns:
  //   - `2>&1` (stderr → stdout, not a file write)
  //   - `&>` / `&>>` edge cases are not covered by the tests; those are
  //     effectively file writes too but the policy isn't required to
  //     catch them.
  if (/(^|[^&0-9])>{1,2}\s*(?!&)\S/.test(trimmed)) {
    return true;
  }

  const tokens = trimmed.split(/\s+/);
  const firstToken = tokens[0] ?? '';

  const alwaysMutating = new Set([
    'rm', 'rmdir', 'mv', 'cp', 'mkdir', 'touch', 'chmod', 'chown', 'ln',
    'tee', 'dd', 'truncate', 'shred', 'patch',
  ]);
  if (alwaysMutating.has(firstToken)) return true;

  // `sed -i` / `sed --in-place` is the mutation mode. Plain `sed` is
  // stream-only (writes to stdout) and must stay allowed.
  if (
    firstToken === 'sed'
    && (/\s-i(\b|\s|=)/.test(` ${trimmed}`) || trimmed.includes('--in-place'))
  ) {
    return true;
  }

  if (firstToken === 'git') {
    const gitMutating = new Set([
      'commit', 'push', 'reset', 'checkout', 'rebase', 'merge', 'tag',
      'stash', 'cherry-pick', 'revert', 'pull', 'add', 'rm', 'mv',
      'clone', 'init', 'restore', 'apply', 'clean', 'gc', 'prune',
    ]);
    const sub = tokens[1];
    if (sub !== undefined && gitMutating.has(sub)) return true;
    if (sub === 'branch' && /\s-[dD](\b|\s)/.test(trimmed)) return true;
  }

  const packageManagers = new Set([
    'npm', 'yarn', 'pnpm', 'pip', 'pip3', 'poetry', 'cargo', 'gem', 'uv',
  ]);
  if (packageManagers.has(firstToken)) {
    const sub = tokens[1] ?? '';
    const mutatingSubs = new Set([
      'install', 'i', 'add', 'remove', 'rm', 'uninstall', 'update',
      'upgrade', 'publish', 'link', 'unlink',
    ]);
    if (mutatingSubs.has(sub)) return true;
  }

  return false;
}
