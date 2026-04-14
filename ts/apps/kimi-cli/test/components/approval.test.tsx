/**
 * ApprovalPanel component tests.
 *
 * Tests the approval panel rendering, keyboard navigation, shortcuts,
 * and the feedback input mode.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';

import ApprovalPanel from '../../src/components/approval/ApprovalPanel.js';

import type { ApprovalRequestEvent, ApprovalResponsePayload } from '@moonshot-ai/kimi-wire-mock';

// ── Helpers ──────────────────────────────────────────────────────────

function makeApprovalRequest(overrides?: Partial<ApprovalRequestEvent>): ApprovalRequestEvent {
  return {
    type: 'ApprovalRequest',
    id: 'apr-test-001',
    toolCallId: 'tc-test-001',
    sender: 'Write',
    action: 'write file',
    description: 'Write hello.py with a greeting script',
    display: [],
    ...overrides,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Tests ────────────────────────────────────────────────────────────

describe('ApprovalPanel', () => {
  let onResponse: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onResponse = vi.fn();
  });

  it('renders all 4 options', () => {
    const request = makeApprovalRequest();
    const { lastFrame, unmount } = render(
      <ApprovalPanel request={request} onResponse={onResponse} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Approve once');
    expect(frame).toContain('Approve for this session');
    expect(frame).toContain('Reject');
    expect(frame).toContain('Reject with feedback');
    unmount();
  });

  it('renders the approval request description', () => {
    const request = makeApprovalRequest({
      sender: 'Write',
      action: 'write file',
      description: 'Write hello.py with a greeting script',
    });
    const { lastFrame, unmount } = render(
      <ApprovalPanel request={request} onResponse={onResponse} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Write');
    expect(frame).toContain('write file');
    expect(frame).toContain('hello.py');
    unmount();
  });

  it('renders the title "approval"', () => {
    const request = makeApprovalRequest();
    const { lastFrame, unmount } = render(
      <ApprovalPanel request={request} onResponse={onResponse} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('approval');
    unmount();
  });

  it('shows keyboard hints', () => {
    const request = makeApprovalRequest();
    const { lastFrame, unmount } = render(
      <ApprovalPanel request={request} onResponse={onResponse} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('select');
    expect(frame).toContain('confirm');
    unmount();
  });

  it('first option is selected by default (has arrow marker)', () => {
    const request = makeApprovalRequest();
    const { lastFrame, unmount } = render(
      <ApprovalPanel request={request} onResponse={onResponse} />,
    );
    const frame = lastFrame() ?? '';
    // The arrow (\u2192) should appear before [1]
    expect(frame).toContain('\u2192 [1]');
    unmount();
  });

  // ── Arrow key navigation ──────────────────────────────────────────

  it('down arrow moves selection to next option', async () => {
    const request = makeApprovalRequest();
    const { lastFrame, stdin, unmount } = render(
      <ApprovalPanel request={request} onResponse={onResponse} />,
    );

    // Press down arrow (ESC [ B)
    stdin.write('\x1B[B');
    await wait(50);

    const frame = lastFrame() ?? '';
    // Second option should now have the arrow marker
    expect(frame).toContain('\u2192 [2]');
    unmount();
  });

  it('up arrow wraps to last option from first', async () => {
    const request = makeApprovalRequest();
    const { lastFrame, stdin, unmount } = render(
      <ApprovalPanel request={request} onResponse={onResponse} />,
    );

    // Press up arrow (ESC [ A)
    stdin.write('\x1B[A');
    await wait(50);

    const frame = lastFrame() ?? '';
    // Last option (4) should be selected
    expect(frame).toContain('\u2192 [4]');
    unmount();
  });

  it('down arrow wraps to first option from last', async () => {
    const request = makeApprovalRequest();
    const { lastFrame, stdin, unmount } = render(
      <ApprovalPanel request={request} onResponse={onResponse} />,
    );

    // Navigate down 4 times to wrap around
    for (let i = 0; i < 4; i++) {
      stdin.write('\x1B[B');
      await wait(20);
    }

    const frame = lastFrame() ?? '';
    expect(frame).toContain('\u2192 [1]');
    unmount();
  });

  // ── Enter key confirms ────────────────────────────────────────────

  it('Enter key triggers "approve" for first option', async () => {
    const request = makeApprovalRequest();
    const { stdin, unmount } = render(
      <ApprovalPanel request={request} onResponse={onResponse} />,
    );

    stdin.write('\r');
    await wait(50);

    expect(onResponse).toHaveBeenCalledWith({
      decision: 'approve',
      feedback: undefined,
    });
    unmount();
  });

  it('Enter key triggers "approve_for_session" for second option', async () => {
    const request = makeApprovalRequest();
    const { stdin, unmount } = render(
      <ApprovalPanel request={request} onResponse={onResponse} />,
    );

    // Navigate down to option 2
    stdin.write('\x1B[B');
    await wait(30);
    stdin.write('\r');
    await wait(50);

    expect(onResponse).toHaveBeenCalledWith({
      decision: 'approve_for_session',
      feedback: undefined,
    });
    unmount();
  });

  it('Enter key triggers "reject" for third option', async () => {
    const request = makeApprovalRequest();
    const { stdin, unmount } = render(
      <ApprovalPanel request={request} onResponse={onResponse} />,
    );

    // Navigate down twice to option 3
    stdin.write('\x1B[B');
    await wait(20);
    stdin.write('\x1B[B');
    await wait(20);
    stdin.write('\r');
    await wait(50);

    expect(onResponse).toHaveBeenCalledWith({
      decision: 'reject',
      feedback: undefined,
    });
    unmount();
  });

  // ── Number keys 1-4 ──────────────────────────────────────────────

  it('pressing 1 triggers "approve"', async () => {
    const request = makeApprovalRequest();
    const { stdin, unmount } = render(
      <ApprovalPanel request={request} onResponse={onResponse} />,
    );

    stdin.write('1');
    await wait(50);

    expect(onResponse).toHaveBeenCalledWith({
      decision: 'approve',
      feedback: undefined,
    });
    unmount();
  });

  it('pressing 2 triggers "approve_for_session"', async () => {
    const request = makeApprovalRequest();
    const { stdin, unmount } = render(
      <ApprovalPanel request={request} onResponse={onResponse} />,
    );

    stdin.write('2');
    await wait(50);

    expect(onResponse).toHaveBeenCalledWith({
      decision: 'approve_for_session',
      feedback: undefined,
    });
    unmount();
  });

  it('pressing 3 triggers "reject"', async () => {
    const request = makeApprovalRequest();
    const { stdin, unmount } = render(
      <ApprovalPanel request={request} onResponse={onResponse} />,
    );

    stdin.write('3');
    await wait(50);

    expect(onResponse).toHaveBeenCalledWith({
      decision: 'reject',
      feedback: undefined,
    });
    unmount();
  });

  it('pressing 4 enters feedback mode (does not immediately submit)', async () => {
    const request = makeApprovalRequest();
    const { lastFrame, stdin, unmount } = render(
      <ApprovalPanel request={request} onResponse={onResponse} />,
    );

    stdin.write('4');
    await wait(50);

    // Should not have submitted yet -- it enters feedback mode
    expect(onResponse).not.toHaveBeenCalled();

    // Should show feedback input indicator (block cursor)
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Reject:');
    expect(frame).toContain('Type your feedback');
    unmount();
  });

  // ── Shortcut keys y/a/n/f ────────────────────────────────────────

  it('pressing y triggers "approve"', async () => {
    const request = makeApprovalRequest();
    const { stdin, unmount } = render(
      <ApprovalPanel request={request} onResponse={onResponse} />,
    );

    stdin.write('y');
    await wait(50);

    expect(onResponse).toHaveBeenCalledWith({
      decision: 'approve',
      feedback: undefined,
    });
    unmount();
  });

  it('pressing a triggers "approve_for_session"', async () => {
    const request = makeApprovalRequest();
    const { stdin, unmount } = render(
      <ApprovalPanel request={request} onResponse={onResponse} />,
    );

    stdin.write('a');
    await wait(50);

    expect(onResponse).toHaveBeenCalledWith({
      decision: 'approve_for_session',
      feedback: undefined,
    });
    unmount();
  });

  it('pressing n triggers "reject"', async () => {
    const request = makeApprovalRequest();
    const { stdin, unmount } = render(
      <ApprovalPanel request={request} onResponse={onResponse} />,
    );

    stdin.write('n');
    await wait(50);

    expect(onResponse).toHaveBeenCalledWith({
      decision: 'reject',
      feedback: undefined,
    });
    unmount();
  });

  it('pressing f enters feedback mode', async () => {
    const request = makeApprovalRequest();
    const { lastFrame, stdin, unmount } = render(
      <ApprovalPanel request={request} onResponse={onResponse} />,
    );

    stdin.write('f');
    await wait(50);

    expect(onResponse).not.toHaveBeenCalled();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Type your feedback');
    unmount();
  });

  // ── Feedback mode ─────────────────────────────────────────────────

  it('feedback mode: typing text appears in the input', async () => {
    const request = makeApprovalRequest();
    const { lastFrame, stdin, unmount } = render(
      <ApprovalPanel request={request} onResponse={onResponse} />,
    );

    // Enter feedback mode
    stdin.write('f');
    await wait(50);

    // Type feedback
    stdin.write('please use a different approach');
    await wait(50);

    const frame = lastFrame() ?? '';
    expect(frame).toContain('please use a different approach');
    unmount();
  });

  it('feedback mode: Enter submits reject with feedback', async () => {
    const request = makeApprovalRequest();
    const { stdin, unmount } = render(
      <ApprovalPanel request={request} onResponse={onResponse} />,
    );

    // Enter feedback mode
    stdin.write('f');
    await wait(50);

    // Type feedback
    stdin.write('use readonly');
    await wait(50);

    // Press Enter to submit
    stdin.write('\r');
    await wait(50);

    expect(onResponse).toHaveBeenCalledWith({
      decision: 'reject',
      feedback: 'use readonly',
    });
    unmount();
  });

  it('feedback mode: Escape cancels feedback and returns to menu', async () => {
    const request = makeApprovalRequest();
    const { lastFrame, stdin, unmount } = render(
      <ApprovalPanel request={request} onResponse={onResponse} />,
    );

    // Enter feedback mode
    stdin.write('f');
    await wait(50);

    // Type some feedback
    stdin.write('test');
    await wait(50);

    // Press Escape to cancel
    stdin.write('\x1B');
    await wait(50);

    // Should not have submitted
    expect(onResponse).not.toHaveBeenCalled();

    // Should be back in menu mode
    const frame = lastFrame() ?? '';
    expect(frame).toContain('select');
    expect(frame).toContain('confirm');
    unmount();
  });

  it('feedback mode: backspace deletes characters', async () => {
    const request = makeApprovalRequest({
      description: 'Test approval for backspace',
    });
    const { lastFrame, stdin, unmount } = render(
      <ApprovalPanel request={request} onResponse={onResponse} />,
    );

    // Enter feedback mode
    stdin.write('f');
    await wait(50);

    // Type "abcxyz"
    stdin.write('abcxyz');
    await wait(50);

    // Backspace (delete last char)
    stdin.write('\x7F');
    await wait(50);

    const frame = lastFrame() ?? '';
    // After backspace: "abcxy" (not "abcxyz")
    expect(frame).toContain('Reject: abcxy');
    unmount();
  });

  // ── Display blocks ────────────────────────────────────────────────

  it('renders diff display blocks', () => {
    const request = makeApprovalRequest({
      display: [
        {
          type: 'diff',
          path: 'hello.py',
          oldText: '',
          newText: 'print("Hello, World!")\n',
        },
      ],
    });
    const { lastFrame, unmount } = render(
      <ApprovalPanel request={request} onResponse={onResponse} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('hello.py');
    expect(frame).toContain('print("Hello, World!")');
    unmount();
  });

  it('renders shell display blocks', () => {
    const request = makeApprovalRequest({
      display: [
        { type: 'shell', language: 'bash', command: 'rm -rf /tmp/test' },
      ],
    });
    const { lastFrame, unmount } = render(
      <ApprovalPanel request={request} onResponse={onResponse} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('$ rm -rf /tmp/test');
    unmount();
  });

  it('renders brief display blocks', () => {
    const request = makeApprovalRequest({
      display: [
        { type: 'brief', text: 'Creating new file with 10 lines' },
      ],
    });
    const { lastFrame, unmount } = render(
      <ApprovalPanel request={request} onResponse={onResponse} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Creating new file with 10 lines');
    unmount();
  });
});
