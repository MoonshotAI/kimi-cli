/**
 * list-directory — compact 2-level directory tree for LLM context.
 *
 * Ports Python `list_directory` / `_collect_entries` from
 * `kimi_cli/utils/path.py:58-130`. Used by GlobTool when rejecting a
 * `**`-leading pattern: appending a snapshot of the workspace root helps
 * the LLM re-scope its pattern without a second round-trip.
 *
 * Width caps keep the system-prompt token budget bounded:
 *   - Depth 0 (root):  up to LIST_DIR_ROOT_WIDTH entries
 *   - Depth 1 (children of root dirs): up to LIST_DIR_CHILD_WIDTH entries
 *   - Truncated levels show "... and N more" so the LLM knows more exists.
 */

import type { Kaos } from '@moonshot-ai/kaos';

export const LIST_DIR_ROOT_WIDTH = 30;
export const LIST_DIR_CHILD_WIDTH = 10;

interface Entry {
  readonly name: string;
  readonly isDir: boolean;
}

async function collectEntries(
  kaos: Kaos,
  dirPath: string,
  maxWidth: number,
): Promise<{ entries: Entry[]; total: number; readable: boolean }> {
  const all: Entry[] = [];
  try {
    for await (const fullPath of kaos.iterdir(dirPath)) {
      const name = basename(fullPath);
      let isDir = false;
      try {
        const st = await kaos.stat(fullPath);
        // StatResult mirrors POSIX stat; derive the file type from the
        // mode bits (S_IFMT mask → S_IFDIR == 0o040000).
        isDir = (st.stMode & 0o170000) === 0o040000;
      } catch {
        // Unreadable entries keep isDir=false; still list the name.
      }
      all.push({ name, isDir });
    }
  } catch {
    return { entries: [], total: 0, readable: false };
  }
  all.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { entries: all.slice(0, maxWidth), total: all.length, readable: true };
}

function basename(p: string): string {
  const cleaned = p.endsWith('/') && p.length > 1 ? p.slice(0, -1) : p;
  const idx = cleaned.lastIndexOf('/');
  return idx < 0 ? cleaned : cleaned.slice(idx + 1);
}

/**
 * Return a 2-level tree listing of `workDir` suitable for inclusion in a
 * tool error message. Returns `"(empty directory)"` if the directory is
 * empty, or an error marker line if the directory itself is unreadable.
 */
export async function listDirectory(kaos: Kaos, workDir: string): Promise<string> {
  const lines: string[] = [];
  const { entries, total, readable } = await collectEntries(kaos, workDir, LIST_DIR_ROOT_WIDTH);
  if (!readable) return '[not readable]';
  const remaining = total - entries.length;

  for (let i = 0; i < entries.length; i++) {
    const { name, isDir } = entries[i]!;
    const isLast = i === entries.length - 1 && remaining === 0;
    const connector = isLast ? '└── ' : '├── ';

    if (isDir) {
      lines.push(`${connector}${name}/`);
      const childPrefix = isLast ? '    ' : '│   ';
      const childDir = joinPath(workDir, name);
      const child = await collectEntries(kaos, childDir, LIST_DIR_CHILD_WIDTH);
      if (!child.readable) {
        lines.push(`${childPrefix}└── [not readable]`);
        continue;
      }
      const childRemaining = child.total - child.entries.length;
      for (let j = 0; j < child.entries.length; j++) {
        const ce = child.entries[j]!;
        const cIsLast = j === child.entries.length - 1 && childRemaining === 0;
        const cConnector = cIsLast ? '└── ' : '├── ';
        const suffix = ce.isDir ? '/' : '';
        lines.push(`${childPrefix}${cConnector}${ce.name}${suffix}`);
      }
      if (childRemaining > 0) {
        lines.push(`${childPrefix}└── ... and ${String(childRemaining)} more`);
      }
    } else {
      lines.push(`${connector}${name}`);
    }
  }

  if (remaining > 0) {
    lines.push(`└── ... and ${String(remaining)} more entries`);
  }

  return lines.length > 0 ? lines.join('\n') : '(empty directory)';
}

function joinPath(parent: string, child: string): string {
  return parent.endsWith('/') ? parent + child : `${parent}/${child}`;
}
