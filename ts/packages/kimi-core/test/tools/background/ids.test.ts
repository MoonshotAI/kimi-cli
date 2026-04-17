/**
 * Phase 13 §1.5 — migrated from Python `tests/background/test_ids.py`.
 *
 * D-6 (breaking change): task id is `{bash|agent}-{8 base36 chars}`.
 * Legacy `bg_<hex>` format is NOT accepted; the project had no
 * production history to preserve.
 */

import { describe, expect, it } from 'vitest';

import { generateTaskId, VALID_TASK_ID } from '../../../src/tools/background/index.js';

describe('background task id format (Phase 13 D-6)', () => {
  it('generated ids pass VALID_TASK_ID for every kind (§1.5 #1)', () => {
    for (const kind of ['bash', 'agent'] as const) {
      for (let i = 0; i < 32; i++) {
        const id = generateTaskId(kind);
        expect(id).toMatch(VALID_TASK_ID);
        expect(id.startsWith(`${kind}-`)).toBe(true);
      }
    }
  });

  it('rejects malformed ids (§1.5 #3)', () => {
    const rejected = [
      '', // empty
      'x', // too short
      '-bash', // wrong prefix
      'BASH-12345678', // uppercase
      'bash_12345678', // underscore separator
      '../escape', // path traversal
      'bash-1234567', // 7-char suffix
      'bash-123456789', // 9-char suffix
      'agent-ABCDEFGH', // uppercase suffix
      'bg_12345678', // legacy format is no longer accepted
      'a'.repeat(26), // long junk
    ];
    for (const bad of rejected) {
      expect(VALID_TASK_ID.test(bad)).toBe(false);
    }
    // Spot-check one *valid* id so the negative assertions aren't
    // drifting (a regex that rejects everything would pass the block
    // above on its own).
    expect(VALID_TASK_ID.test('bash-00000000')).toBe(true);
    expect(VALID_TASK_ID.test('agent-zzzzzzzz')).toBe(true);
  });
});
