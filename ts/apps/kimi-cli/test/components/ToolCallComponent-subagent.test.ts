import { describe, it, expect } from 'vitest';

import { ToolCallComponent } from '../../src/components/ToolCallComponent.js';
import { darkColors } from '../../src/theme/colors.js';
import type { ToolCallBlockData } from '../../src/app/state.js';

function makeToolCall(overrides?: Partial<ToolCallBlockData>): ToolCallBlockData {
  return {
    id: 'tc_parent',
    name: 'Task',
    args: { description: 'explore files' },
    ...overrides,
  };
}

function strip(text: string): string {
  // Strip ANSI for substring assertions.
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

function renderAll(component: ToolCallComponent, width = 100): string {
  return component.children
    .map((c) => c.render(width).join('\n'))
    .join('\n');
}

describe('ToolCallComponent subagent rendering', () => {
  it('shows subagent metadata line once setSubagentMeta is called', () => {
    const tc = new ToolCallComponent(makeToolCall(), undefined, darkColors);
    tc.setSubagentMeta('sub_abc123def', 'explore');
    const out = strip(renderAll(tc));
    expect(out).toMatch(/subagent explore \(sub_abc123…?\)/);
  });

  it('renders finished sub tool calls as "Used" lines', () => {
    const tc = new ToolCallComponent(makeToolCall(), undefined, darkColors);
    tc.setSubagentMeta('sub_x', 'explore');
    tc.appendSubToolCall({ id: 'sub_tc_1', name: 'Grep', args: { pattern: 'foo' } });
    tc.finishSubToolCall({ tool_call_id: 'sub_tc_1', output: 'match' });
    const out = strip(renderAll(tc));
    expect(out).toMatch(/Used Grep/);
    expect(out).toMatch(/\(foo\)/);
  });

  it('shows ongoing sub tool calls as "Using" lines until they finish', () => {
    const tc = new ToolCallComponent(makeToolCall(), undefined, darkColors);
    tc.setSubagentMeta('sub_x', 'explore');
    tc.appendSubToolCall({ id: 'sub_tc_live', name: 'Read', args: { path: '/tmp/x' } });
    expect(strip(renderAll(tc))).toMatch(/Using Read/);
    tc.finishSubToolCall({ tool_call_id: 'sub_tc_live', output: 'done' });
    const after = strip(renderAll(tc));
    expect(after).toMatch(/Used Read/);
    expect(after).not.toMatch(/Using Read/);
  });

  it('caps finished sub tool calls at 4 and surfaces "N more ..." for the rest', () => {
    const tc = new ToolCallComponent(makeToolCall(), undefined, darkColors);
    tc.setSubagentMeta('sub_x');
    for (let i = 0; i < 6; i++) {
      tc.appendSubToolCall({ id: `tc_${String(i)}`, name: 'Grep', args: { pattern: `p${String(i)}` } });
      tc.finishSubToolCall({ tool_call_id: `tc_${String(i)}`, output: 'ok' });
    }
    const out = strip(renderAll(tc));
    expect(out).toMatch(/2 more tool calls \.\.\./);
    // Only the last 4 patterns remain visible.
    expect(out).toMatch(/\(p2\)/);
    expect(out).toMatch(/\(p5\)/);
    expect(out).not.toMatch(/\(p0\)/);
  });

  it('marks error sub tool calls with ✗ instead of •', () => {
    const tc = new ToolCallComponent(makeToolCall(), undefined, darkColors);
    tc.setSubagentMeta('sub_x');
    tc.appendSubToolCall({ id: 'e', name: 'Bash', args: { command: 'exit 1' } });
    tc.finishSubToolCall({ tool_call_id: 'e', output: 'oops', is_error: true });
    const out = strip(renderAll(tc));
    expect(out).toMatch(/✗ Used Bash/);
  });

  it('keeps non-subagent tool calls untouched (no ↳ line)', () => {
    const tc = new ToolCallComponent(makeToolCall({ name: 'Read' }), undefined, darkColors);
    const out = strip(renderAll(tc));
    expect(out).not.toMatch(/subagent/);
    expect(out).not.toMatch(/↳/);
  });

  // ── Slice 5.3 T6 — Agent header key-argument preview ──────────────────
  //
  // Red bar today: `extractKeyArgument`'s `keyMap` in ToolCallComponent.ts
  // does not list `Agent` (gap G6 / Change C6.1). Without that entry the
  // function falls back to `Object.keys(args)`, which — with the current
  // AgentToolInput shape — yields `prompt` first, so the header previews
  // the full LLM prompt rather than the short `description`. Once C6.1
  // lands `keyMap.Agent = ['description', 'prompt']`, this test flips to
  // green.
  it("Agent tool header prefers `description` over `prompt`", () => {
    const tc = new ToolCallComponent(
      makeToolCall({
        id: 'tc_agent_kmap',
        name: 'Agent',
        args: {
          // `prompt` is deliberately listed first so the keyless fallback
          // path (Object.keys order) would surface it. The keyMap entry
          // must override to pick `description` first.
          prompt: 'Find all auth code under src/ and report findings',
          description: 'Explore auth module',
        },
      }),
      undefined,
      darkColors,
    );
    const out = strip(renderAll(tc));
    expect(out).toMatch(/\(Explore auth module\)/);
    expect(out).not.toMatch(/Find all auth code/);
  });
});
