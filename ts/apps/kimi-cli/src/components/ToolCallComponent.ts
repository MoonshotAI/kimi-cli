/**
 * Renders a tool call entry in the transcript.
 * Supports expand/collapse via Ctrl+O.
 */

import { Container, Text, Spacer } from '@mariozechner/pi-tui';
import type { MarkdownTheme, TUI } from '@mariozechner/pi-tui';
import chalk from 'chalk';
import { highlight } from 'cli-highlight';
import { extname } from 'node:path';
import type { ToolCallBlockData, ToolResultBlockData } from '../app/state.js';
import type { ColorPalette } from '../theme/colors.js';
import { renderDiffLines } from './DiffPreviewComponent.js';
import { PlanBoxComponent } from './PlanBoxComponent.js';

const MAX_ARG_LENGTH = 60;
const PREVIEW_LINES = 6;
const CALL_PREVIEW_LINES = 10;
const BLINK_INTERVAL = 500;
const MAX_SUB_TOOL_CALLS_SHOWN = 4;

interface FinishedSubCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly output: string;
  readonly isError: boolean;
}

interface OngoingSubCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function langFromPath(filePath: string): string | undefined {
  const ext = extname(filePath).slice(1);
  if (ext.length === 0) return undefined;
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java',
    sh: 'bash', bash: 'bash', zsh: 'bash', json: 'json', yaml: 'yaml',
    yml: 'yaml', toml: 'toml', md: 'markdown', css: 'css', html: 'html',
    sql: 'sql', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
  };
  return map[ext] ?? ext;
}

function highlightLines(code: string, lang: string | undefined): string[] {
  if (!lang) return code.split('\n');
  try {
    return highlight(code, { language: lang, ignoreIllegals: true }).split('\n');
  } catch {
    return code.split('\n');
  }
}

function extractKeyArgument(toolName: string, args: Record<string, unknown>): string | null {
  const keyMap: Record<string, string[]> = {
    Shell: ['command'],
    Bash: ['command'],
    ReadFile: ['path', 'file_path'],
    Read: ['path', 'file_path'],
    Write: ['path', 'file_path'],
    WriteFile: ['path', 'file_path'],
    Edit: ['path', 'file_path'],
    EditFile: ['path', 'file_path'],
    Grep: ['pattern'],
    Glob: ['pattern'],
    FetchURL: ['url'],
    WebSearch: ['query'],
  };

  const candidates = keyMap[toolName] ?? Object.keys(args);
  for (const key of candidates) {
    const val = args[key];
    if (typeof val === 'string' && val.length > 0) {
      const firstLine = val.split('\n')[0] ?? val;
      return firstLine.length <= MAX_ARG_LENGTH
        ? firstLine
        : firstLine.slice(0, MAX_ARG_LENGTH - 3) + '...';
    }
  }
  return null;
}

export class ToolCallComponent extends Container {
  private expanded = false;
  private toolCall: ToolCallBlockData;
  private result: ToolResultBlockData | undefined;
  private colors: ColorPalette;
  private ui: TUI | undefined;
  private markdownTheme: MarkdownTheme | undefined;
  private blinkOn = true;
  private blinkTimer: ReturnType<typeof setInterval> | null = null;
  private headerText: Text;
  private callPreviewEndIndex = 0;

  // ── Subagent state ───────────────────────────────────────────────
  //
  // Populated by `setSubagentMeta` / `appendSubToolCall` / `finishSubToolCall`
  // when the WireHandler routes a `subagent.event` with this tool call
  // id as its `parent_tool_call_id`. Rendered at the tail of
  // buildContent so it shows up both during streaming and after the
  // parent tool call resolves.
  private subagentAgentId: string | undefined;
  private subagentAgentName: string | undefined;
  private readonly ongoingSubCalls = new Map<string, OngoingSubCall>();
  private readonly finishedSubCalls: FinishedSubCall[] = [];
  private hiddenSubCallCount = 0;

  constructor(
    toolCall: ToolCallBlockData,
    result: ToolResultBlockData | undefined,
    colors: ColorPalette,
    ui?: TUI,
    markdownTheme?: MarkdownTheme,
  ) {
    super();
    this.toolCall = toolCall;
    this.result = result;
    this.colors = colors;
    this.ui = ui;
    this.markdownTheme = markdownTheme;

    this.addChild(new Spacer(1));
    this.headerText = new Text(this.buildHeader(), 0, 0);
    this.addChild(this.headerText);
    this.buildCallPreview();
    this.callPreviewEndIndex = this.children.length;
    this.buildContent();
    this.buildSubagentBlock();

    // ExitPlanMode is rendered as a static, bullet-less block — don't
    // blink the header and don't let the spinner repaint cause reflow.
    if (result === undefined && ui && toolCall.name !== 'ExitPlanMode') {
      this.startBlink();
    }
  }

