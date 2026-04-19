/**
 * ApprovalPanel — pi-tui version of the approval request UI.
 *
 * Container-based component with keyboard navigation.
 */

import { Container, Text, Spacer, matchesKey, Key, type Focusable, truncateToWidth } from '@mariozechner/pi-tui';
import chalk from 'chalk';
import type { PendingApproval } from '../app/state.js';
import type { ApprovalResponseData, DisplayBlock } from '../wire/index.js';
import { renderDiffLines } from './DiffPreviewComponent.js';

export type ApprovalDecision = 'approved' | 'approved_for_session' | 'rejected';

interface ApprovalOption {
  label: string;
  shortcut: string;
  decision: ApprovalDecision;
  isFeedback: boolean;
}

const APPROVAL_OPTIONS: ApprovalOption[] = [
  { label: 'Approve once', shortcut: 'y', decision: 'approved', isFeedback: false },
  { label: 'Approve for this session', shortcut: 'a', decision: 'approved_for_session', isFeedback: false },
  { label: 'Reject', shortcut: 'n', decision: 'rejected', isFeedback: false },
  { label: 'Reject with feedback', shortcut: 'f', decision: 'rejected', isFeedback: true },
];

function renderDisplayBlock(block: DisplayBlock): string[] {
  switch (block.type) {
    case 'diff':
      return renderDiffLines(
        block.old_text,
        block.new_text,
        block.path,
        block.old_start,
        block.new_start,
      );
    case 'shell':
      return [chalk.gray(`$ ${block.command}`)];
    case 'brief':
      return block.text ? [chalk.gray(block.text)] : [];
    default:
      return [];
  }
}

