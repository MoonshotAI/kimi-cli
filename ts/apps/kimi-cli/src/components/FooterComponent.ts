/**
 * Footer/status bar — 3-line status display at the bottom of the TUI.
 */

import type { Component } from '@mariozechner/pi-tui';
import { truncateToWidth, visibleWidth } from '@mariozechner/pi-tui';
import chalk from 'chalk';
import type { AppState } from '../app/state.js';
import type { ColorPalette } from '../theme/colors.js';
import type { StatusUpdateData, SessionMetaChangedData } from '../wire/events.js';

/**
 * Phase 21 Slice F — typed live-feed the Footer subscribes to.
 *
 * Keeps the Footer decoupled from the concrete WireHandler / TUI so
 * unit tests can drive it with a plain object.
 */
export interface FooterFeedHandlers {
  onStatusUpdate(handler: (data: StatusUpdateData) => void): () => void;
  onSessionMetaChanged(handler: (data: SessionMetaChangedData) => void): () => void;
}

const MAX_CWD_COLS = 30;

function shortenCwd(path: string): string {
  const home = process.env['HOME'] ?? '';
  let shortened = path;
  if (home && path === home) {
    shortened = '~';
  } else if (home && path.startsWith(home + '/')) {
    shortened = '~' + path.slice(home.length);
  }
  if (shortened.length > MAX_CWD_COLS) {
    return '…' + shortened.slice(shortened.length - MAX_CWD_COLS + 1);
  }
  return shortened;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function safeUsage(usage: number): number {
  return Number.isFinite(usage) ? Math.max(0, Math.min(usage, 1)) : 0;
}

function formatContextStatus(usage: number, tokens?: number, maxTokens?: number): string {
  const pct = `${(safeUsage(usage) * 100).toFixed(1)}%`;
  if (maxTokens && maxTokens > 0 && tokens !== undefined) {
    return `context: ${pct} (${formatTokenCount(tokens)}/${formatTokenCount(maxTokens)})`;
  }
  return `context: ${pct}`;
}

function contextColor(usage: number, colors: ColorPalette): string {
  const safe = safeUsage(usage);
  if (safe > 0.85) return colors.error;
  if (safe > 0.5) return colors.warning;
  return colors.success;
}

export class FooterComponent implements Component {
  private state: AppState;
  private colors: ColorPalette;
  private subscriptions: Array<() => void> = [];

  constructor(state: AppState, colors: ColorPalette) {
    this.state = state;
    this.colors = colors;
  }

  setState(state: AppState): void {
    this.state = state;
  }

  setColors(colors: ColorPalette): void {
    this.colors = colors;
  }

  invalidate(): void {}

  /**
   * Subscribe to a live feed of wire events that affect footer-visible
   * fields (context usage / model). Each event patches the local state
   * and fires `requestRender` so the TUI repaints. Returns a disposer
   * that removes all registered listeners.
   *
   * Called once by the host (InteractiveMode) at boot. Tests can pass a
   * minimal stub for `handlers` and a spy for `requestRender` to assert
   * reactivity without standing up the full TUI.
   */
  attach(handlers: FooterFeedHandlers, requestRender: () => void): () => void {
    const unsubStatus = handlers.onStatusUpdate((data) => {
      const patch: Partial<AppState> = {};
      if (data.context_usage !== undefined) {
        const percent = data.context_usage.percent;
        patch.contextUsage = Number.isFinite(percent) ? percent / 100 : 0;
      }
      if (data.context_tokens !== undefined) patch.contextTokens = data.context_tokens;
      if (data.max_context_tokens !== undefined) patch.maxContextTokens = data.max_context_tokens;
      if (data.plan_mode !== undefined) patch.planMode = data.plan_mode;
      if (data.model !== undefined) patch.model = data.model;
      if (Object.keys(patch).length > 0) {
        this.state = { ...this.state, ...patch };
      }
      requestRender();
    });
    const unsubMeta = handlers.onSessionMetaChanged((_data) => {
      // SessionMeta wire-truth fields (title/tags/description/archived/color)
      // do not feed the current footer layout. Re-render anyway so callers
      // see the footer stay in sync with the broader UI state.
      requestRender();
    });
    this.subscriptions.push(unsubStatus, unsubMeta);
    return () => {
      for (const dispose of this.subscriptions) dispose();
      this.subscriptions = [];
    };
  }

  render(width: number): string[] {
    const colors = this.colors;
    const state = this.state;

    const thinkingDot = state.thinking ? '●' : '○';
    const modeLabel = 'agent';
    const modeText = state.model
      ? `${modeLabel} (${state.model} ${thinkingDot})`
      : modeLabel;

    const cwd = shortenCwd(state.workDir);
    const tips = '/help: show commands';

    const parts: string[] = [];
    if (state.yolo) parts.push(chalk.hex(colors.warning).bold('yolo'));
    if (state.planMode) parts.push(chalk.hex(colors.primary).bold('plan'));
    parts.push(chalk.hex(colors.text)(modeText));
    parts.push(chalk.hex(colors.status)(cwd));
    parts.push(chalk.hex(colors.textMuted)(tips));
    const flagsLine = parts.join(' ');

    const contextText = formatContextStatus(
      state.contextUsage,
      state.contextTokens,
      state.maxContextTokens,
    );
    const ctxClr = contextColor(state.contextUsage, colors);
    const contextStr = chalk.hex(ctxClr)(contextText);

    const flagsWidth = visibleWidth(flagsLine);
    const contextWidth = visibleWidth(contextStr);
    const availableForPadding = width - flagsWidth - contextWidth;

    let contextLine: string;
    if (availableForPadding >= 1) {
      contextLine = flagsLine + ' '.repeat(availableForPadding) + contextStr;
    } else {
      const budget = Math.max(0, width - contextWidth - 1);
      if (budget > 0) {
        contextLine = truncateToWidth(flagsLine, budget, '…') + ' ' + contextStr;
      } else {
        contextLine = truncateToWidth(contextStr, width, '…');
      }
    }

    return [truncateToWidth(contextLine, width)];
  }
}
