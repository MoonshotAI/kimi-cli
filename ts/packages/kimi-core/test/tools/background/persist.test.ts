/**
 * Background task persistence tests.
 */

import { mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  listTasks,
  readTask,
  removeTask,
  writeTask,
  type PersistedTask,
} from '../../../src/tools/background/persist.js';

let sessionDir: string;

function sample(overrides: Partial<PersistedTask> = {}): PersistedTask {
  return {
    task_id: 'bash-11111111',
    command: 'npm install',
    description: 'install deps',
    pid: 12345,
    started_at: 1_700_000_000,
    ended_at: null,
    exit_code: null,
    status: 'running',
    ...overrides,
  };
}

beforeEach(async () => {
  sessionDir = join(tmpdir(), `kimi-bg-persist-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(sessionDir, { recursive: true });
});

afterEach(async () => {
  await rm(sessionDir, { recursive: true, force: true });
});

describe('background/persist', () => {
  it('round-trips a task via write/read', async () => {
    await writeTask(sessionDir, sample());
    const loaded = await readTask(sessionDir, 'bash-11111111');
    expect(loaded).toEqual(sample());
  });

  it('returns undefined when task file is missing', async () => {
    expect(await readTask(sessionDir, 'bash-missing0')).toBeUndefined();
  });

  it('overwrites on subsequent write', async () => {
    await writeTask(sessionDir, sample({ status: 'running' }));
    await writeTask(sessionDir, sample({ status: 'completed', exit_code: 0, ended_at: 1_700_000_100 }));
    const t = await readTask(sessionDir, 'bash-11111111');
    expect(t?.status).toBe('completed');
    expect(t?.exit_code).toBe(0);
    expect(t?.ended_at).toBe(1_700_000_100);
  });

  it('listTasks enumerates all persisted entries', async () => {
    await writeTask(sessionDir, sample({ task_id: 'bash-11111111' }));
    await writeTask(sessionDir, sample({ task_id: 'bash-22222222', command: 'pnpm test' }));
    const all = await listTasks(sessionDir);
    expect(all).toHaveLength(2);
    expect(all.map((t) => t.task_id).sort()).toEqual(['bash-11111111', 'bash-22222222']);
  });

  it('listTasks returns empty when tasks dir does not exist', async () => {
    expect(await listTasks(sessionDir)).toEqual([]);
  });

  it('listTasks skips corrupt files', async () => {
    await writeTask(sessionDir, sample());
    // Corrupt a sibling file
    const { writeFile } = await import('node:fs/promises');
    // Phase 13 D-6 — needs a *valid-format* id for listTasks to even
    // attempt parsing (invalid-id files are silently skipped).
    await writeFile(join(sessionDir, 'tasks', 'bash-baaaaaaa.json'), '{not json', 'utf-8');
    const all = await listTasks(sessionDir);
    expect(all).toHaveLength(1);
    expect(all[0]?.task_id).toBe('bash-11111111');
  });

  it('removeTask deletes file (idempotent)', async () => {
    await writeTask(sessionDir, sample());
    await removeTask(sessionDir, 'bash-11111111');
    expect(await readTask(sessionDir, 'bash-11111111')).toBeUndefined();
    // Second remove no-op
    await expect(removeTask(sessionDir, 'bash-11111111')).resolves.toBeUndefined();
  });

  it('writeTask creates tasks dir with mode 0700', async () => {
    await writeTask(sessionDir, sample());
    const st = await stat(join(sessionDir, 'tasks'));
    // eslint-disable-next-line no-bitwise
    expect(st.mode & 0o777).toBe(0o700);
  });

  it('rejects path-traversal task ids', async () => {
    await expect(writeTask(sessionDir, sample({ task_id: '../../etc/passwd' }))).rejects.toThrow(
      /Invalid task id/,
    );
    await expect(readTask(sessionDir, '../etc/passwd')).rejects.toThrow(/Invalid task id/);
    await expect(removeTask(sessionDir, '../etc/passwd')).rejects.toThrow(/Invalid task id/);
  });

  // ── Phase 13 §1.4 — migrated from Python test_store.py ──────────────

  it('listTasks silently skips non-validating task_id files (§1.4 #5)', async () => {
    // Seed a valid task alongside a sibling file whose basename does
    // NOT match `^(bash|agent)-[0-9a-z]{8}$`.
    await writeTask(sessionDir, sample());
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      join(sessionDir, 'tasks', 'BAD-ID!!!.json'),
      JSON.stringify(sample({ task_id: 'BAD-ID!!!' })),
      'utf-8',
    );
    const all = await listTasks(sessionDir);
    expect(all).toHaveLength(1);
    expect(all[0]?.task_id).toBe('bash-11111111');
  });

  it('listTasks skips specs missing required fields (§1.4 #7)', async () => {
    await writeTask(sessionDir, sample());
    const { writeFile } = await import('node:fs/promises');
    // Valid JSON, valid filename, but shape is wrong (missing status / pid).
    await writeFile(
      join(sessionDir, 'tasks', 'bash-cccccccc.json'),
      JSON.stringify({ task_id: 'bash-cccccccc', command: 'x' }),
      'utf-8',
    );
    const all = await listTasks(sessionDir);
    expect(all).toHaveLength(1);
    expect(all[0]?.task_id).toBe('bash-11111111');
  });
});