  private startBlink(): void {
    this.blinkTimer = setInterval(() => {
      this.blinkOn = !this.blinkOn;
      this.headerText.setText(this.buildHeader());
      this.ui?.requestRender();
    }, BLINK_INTERVAL);
  }

  private stopBlink(): void {
    if (this.blinkTimer) {
      clearInterval(this.blinkTimer);
      this.blinkTimer = null;
    }
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    this.rebuildContent();
  }

  setResult(result: ToolResultBlockData): void {
    this.result = result;
    this.stopBlink();
    this.headerText.setText(this.buildHeader());
    this.rebuildContent();
  }

  // ── Subagent API (called by WireHandler routing) ─────────────────

  setSubagentMeta(agentId: string, agentName?: string): void {
    if (this.subagentAgentId === agentId && this.subagentAgentName === agentName) return;
    this.subagentAgentId = agentId;
    this.subagentAgentName = agentName;
    this.rebuildContent();
    this.ui?.requestRender();
  }

  appendSubToolCall(call: { id: string; name: string; args: Record<string, unknown> }): void {
    this.ongoingSubCalls.set(call.id, { name: call.name, args: call.args });
    this.rebuildContent();
    this.ui?.requestRender();
  }

  finishSubToolCall(result: {
    tool_call_id: string;
    output: string;
    is_error?: boolean | undefined;
  }): void {
    const ongoing = this.ongoingSubCalls.get(result.tool_call_id);
    if (ongoing === undefined) return;
    this.ongoingSubCalls.delete(result.tool_call_id);
    this.finishedSubCalls.push({
      name: ongoing.name,
      args: ongoing.args,
      output: result.output,
      isError: result.is_error ?? false,
    });
    while (this.finishedSubCalls.length > MAX_SUB_TOOL_CALLS_SHOWN) {
      this.finishedSubCalls.shift();
      this.hiddenSubCallCount += 1;
    }
    this.rebuildContent();
    this.ui?.requestRender();
  }

  private buildHeader(): string {
    const { toolCall, result, colors } = this;
    const isFinished = result !== undefined;
    const isError = result?.is_error ?? false;

    let bullet: string;
    if (isFinished) {
      bullet = isError
        ? chalk.hex(colors.error)('✗ ')
        : chalk.hex(colors.success)('● ');
    } else {
      bullet = this.blinkOn ? chalk.white('● ') : '  ';
    }

    if (toolCall.name === 'ExitPlanMode') {
      return chalk.hex(colors.primary).bold('Current plan');
    }

    const verb = isFinished ? 'Used' : 'Using';
    const keyArg = extractKeyArgument(toolCall.name, toolCall.args);
    const toolRef = chalk.hex(colors.primary).bold(toolCall.name);
    const argStr = keyArg ? chalk.dim(` (${keyArg})`) : '';
    return `${bullet}${verb} ${toolRef}${argStr}`;
  }

  private rebuildContent(): void {
    while (this.children.length > this.callPreviewEndIndex) {
      this.children.pop();
    }
    this.buildContent();
    this.buildSubagentBlock();
  }

  private buildSubagentBlock(): void {
    if (
      this.subagentAgentId === undefined &&
      this.ongoingSubCalls.size === 0 &&
      this.finishedSubCalls.length === 0
    ) {
      return;
    }

    const dim = chalk.dim;
    const header = this.subagentAgentName !== undefined
      ? `subagent ${this.subagentAgentName} (${this.formatAgentId()})`
      : `subagent (${this.formatAgentId()})`;
    this.addChild(new Text(dim(`  ↳ ${header}`), 0, 0));

    if (this.hiddenSubCallCount > 0) {
      const suffix = this.hiddenSubCallCount > 1 ? 's' : '';
      this.addChild(new Text(
        dim.italic(`    ${String(this.hiddenSubCallCount)} more tool call${suffix} ...`),
        0, 0,
      ));
    }

    for (const sub of this.finishedSubCalls) {
      const mark = sub.isError
        ? chalk.hex(this.colors.error)('✗')
        : chalk.hex(this.colors.success)('•');
      const keyArg = extractKeyArgument(sub.name, sub.args);
      const nameCol = chalk.hex(this.colors.primary)(sub.name);
      const argCol = keyArg ? dim(` (${keyArg})`) : '';
      this.addChild(new Text(`    ${mark} Used ${nameCol}${argCol}`, 0, 0));
    }

    for (const [id, call] of this.ongoingSubCalls) {
      const keyArg = extractKeyArgument(call.name, call.args);
      const nameCol = chalk.hex(this.colors.primary)(call.name);
      const argCol = keyArg ? dim(` (${keyArg})`) : '';
      void id;
      this.addChild(new Text(`    ${dim('…')} Using ${nameCol}${argCol}`, 0, 0));
    }
  }