function normalizeApprovalText(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

function isDuplicateBriefBlock(block: DisplayBlock, description: string): boolean {
  if (block.type !== 'brief' || block.text.trim().length === 0) return false;
  const normalizedDescription = normalizeApprovalText(description);
  if (normalizedDescription.length === 0) return false;
  const normalizedBlockText = normalizeApprovalText(block.text);
  if (normalizedBlockText === normalizedDescription) return true;
  const blockLines = normalizedBlockText.split('\n');
  if (blockLines.length <= 1) return false;
  return normalizeApprovalText(blockLines.slice(1).join('\n')) === normalizedDescription;
}

export class ApprovalPanelComponent extends Container implements Focusable {
  focused = false;
  private selectedIndex = 0;
  private feedbackMode = false;
  private feedbackText = '';
  private onResponse: (response: ApprovalResponseData) => void;
  private request: PendingApproval;

  constructor(
    request: PendingApproval,
    onResponse: (response: ApprovalResponseData) => void,
    maxBodyHeight: number = 12,
  ) {
    super();
    this.request = request;
    this.onResponse = onResponse;
    this.buildUI(maxBodyHeight);
  }

  private buildUI(maxBodyHeight: number): void {
    this.clear();
    const { data } = this.request;

    this.addChild(new Text(chalk.yellow('─'.repeat(60)), 0, 0));
    this.addChild(new Spacer(1));
    this.addChild(new Text(chalk.yellow.bold(' approval'), 0, 0));
    this.addChild(new Spacer(1));

    const headline = data.tool_name === 'ExitPlanMode'
      ? 'Please review the proposed plan:'
      : `${data.tool_name} is requesting approval to ${data.action}:`;
    this.addChild(new Text(chalk.yellow(` ${headline}`), 0, 0));
    if (data.description) {
      this.addChild(new Text(chalk.gray(` ${data.description}`), 0, 0));
    }

    const dedupedBlocks = data.display.filter((block) => !isDuplicateBriefBlock(block, data.description));
    const maxBlocks = Math.max(1, Math.min(dedupedBlocks.length, Math.floor(maxBodyHeight / 4)));
    const visibleBlocks = dedupedBlocks.slice(0, maxBlocks);

    if (visibleBlocks.length > 0) {
      this.addChild(new Spacer(1));
      for (const block of visibleBlocks) {
        const lines = renderDisplayBlock(block);
        for (const line of lines) {
          this.addChild(new Text(` ${line}`, 0, 0));
        }
      }
      if (dedupedBlocks.length > visibleBlocks.length) {
        this.addChild(new Text(chalk.dim(` ... ${String(dedupedBlocks.length - visibleBlocks.length)} more items hidden`), 0, 0));
      }
    }

    this.addChild(new Spacer(1));
    this.updateOptions();
    this.addChild(new Spacer(1));

    const hint = this.feedbackMode
      ? chalk.dim('  Type your feedback, then press Enter to submit.')
      : chalk.dim('  ▲/▼ select  1/2/3/4 choose  y/a/n/f shortcut  ↵ confirm');
    this.addChild(new Text(hint, 0, 0));
    this.addChild(new Text(chalk.yellow('─'.repeat(60)), 0, 0));
  }

  private updateOptions(): void {
    // Options are rebuilt each time via buildUI — we rely on full rebuild on state change.
  }

  private submit(index: number, feedback: string = ''): void {
    const option = APPROVAL_OPTIONS[index];
    if (!option) return;
    this.onResponse({
      response: option.decision,
      feedback: feedback || undefined,
    });
  }

  private selectAndSubmit(index: number): void {
    const option = APPROVAL_OPTIONS[index];
    if (!option) return;
    if (option.isFeedback) {
      this.selectedIndex = index;
      this.feedbackMode = true;
      this.rebuildOptions();
    } else {
      this.submit(index);
    }
  }

  private rebuildOptions(): void {
    this.buildUI(12);
  }

  public onToggleToolExpand?: () => void;

  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl('t'))) {
      this.onToggleToolExpand?.();
      return;
    }

    if (this.feedbackMode) {
      if (matchesKey(data, Key.enter)) {
        this.submit(this.selectedIndex, this.feedbackText);
        return;
      }
      if (matchesKey(data, Key.escape)) {
        this.feedbackMode = false;
        this.feedbackText = '';
        this.rebuildOptions();
        return;
      }
      if (matchesKey(data, Key.up)) {
        this.feedbackMode = false;
        this.selectedIndex = (this.selectedIndex - 1 + APPROVAL_OPTIONS.length) % APPROVAL_OPTIONS.length;
        this.rebuildOptions();
        return;
      }
      if (matchesKey(data, Key.down)) {
        this.feedbackMode = false;
        this.selectedIndex = (this.selectedIndex + 1) % APPROVAL_OPTIONS.length;
        this.rebuildOptions();
        return;
      }
      if (matchesKey(data, Key.backspace)) {
        this.feedbackText = this.feedbackText.slice(0, -1);
        this.rebuildOptions();
        return;
      }
      if (data.length > 0 && !data.startsWith('\x1b')) {
        this.feedbackText += data;
        this.rebuildOptions();
      }
      return;
    }

    if (matchesKey(data, Key.up)) {
      this.selectedIndex = (this.selectedIndex - 1 + APPROVAL_OPTIONS.length) % APPROVAL_OPTIONS.length;
      this.rebuildOptions();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = (this.selectedIndex + 1) % APPROVAL_OPTIONS.length;
      this.rebuildOptions();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.selectAndSubmit(this.selectedIndex);
      return;
    }

    if (data === '1') { this.selectAndSubmit(0); return; }
    if (data === '2') { this.selectAndSubmit(1); return; }
    if (data === '3') { this.selectAndSubmit(2); return; }
    if (data === '4') { this.selectAndSubmit(3); return; }

    if (data === 'y') { this.selectAndSubmit(0); return; }
    if (data === 'a') { this.selectAndSubmit(1); return; }
    if (data === 'n') { this.selectAndSubmit(2); return; }
    if (data === 'f') { this.selectAndSubmit(3); return; }
  }

  override render(width: number): string[] {
    this.clear();
    const { data } = this.request;
    const lines: string[] = [];

    lines.push(chalk.yellow('─'.repeat(width)));
    lines.push(chalk.yellow.bold(' approval'));
    lines.push('');
    const headline = data.tool_name === 'ExitPlanMode'
      ? 'Please review the proposed plan:'
      : `${data.tool_name} is requesting approval to ${data.action}:`;
    lines.push(chalk.yellow(` ${headline}`));

    const dedupedBlocks = data.display.filter((block) => !isDuplicateBriefBlock(block, data.description));
    const visibleBlocks = dedupedBlocks.slice(0, 5);
    if (visibleBlocks.length > 0) {
      lines.push('');
      for (const block of visibleBlocks) {
        const blockLines = renderDisplayBlock(block);
        for (const line of blockLines) {
          lines.push(` ${line}`);
        }
      }
    } else if (data.description) {
      lines.push('');
      for (const descLine of data.description.split('\n')) {
        lines.push(chalk.gray(` ${descLine}`));
      }
    }

    lines.push('');
    for (let idx = 0; idx < APPROVAL_OPTIONS.length; idx++) {
      const option = APPROVAL_OPTIONS[idx]!;
      const isSelected = idx === this.selectedIndex;
      const num = idx + 1;

      if (this.feedbackMode && option.isFeedback && isSelected) {
        lines.push(chalk.cyan(`→ [${String(num)}] Reject: ${this.feedbackText}█`));
      } else if (isSelected) {
        lines.push(chalk.cyan(`→ [${String(num)}] ${option.label}`));
      } else {
        lines.push(chalk.gray(`  [${String(num)}] ${option.label}`));
      }
    }

    lines.push('');
    if (this.feedbackMode) {
      lines.push(chalk.dim('  Type your feedback, then press Enter to submit.'));
    } else {
      lines.push(chalk.dim('  ▲/▼ select  1/2/3/4 choose  y/a/n/f shortcut  ↵ confirm'));
    }
    lines.push(chalk.yellow('─'.repeat(width)));

    return lines.map((line) => truncateToWidth(line, width));
  }
}
