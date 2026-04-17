/**
 * HelpPanel — modal `/help` display. Lists keyboard shortcuts, slash
 * commands (with aliases + descriptions) in colour-coded sections.
 *
 * Mirrors the container-replacement pattern used by SessionPicker /
 * ApprovalPanel: host mounts the panel into `editorContainer`, picks
 * it as the focused component, and tears it down on the `onClose`
 * callback (fired on Esc / Enter / q).
 */

import { Container, matchesKey, Key, type Focusable, truncateToWidth } from '@mariozechner/pi-tui';
import chalk from 'chalk';
import type { ColorPalette } from '../theme/colors.js';
import type { SlashCommandDef } from '../slash/registry.js';

export interface KeyboardShortcut {
  readonly keys: string;
  readonly description: string;
}

/** Static list — keep in sync with CustomEditor / ApprovalPanel bindings. */
export const DEFAULT_KEYBOARD_SHORTCUTS: readonly KeyboardShortcut[] = [
  { keys: 'Shift-Tab', description: 'Toggle plan mode' },
  { keys: 'Ctrl-O', description: 'Edit in external editor ($VISUAL / $EDITOR)' },
  { keys: 'Ctrl-T', description: 'Toggle tool output expansion' },
  { keys: 'Ctrl-S', description: 'Steer — inject a follow-up during streaming' },
  { keys: 'Ctrl-J / Alt-Enter', description: 'Insert newline' },
  { keys: 'Ctrl-C', description: 'Interrupt stream / clear input' },
  { keys: 'Ctrl-D', description: 'Exit (on empty input)' },
  { keys: 'Esc', description: 'Close dialogs / interrupt streaming' },
  { keys: '↑ / ↓', description: 'Browse input history' },
  { keys: 'Enter', description: 'Submit' },
];

export interface HelpPanelOptions {
  readonly commands: readonly SlashCommandDef[];
  readonly shortcuts?: readonly KeyboardShortcut[];
  readonly colors: ColorPalette;
  readonly onClose: () => void;
  /** Terminal height — used to decide whether to show the hint tail. */
  readonly maxVisible?: number;
}

export class HelpPanelComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: HelpPanelOptions;
  private scrollTop = 0;

  constructor(opts: HelpPanelOptions) {
    super();
    this.opts = opts;
  }

  handleInput(data: string): void {
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.enter) ||
      data === 'q' ||
      data === 'Q'
    ) {
      this.opts.onClose();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.scrollTop = Math.max(0, this.scrollTop - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.scrollTop += 1; // render clamps
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.scrollTop = Math.max(0, this.scrollTop - 10);
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollTop += 10;
      return;
    }
  }

  override render(width: number): string[] {
    const c = this.opts.colors;
    const accent = chalk.hex(c.primary);
    const dim = chalk.hex(c.textDim);
    const muted = chalk.hex(c.textMuted);
    const kbdColor = chalk.hex(c.warning);
    const slashColor = chalk.hex(c.primary);

    const lines: string[] = [];
    lines.push(accent('─'.repeat(width)));
    lines.push(accent.bold(' help ') + muted('· Esc / Enter / q to close · ↑↓ scroll'));
    lines.push('');

    // Greeting
    lines.push(`  ${dim("Sure, Kimi is ready to help! Just send a message to get started.")}`);
    lines.push('');

    // Section: keyboard shortcuts
    lines.push(`  ${chalk.bold('Keyboard shortcuts')}`);
    const shortcuts = this.opts.shortcuts ?? DEFAULT_KEYBOARD_SHORTCUTS;
    const kbdWidth = Math.max(8, ...shortcuts.map((s) => s.keys.length));
    for (const s of shortcuts) {
      lines.push(`    ${kbdColor(s.keys.padEnd(kbdWidth))}  ${dim(s.description)}`);
    }
    lines.push('');

    // Section: slash commands
    lines.push(`  ${chalk.bold('Slash commands')}`);
    const sortedCmds = [...this.opts.commands].sort((a, b) => a.name.localeCompare(b.name));
    const cmdLabels = sortedCmds.map((c) => {
      const aliases = c.aliases.length > 0
        ? ` (${c.aliases.map((a) => '/' + a).join(', ')})`
        : '';
      return `/${c.name}${aliases}`;
    });
    const cmdWidth = Math.max(12, ...cmdLabels.map((l) => l.length));
    for (let i = 0; i < sortedCmds.length; i++) {
      const cmd = sortedCmds[i]!;
      const label = cmdLabels[i]!;
      lines.push(`    ${slashColor(label.padEnd(cmdWidth))}  ${dim(cmd.description)}`);
    }

    lines.push('');
    lines.push(accent('─'.repeat(width)));

    // Apply scroll windowing — keep the borders visible.
    const content = lines.slice(1, lines.length - 1);
    const maxVisible = Math.max(5, this.opts.maxVisible ?? 24);
    if (content.length > maxVisible) {
      this.scrollTop = Math.max(0, Math.min(this.scrollTop, content.length - maxVisible));
      const slice = content.slice(this.scrollTop, this.scrollTop + maxVisible);
      const scrollInfo = muted(
        ` showing ${String(this.scrollTop + 1)}-${String(this.scrollTop + slice.length)} of ${String(content.length)}`,
      );
      return [
        lines[0]!,
        ...slice,
        scrollInfo,
        lines[lines.length - 1]!,
      ].map((line) => truncateToWidth(line, width));
    }
    this.scrollTop = 0;
    return lines.map((line) => truncateToWidth(line, width));
  }
}
