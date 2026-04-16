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
    task_id: 'bg_1',
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
    const loaded = await readTask(sessionDir, 'bg_1');
    expect(loaded).toEqual(sample());
  });

  it('returns undefined when task file is missing', async () => {
    expect(await readTask(sessionDir, 'never')).toBeUndefined();
  });

  it('overwrites on subsequent write', async () => {
    await writeTask(sessionDir, sample({ status: 'running' }));
    await writeTask(sessionDir, sample({ status: 'completed', exit_code: 0, ended_at: 1_700_000_100 }));
    const t = await readTask(sessionDir, 'bg_1');
    expect(t?.status).toBe('completed');
    expect(t?.exit_code).toBe(0);
    expect(t?.ended_at).toBe(1_700_000_100);
  });

  it('listTasks enumerates all persisted entries', async () => {
    await writeTask(sessionDir, sample({ task_id: 'bg_1' }));
    await writeTask(sessionDir, sample({ task_id: 'bg_2', command: 'pnpm test' }));
    const all = await listTasks(sessionDir);
    expect(all).toHaveLength(2);
    expect(all.map((t) => t.task_id).sort()).toEqual(['bg_1', 'bg_2']);
  });

  it('listTasks returns empty when tasks dir does not exist', async () => {
    expect(await listTasks(sessionDir)).toEqual([]);
  });

  it('listTasks skips corrupt files', async () => {
    await writeTask(sessionDir, sample());
    // Corrupt a sibling file
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(sessionDir, 'tasks', 'bg_bad.json'), '{not json', 'utf-8');
    const all = await listTasks(sessionDir);
    expect(all).toHaveLength(1);
    expect(all[0]?.task_id).toBe('bg_1');
  });

  it('removeTask deletes file (idempotent)', async () => {
    await writeTask(sessionDir, sample());
    await removeTask(sessionDir, 'bg_1');
    expect(await readTask(sessionDir, 'bg_1')).toBeUndefined();
    // Second remove no-op
    await expect(removeTask(sessionDir, 'bg_1')).resolves.toBeUndefined();
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
});
