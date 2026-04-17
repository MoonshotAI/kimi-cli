/**
 * SessionPicker — pi-tui version of the session selection dialog.
 */

import { Container, Text, matchesKey, Key, type Focusable } from '@mariozechner/pi-tui';
import chalk from 'chalk';
import type { SessionInfo } from '../wire/methods.js';
import type { ColorPalette } from '../theme/colors.js';

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.floor(hours / 24);
  return `${String(days)}d ago`;
}

function shortenPath(path: string, maxLen: number = 40): string {
  const home = process.env['HOME'] ?? '';
  let shortened = path;
  if (home && path.startsWith(home)) {
    shortened = '~' + path.slice(home.length);
  }
  if (shortened.length > maxLen) {
    return '...' + shortened.slice(shortened.length - maxLen + 3);
  }
  return shortened;
}

export class SessionPickerComponent extends Container implements Focusable {
  private sessions: SessionInfo[];
  private currentSessionId: string;
  private colors: ColorPalette;
  private onSelect: (sessionId: string) => void;
  private onCancel: () => void;
  private maxVisibleSessions: number;
  private loading: boolean;

  focused = false;
  private selectedIndex = 0;

  constructor(opts: {
    sessions: SessionInfo[];
    loading: boolean;
    currentSessionId: string;
    colors: ColorPalette;
    onSelect: (sessionId: string) => void;
    onCancel: () => void;
    maxVisibleSessions?: number;
  }) {
    super();
    this.sessions = opts.sessions;
    this.loading = opts.loading;
    this.currentSessionId = opts.currentSessionId;
    this.colors = opts.colors;
    this.onSelect = opts.onSelect;
    this.onCancel = opts.onCancel;
    this.maxVisibleSessions = opts.maxVisibleSessions ?? 6;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.onCancel();
      return;
    }
    if (matchesKey(data, Key.enter) && this.sessions.length > 0) {
      const session = this.sessions[this.selectedIndex];
      if (session) this.onSelect(session.id);
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(this.sessions.length - 1, this.selectedIndex + 1);
      return;
    }
  }

  override render(width: number): string[] {
    const colors = this.colors;
    const lines: string[] = [];

    lines.push(chalk.hex(colors.primary)('─'.repeat(width)));

    if (this.loading) {
      lines.push(chalk.hex(colors.primary).bold('Sessions'));
      lines.push(chalk.hex(colors.textMuted)('Loading sessions...'));
      lines.push(chalk.hex(colors.primary)('─'.repeat(width)));
      return lines;
    }

    if (this.sessions.length === 0) {
      lines.push(chalk.hex(colors.primary).bold('Sessions'));
      lines.push(chalk.hex(colors.textMuted)('No sessions found. Press Escape to close.'));
      lines.push(chalk.hex(colors.primary)('─'.repeat(width)));
      return lines;
    }

    lines.push(
      chalk.hex(colors.primary).bold('Sessions ') +
      chalk.hex(colors.textMuted)('(↑↓ navigate, Enter select, Esc cancel)'),
    );

    const visibleStart = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(this.maxVisibleSessions / 2),
        Math.max(0, this.sessions.length - this.maxVisibleSessions),
      ),
    );
    const visibleSessions = this.sessions.slice(
      visibleStart,
      visibleStart + this.maxVisibleSessions,
    );

    for (let vi = 0; vi < visibleSessions.length; vi++) {
      const session = visibleSessions[vi]!;
      const index = visibleStart + vi;
      const isSelected = index === this.selectedIndex;
      const isCurrent = session.id === this.currentSessionId;
      const pointer = isSelected ? '❯' : ' ';
      const title = session.title ?? session.id;
      const time = formatRelativeTime(session.updated_at);
      const dir = shortenPath(session.work_dir);

      let line = chalk.hex(isSelected ? colors.primary : colors.textDim)(pointer + ' ');
      line += isSelected ? chalk.hex(colors.primary).bold(title) : chalk.hex(colors.text)(title);
      if (isCurrent) line += ' ' + chalk.hex(colors.success)('(current)');
      line += ' ' + chalk.hex(colors.textMuted)(dir);
      line += ' ' + chalk.hex(colors.textDim)(time);
      lines.push(line);
    }

    if (this.sessions.length > visibleSessions.length) {
      lines.push(chalk.hex(colors.textMuted)(
        `Showing ${String(visibleStart + 1)}-${String(visibleStart + visibleSessions.length)} of ${String(this.sessions.length)} sessions`,
      ));
    }

    lines.push(chalk.hex(colors.primary)('─'.repeat(width)));
    return lines;
  }
}
