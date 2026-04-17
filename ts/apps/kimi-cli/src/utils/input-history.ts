/**
 * User input history persistence — JSONL file with `{"content": "..."}` per line.
 *
 * Mirrors the Python implementation in `kimi_cli/ui/shell/prompt.py`:
 * - One JSON object per line (`_HistoryEntry { content }`)
 * - Append-only writes
 * - Skip empty entries
 * - Skip when same as last entry (consecutive deduplication)
 * - Tolerate corrupt lines: log + skip, do not abort load
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface InputHistoryEntry {
  content: string;
}

export async function loadInputHistory(file: string): Promise<InputHistoryEntry[]> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const entries: InputHistoryEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as { content?: unknown }).content === 'string'
      ) {
        entries.push({ content: (parsed as { content: string }).content });
      }
    } catch {
      // Skip malformed line; do not abort the whole load.
    }
  }
  return entries;
}

/**
 * Append an entry to the history file. Returns true if written, false if
 * skipped (empty or equal to `lastContent`).
 */
export async function appendInputHistory(
  file: string,
  text: string,
  lastContent?: string,
): Promise<boolean> {
  const content = text.trim();
  if (content.length === 0) return false;
  if (content === lastContent) return false;
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify({ content })}\n`, 'utf-8');
  return true;
}
