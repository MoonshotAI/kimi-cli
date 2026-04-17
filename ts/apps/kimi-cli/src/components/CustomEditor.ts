/**
 * Custom editor extending pi-tui Editor with app-level keybindings.
 */

import { Editor, type EditorTheme, type TUI, matchesKey, Key } from '@mariozechner/pi-tui';
import chalk from 'chalk';

const ANSI_SGR = /\x1b\[[0-9;]*m/g;

/** Convert a visible-char index (ANSI-stripped) back to an index into the raw ANSI-bearing string. */
function mapVisibleIdxToRaw(line: string, visibleIdx: number): number {
  let visibleCount = 0;
  let i = 0;
  const re = new RegExp(ANSI_SGR.source, 'y');
  while (i < line.length && visibleCount < visibleIdx) {
    re.lastIndex = i;
    const m = re.exec(line);
    if (m !== null && m.index === i) {
      i += m[0].length;
    } else {
      visibleCount++;
      i++;
    }
  }
  return i;
}

function stripSgr(s: string): string {
  return s.replace(ANSI_SGR, '');
}

export class CustomEditor extends Editor {
  public onEscape?: () => void;
  public onCtrlD?: () => void;
  public onCtrlC?: () => void;
  public onToggleToolExpand?: () => void;
  public onOpenExternalEditor?: () => void;
  public onCtrlS?: () => void;
  /**
   * Called when ↑ is pressed in an empty editor. Return `true` to consume
   * the key (e.g. recalled a queued message); return `false` to fall
   * through so pi-tui's built-in history navigation runs.
   */
  public onUpArrowEmpty?: () => boolean;
  public onShiftTab?: () => void;

  /**
   * Hex colour used to highlight a leading `/slash-command` token in
   * the input. Host sets this on theme change; undefined disables the
   * highlight entirely.
   */
  public slashHighlightHex: string | undefined;

  constructor(tui: TUI, theme: EditorTheme) {
    super(tui, theme);
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    const hex = this.slashHighlightHex;
    if (hex === undefined) return lines;
    const text = this.getText().trimStart();
    if (!text.startsWith('/')) return lines;
    // Editor output shape: [topBorder, ...contentLines, bottomBorder].
    // Paint only the FIRST content line; multi-line slash commands are
    // not a thing in practice.
    if (lines.length < 3) return lines;
    const firstContentIdx = 1;
    const original = lines[firstContentIdx];
    if (original === undefined) return lines;
    const highlighted = highlightFirstSlashToken(original, hex);
    if (highlighted !== undefined) {
      lines[firstContentIdx] = highlighted;
    }
    return lines;
  }

  override handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl('d'))) {
      if (this.getText().length === 0) {
        this.onCtrlD?.();
        return;
      }
    }

    if (matchesKey(data, Key.ctrl('c'))) {
      this.onCtrlC?.();
      return;
    }

    if (matchesKey(data, Key.ctrl('o'))) {
      this.onOpenExternalEditor?.();
      return;
    }

    if (matchesKey(data, Key.ctrl('t'))) {
      this.onToggleToolExpand?.();
      return;
    }

    if (matchesKey(data, Key.ctrl('s'))) {
      this.onCtrlS?.();
      return;
    }

    if (matchesKey(data, 'shift+tab')) {
      this.onShiftTab?.();
      return;
    }

    if (matchesKey(data, Key.up)) {
      if (this.getText().length === 0 && this.onUpArrowEmpty) {
        if (this.onUpArrowEmpty()) return;
        // fall through to super so Editor's built-in history navigation runs
      }
    }

    if (matchesKey(data, Key.escape)) {
      if (!this.isShowingAutocomplete()) {
        this.onEscape?.();
        return;
      }
    }

    super.handleInput(data);
  }
}

/**
 * Return a copy of `line` with the first `/token` coloured using `hex`.
 * `line` may already contain SGR escapes (cursor inverse, etc.); we
 * locate `/` via visible-index math so ANSI pass-through survives.
 * Returns `undefined` if no token is found.
 */
export function highlightFirstSlashToken(
  line: string,
  hex: string,
): string | undefined {
  const visible = stripSgr(line);
  const slashIdx = visible.indexOf('/');
  if (slashIdx < 0) return undefined;
  // Guard: only paint when `/` is the first non-whitespace character
  // on the line (avoids colouring a mid-sentence slash).
  for (let i = 0; i < slashIdx; i++) {
    if (visible[i] !== ' ' && visible[i] !== '\t') return undefined;
  }
  // Token ends at the next whitespace (or the visible end).
  let endVisible = slashIdx + 1;
  while (endVisible < visible.length) {
    const ch = visible[endVisible];
    if (ch === ' ' || ch === '\t') break;
    endVisible++;
  }
  const rawStart = mapVisibleIdxToRaw(line, slashIdx);
  const rawEnd = mapVisibleIdxToRaw(line, endVisible);
  const before = line.slice(0, rawStart);
  const token = line.slice(rawStart, rawEnd);
  const after = line.slice(rawEnd);
  return before + chalk.hex(hex).bold(token) + after;
}
