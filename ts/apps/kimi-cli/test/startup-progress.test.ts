/**
 * Phase 15 A.7 — KimiCLI startup progress reporting (Python parity).
 *
 * Python `tests/core/test_startup_progress.py::test_kimi_cli_create_reports_startup_phases`
 * (kimi_cli/app.py) emits four sequential progress phases from the
 * `KimiCLI.create` constructor via a `startup_progress` callback. The
 * TS equivalent does not yet expose such a callback — the test file is
 * scaffolded here with `it.todo` placeholders so the coverage gap is
 * surfaced by the migration report without drifting out of tree.
 *
 * Implementer dependency:
 *   - `apps/kimi-cli/src/app/context.ts` (or `InteractiveMode.ts`) needs
 *     a `startupProgress(phase: 'loading_config' | 'scanning_workspace' |
 *     'loading_agent' | 'restoring_conversation') => void` optional hook
 *     invoked in-order during CLI bootstrap.
 *   - The new hook is surfaced to the TUI so `ShellStartupProgress` (to
 *     be ported from Python) can render the phases inline.
 *
 * These `it.todo`s convert to real it's once the hook ships; at that
 * point each phase emits at least once and the order is stable.
 */

import { describe, it } from 'vitest';

describe('KimiCLI startup progress (Phase 15 A.7 — Python parity)', () => {
  // Python: test_kimi_cli_create_reports_startup_phases — 4 phases.
  it.todo('emits "loading_config" phase before reading workspace/config files');
  it.todo('emits "scanning_workspace" phase while walking the workspace tree');
  it.todo('emits "loading_agent" phase when resolving agent types and tools');
  it.todo(
    'emits "restoring_conversation" phase when replaying a resumed session journal',
  );
});

// ── Cleanup-stale-running subagents: foreground vs background ────────
//
// Python `test_kimi_cli_create_cleans_stale_running_foreground_subagents`
// (test_startup_progress.py:119) expects that only *foreground* running
// subagents become `failed` on resume; background ones keep running.
// TS `cleanupStaleSubagents` currently does not distinguish, so the
// existing behaviour (pinned in `test/soul-plus/subagent-recovery.test.ts`)
// marks every running instance as failed. The contract below needs a
// `SubagentInstance.is_foreground` field before it can be enforced —
// tracked as an open issue.

describe('Cleanup stale subagents — foreground/background split (Phase 15 A.7)', () => {
  it.todo(
    'preserves background-running subagents on resume; only foreground ones become failed',
  );
});
