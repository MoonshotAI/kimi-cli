/**
 * Phase 13 §1.3 #4 — Windows-only: kill should terminate the whole
 * process tree, not just the shell parent. On POSIX the BPM relies on
 * `proc.kill('SIGTERM')` → 5s grace → `SIGKILL`; on Windows Node's
 * default `kill` is a no-tree `taskkill /F /PID` which leaves child
 * `node` / `python` processes orphaned.
 *
 * This test file is a placeholder for the Windows environment only.
 * Non-Windows platforms skip it entirely. Today's BPM does NOT ship a
 * tree-kill implementation; when the Windows worker port lands (post-
 * Phase 13; see Phase-13 risks R2), fill in the assertion that the
 * grandchild is reaped within the grace window.
 */

import { describe, it } from 'vitest';

describe.skipIf(process.platform !== 'win32')(
  'BashTool background — Windows kill tree',
  () => {
    it.todo('stop() terminates grandchild processes via taskkill /T');
  },
);
