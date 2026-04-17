/**
 * External-editor helper — spawn $VISUAL / $EDITOR (or a configured
 * command) on a temp file seeded with the current editor buffer, then
 * read the edited contents back.
 *
 * Mirrors Python `kimi_cli/utils/editor.py` — resolution priority is
 *   configured (from config.toml `default_editor` / `/editor`) >
 *   $VISUAL > $EDITOR > undefined (caller handles "no editor" toast).
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function resolveEditorCommand(configured?: string | null): string | undefined {
  const candidates = [configured, process.env['VISUAL'], process.env['EDITOR']];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) {
      return c.trim();
    }
  }
  return undefined;
}

/**
 * Launch `command` (tokenised via a shell) against a temp file seeded
 * with `initialText`. Returns the edited contents on success, or
 * `undefined` if the editor exited non-zero / the file disappeared.
 *
 * The command is passed to `/bin/sh -c "<cmd> <tmpfile>"` so users can
 * supply argv-style strings like `"code --wait"` or `"nvim +set ft=markdown"`.
 */
export async function editInExternalEditor(
  initialText: string,
  command: string,
): Promise<string | undefined> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-edit-'));
  const file = join(dir, 'prompt.md');
  await writeFile(file, initialText, 'utf-8');
  try {
    const code = await new Promise<number>((resolve, reject) => {
      const shellCmd = `${command} ${shellQuote(file)}`;
      const child = spawn('/bin/sh', ['-c', shellCmd], { stdio: 'inherit' });
      child.on('exit', (c) => resolve(c ?? 0));
      child.on('error', reject);
    });
    if (code !== 0) return undefined;
    return await readFile(file, 'utf-8');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {
      // best-effort cleanup
    });
  }
}

function shellQuote(path: string): string {
  // Single-quote and escape any embedded single quotes.
  return `'${path.replace(/'/g, "'\\''")}'`;
}
