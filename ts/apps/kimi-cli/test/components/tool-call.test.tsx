/**
 * ToolCallBlock, ToolResultBlock, and DiffPreview component tests.
 *
 * Wire 2.1: ToolCallBlockData uses `name` and `args` (parsed object)
 * instead of the old `function.name` and `function.arguments` (JSON string).
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';

import ToolCallBlock, {
  extractKeyArgument,
  truncate,
  renderDisplaySummary,
} from '../../src/components/message/ToolCallBlock.js';
import ToolResultBlock from '../../src/components/message/ToolResultBlock.js';
import DiffPreview, {
  computeDiffLines,
  diffStats,
} from '../../src/components/approval/DiffPreview.js';

import type { ToolCallBlockData, ToolResultBlockData } from '../../src/app/context.js';
import type { DiffDisplayBlock } from '../../src/wire/index.js';
import type { DiffPreviewBlock } from '../../src/components/approval/DiffPreview.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makeToolCall(name: string, args: Record<string, unknown> = {}): ToolCallBlockData {
  return {
    id: `tc-${name}`,
    name,
    args,
  };
}

function makeToolResult(overrides?: Partial<ToolResultBlockData>): ToolResultBlockData {
  return {
    tool_call_id: 'tc-test',
    output: 'success output',
    is_error: false,
    ...overrides,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── extractKeyArgument ──────────────────────────────────────────────

describe('extractKeyArgument', () => {
  it('extracts command for Shell tool', () => {
    const result = extractKeyArgument('Shell', { command: 'ls -la' });
    expect(result).toBe('ls -la');
  });

  it('extracts path for ReadFile tool', () => {
    const result = extractKeyArgument('ReadFile', { path: '/foo/bar.ts' });
    expect(result).toBe('/foo/bar.ts');
  });

  it('extracts url for FetchURL tool', () => {
    const result = extractKeyArgument('FetchURL', { url: 'https://example.com' });
    expect(result).toBe('https://example.com');
  });

  it('returns null for empty args', () => {
    expect(extractKeyArgument('Shell', {})).toBe(null);
  });

  it('truncates long arguments', () => {
    const longCmd = 'a'.repeat(100);
    const result = extractKeyArgument('Shell', { command: longCmd });
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(60);
    expect(result!.endsWith('...')).toBe(true);
  });

  it('falls back to first string value for unknown tools', () => {
    const result = extractKeyArgument('MyCustomTool', { query: 'test query' });
    expect(result).toBe('test query');
  });
});

// ── truncate ────────────────────────────────────────────────────────

describe('truncate', () => {
  it('returns short text unchanged', () => {
    expect(truncate('short', 60)).toBe('short');
  });

  it('truncates long text with ellipsis', () => {
    const long = 'x'.repeat(100);
    const result = truncate(long, 20);
    expect(result.length).toBe(20);
    expect(result.endsWith('...')).toBe(true);
  });

  it('uses only first line of multiline text', () => {
    expect(truncate('line1\nline2\nline3', 60)).toBe('line1');
  });
});

// ── renderDisplaySummary ────────────────────────────────────────────

describe('renderDisplaySummary', () => {
  it('renders brief display blocks', () => {
    const lines = renderDisplaySummary([{ type: 'brief', text: 'Wrote hello.py' }]);
    expect(lines).toEqual(['Wrote hello.py']);
  });

  it('renders shell display blocks with $ prefix', () => {
    const lines = renderDisplaySummary([
      { type: 'shell', language: 'bash', command: 'ls -la' },
    ]);
    expect(lines).toEqual(['$ ls -la']);
  });

  it('renders diff display blocks with file path', () => {
    const lines = renderDisplaySummary([
      {
        type: 'diff',
        path: 'hello.py',
        old_text: '',
        new_text: 'print("hello")\n',
      },
    ]);
    expect(lines).toEqual(['hello.py']);
  });

  it('skips empty brief blocks', () => {
    const lines = renderDisplaySummary([{ type: 'brief', text: '' }]);
    expect(lines).toEqual([]);
  });
});

// ── ToolCallBlock ────────────────────────────────────────────────────

describe('ToolCallBlock', () => {
  it('displays tool name', () => {
    const tc = makeToolCall('Shell', { command: 'ls' });
    const { lastFrame, unmount } = render(<ToolCallBlock toolCall={tc} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Shell');
    unmount();
  });

  it('displays "Using" when pending (no result)', () => {
    const tc = makeToolCall('ReadFile', { path: 'foo.ts' });
    const { lastFrame, unmount } = render(<ToolCallBlock toolCall={tc} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Using');
    expect(frame).toContain('ReadFile');
    unmount();
  });

  it('displays "Used" when finished with result', () => {
    const tc = makeToolCall('Shell', { command: 'echo hi' });
    const result = makeToolResult();
    const { lastFrame, unmount } = render(
      <ToolCallBlock toolCall={tc} result={result} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Used');
    expect(frame).toContain('Shell');
    unmount();
  });

  it('shows key argument in parentheses', () => {
    const tc = makeToolCall('Shell', { command: 'git status' });
    const { lastFrame, unmount } = render(<ToolCallBlock toolCall={tc} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('git status');
    unmount();
  });

  it('displays dots spinner when pending', async () => {
    const tc = makeToolCall('Shell', { command: 'ls' });
    const { lastFrame, unmount } = render(<ToolCallBlock toolCall={tc} />);

    await wait(200);
    const frame = lastFrame() ?? '';
    const dotsFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    const hasDots = dotsFrames.some((d) => frame.includes(d));
    expect(hasDots).toBe(true);
    unmount();
  });

  it('does not show dots spinner when finished', () => {
    const tc = makeToolCall('Shell', { command: 'ls' });
    const result = makeToolResult();
    const { lastFrame, unmount } = render(
      <ToolCallBlock toolCall={tc} result={result} />,
    );
    const frame = lastFrame() ?? '';
    const dotsFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    const hasDots = dotsFrames.some((d) => frame.includes(d));
    expect(hasDots).toBe(false);
    unmount();
  });

  it('shows error status for failed result', () => {
    const tc = makeToolCall('Shell', { command: 'bad-cmd' });
    const result = makeToolResult({ is_error: true });
    const { lastFrame, unmount } = render(
      <ToolCallBlock toolCall={tc} result={result} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('\u2717');
    unmount();
  });

  it('shows green bullet for successful result', () => {
    const tc = makeToolCall('Shell', { command: 'ls' });
    const result = makeToolResult({ is_error: false });
    const { lastFrame, unmount } = render(
      <ToolCallBlock toolCall={tc} result={result} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('\u25CF');
    unmount();
  });
});

// ── ToolResultBlock ──────────────────────────────────────────────────

describe('ToolResultBlock', () => {
  it('displays tool name for success', () => {
    const result = makeToolResult();
    const { lastFrame, unmount } = render(
      <ToolResultBlock toolName="Shell" result={result} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Shell');
    expect(frame).toContain('\u2713');
    unmount();
  });

  it('displays error indicator for failed result', () => {
    const result = makeToolResult({ is_error: true });
    const { lastFrame, unmount } = render(
      <ToolResultBlock toolName="Write" result={result} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Write');
    expect(frame).toContain('\u2717');
    unmount();
  });

  it('truncates long output', () => {
    const longOutput = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    const result = makeToolResult({ output: longOutput });
    const { lastFrame, unmount } = render(
      <ToolResultBlock toolName="Shell" result={result} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('line 1');
    expect(frame).toContain('more lines');
    unmount();
  });
});

// ── DiffPreview ──────────────────────────────────────────────────────

describe('DiffPreview', () => {
  it('renders added lines in green with + marker', () => {
    const block: DiffPreviewBlock = {
      type: 'diff',
      path: 'hello.py',
      oldText: '',
      newText: 'print("Hello, World!")\n',
    };
    const { lastFrame, unmount } = render(<DiffPreview block={block} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('+');
    expect(frame).toContain('print("Hello, World!")');
    expect(frame).toContain('hello.py');
    unmount();
  });

  it('renders deleted lines with - marker', () => {
    const block: DiffPreviewBlock = {
      type: 'diff',
      path: 'old.py',
      oldText: 'old line\n',
      newText: '',
    };
    const { lastFrame, unmount } = render(<DiffPreview block={block} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('-');
    expect(frame).toContain('old line');
    unmount();
  });

  it('renders file path and stats in header', () => {
    const block: DiffPreviewBlock = {
      type: 'diff',
      path: 'src/index.ts',
      oldText: 'old\n',
      newText: 'new\n',
    };
    const { lastFrame, unmount } = render(<DiffPreview block={block} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('src/index.ts');
    expect(frame).toContain('+1');
    expect(frame).toContain('-1');
    unmount();
  });

  it('shows overflow indicator when too many changed lines', () => {
    const oldText = Array.from({ length: 20 }, (_, i) => `old ${i}`).join('\n');
    const newText = Array.from({ length: 20 }, (_, i) => `new ${i}`).join('\n');
    const block: DiffPreviewBlock = {
      type: 'diff',
      path: 'big.py',
      oldText,
      newText,
      oldStart: 1,
      newStart: 1,
    };
    const { lastFrame, unmount } = render(<DiffPreview block={block} maxLines={5} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('more lines');
    unmount();
  });
});

// ── computeDiffLines ─────────────────────────────────────────────────

describe('computeDiffLines', () => {
  it('marks all lines as added for new file', () => {
    const lines = computeDiffLines('', 'line1\nline2');
    expect(lines.every((l) => l.kind === 'add')).toBe(true);
    expect(lines.length).toBe(2);
  });

  it('marks all lines as deleted when removing content', () => {
    const lines = computeDiffLines('line1\nline2', '');
    expect(lines.every((l) => l.kind === 'delete')).toBe(true);
    expect(lines.length).toBe(2);
  });

  it('marks matching lines as context', () => {
    const lines = computeDiffLines('same\n', 'same\n');
    const contextLines = lines.filter((l) => l.kind === 'context');
    expect(contextLines.length).toBeGreaterThanOrEqual(1);
  });

  it('produces both add and delete for replacements', () => {
    const lines = computeDiffLines('old\n', 'new\n');
    const adds = lines.filter((l) => l.kind === 'add');
    const dels = lines.filter((l) => l.kind === 'delete');
    expect(adds.length).toBeGreaterThanOrEqual(1);
    expect(dels.length).toBeGreaterThanOrEqual(1);
  });
});

// ── diffStats ────────────────────────────────────────────────────────

describe('diffStats', () => {
  it('counts added and removed lines', () => {
    const lines = computeDiffLines('old\n', 'new\nadded\n');
    const stats = diffStats(lines);
    expect(stats.added).toBeGreaterThanOrEqual(1);
    expect(stats.removed).toBeGreaterThanOrEqual(1);
  });

  it('returns zeros for identical content', () => {
    const lines = computeDiffLines('same\n', 'same\n');
    const stats = diffStats(lines);
    expect(stats.added).toBe(0);
    expect(stats.removed).toBe(0);
  });
});