  private formatAgentId(): string {
    const id = this.subagentAgentId ?? '';
    return id.length > 10 ? id.slice(0, 10) + '…' : id;
  }

  private buildCallPreview(): void {
    const name = this.toolCall.name;
    if (name === 'ExitPlanMode') {
      this.buildPlanPreview();
      return;
    }
    if (name === 'Write' || name === 'WriteFile') {
      const content = str(this.toolCall.args['content']);
      if (content.length === 0) return;
      const filePath = str(this.toolCall.args['file_path'] ?? this.toolCall.args['path']);
      const lang = langFromPath(filePath);
      const allLines = highlightLines(content, lang);
      const shown = allLines.slice(0, CALL_PREVIEW_LINES);
      const remaining = allLines.length - shown.length;
      for (let i = 0; i < shown.length; i++) {
        const lineNum = chalk.dim(String(i + 1).padStart(4) + '  ');
        this.addChild(new Text(lineNum + shown[i]!, 2, 0));
      }
      if (remaining > 0) {
        this.addChild(new Text(
          chalk.dim(`... (${String(remaining)} more lines, ${String(allLines.length)} total)`),
          2, 0,
        ));
      }
    } else if (name === 'Edit' || name === 'EditFile') {
      const oldStr = str(this.toolCall.args['old_string']);
      const newStr = str(this.toolCall.args['new_string']);
      if (oldStr.length === 0 && newStr.length === 0) return;
      const filePath = str(this.toolCall.args['file_path'] ?? this.toolCall.args['path']);
      const allLines = renderDiffLines(oldStr, newStr, filePath);
      const shown = allLines.slice(0, CALL_PREVIEW_LINES);
      const remaining = allLines.length - shown.length;
      for (const line of shown) {
        this.addChild(new Text(line, 2, 0));
      }
      if (remaining > 0) {
        this.addChild(new Text(
          chalk.dim(`... (${String(remaining)} more lines)`),
          2, 0,
        ));
      }
    }
  }

  private buildPlanPreview(): void {
    const plan = str(this.toolCall.args['plan']);
    if (plan.length === 0 || this.markdownTheme === undefined) return;
    this.addChild(new PlanBoxComponent(plan, this.markdownTheme, this.colors.success));
  }

  private buildContent(): void {
    const { result } = this;
    if (result === undefined || !result.output) return;

    // ExitPlanMode: the plan is already shown statically via
    // buildPlanPreview (from args.plan at call-start time). Skip the
    // "Exited plan mode. Plan: …" result.output dump to avoid duplication.
    if (this.toolCall.name === 'ExitPlanMode' && !result.is_error) {
      return;
    }

    if (this.toolCall.name === 'AskUserQuestion' && !result.is_error) {
      if (this.renderAskUserQuestionResult(result.output)) return;
    }

    const lines = result.output.split('\n');
    if (this.expanded) {
      this.addChild(new Text(chalk.dim(result.output), 2, 0));
    } else {
      const shown = lines.slice(0, PREVIEW_LINES);
      const remaining = lines.length - shown.length;
      this.addChild(new Text(chalk.dim(shown.join('\n')), 2, 0));
      if (remaining > 0) {
        this.addChild(new Text(
          chalk.dim(`... (${String(remaining)} more lines, ctrl+o to expand)`),
          2, 0,
        ));
      }
    }
  }

  /**
   * Render AskUserQuestion's JSON payload as a friendly Q/A list.
   * Returns true on success (caller skips the default JSON dump);
   * false on parse failure (caller falls back to raw display).
   */
  private renderAskUserQuestionResult(output: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      return false;
    }
    if (typeof parsed !== 'object' || parsed === null) return false;

    const colors = this.colors;
    const dim = chalk.dim;
    const accent = chalk.hex(colors.primary);

    const answers = (parsed as { answers?: unknown }).answers;
    const note = (parsed as { note?: unknown }).note;

    const hasAnswers =
      typeof answers === 'object' && answers !== null && Object.keys(answers).length > 0;

    if (!hasAnswers) {
      const noteText = typeof note === 'string' && note.length > 0
        ? note
        : 'User dismissed the question.';
      this.addChild(new Text(dim(`  ${noteText}`), 0, 0));
      return true;
    }

    for (const [question, answer] of Object.entries(answers as Record<string, unknown>)) {
      const answerText = typeof answer === 'string' ? answer : JSON.stringify(answer);
      this.addChild(new Text(`  ${dim('Q')}  ${question}`, 0, 0));
      this.addChild(new Text(`  ${accent('→')}  ${answerText}`, 0, 0));
    }
    return true;
  }
}
