/**
 * SessionPicker component tests.
 *
 * Uses ink-testing-library to render SessionPicker and verify
 * display and keyboard navigation.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';

import SessionPicker from '../../src/components/session/SessionPicker.js';
import type { SessionInfo } from '../../src/wire/methods.js';

// ── Helpers ──────────────────────────────────────────────────────────

const baseColors = {
  primary: '#5B9BF7',
  text: '#E0E0E0',
  textDim: '#888888',
  textMuted: '#555555',
  success: '#4EC87E',
  border: '#444444',
};

function makeSessions(count: number): SessionInfo[] {
  const sessions: SessionInfo[] = [];
  for (let i = 1; i <= count; i++) {
    sessions.push({
      id: `session-${String(i).padStart(4, '0')}`,
      work_dir: `/home/user/project-${i}`,
      title: i % 2 === 0 ? `Session ${i}` : null,
      created_at: Date.now() - i * 3600_000,
      updated_at: Date.now() - i * 60_000,
      archived: false,
    });
  }
  return sessions;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Tests ────────────────────────────────────────────────────────────

describe('SessionPicker', () => {
  it('renders loading state', () => {
    const { lastFrame, unmount } = render(
      <SessionPicker
        sessions={[]}
        loading={true}
        currentSessionId="session-0001"
        colors={baseColors}
        onSelect={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(lastFrame()).toContain('Loading sessions');
    unmount();
  });

  it('renders empty state when no sessions', () => {
    const { lastFrame, unmount } = render(
      <SessionPicker
        sessions={[]}
        loading={false}
        currentSessionId="session-0001"
        colors={baseColors}
        onSelect={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(lastFrame()).toContain('No sessions found');
    unmount();
  });

  it('renders session list with titles and IDs', () => {
    const sessions = makeSessions(3);
    const { lastFrame, unmount } = render(
      <SessionPicker
        sessions={sessions}
        loading={false}
        currentSessionId="session-0001"
        colors={baseColors}
        onSelect={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const frame = lastFrame()!;
    // Session without title shows ID
    expect(frame).toContain('session-0001');
    // Session with title shows the title
    expect(frame).toContain('Session 2');
    // Shows (current) marker
    expect(frame).toContain('(current)');
    unmount();
  });

  it('renders navigation hints', () => {
    const sessions = makeSessions(2);
    const { lastFrame, unmount } = render(
      <SessionPicker
        sessions={sessions}
        loading={false}
        currentSessionId="session-0001"
        colors={baseColors}
        onSelect={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(lastFrame()).toContain('navigate');
    expect(lastFrame()).toContain('Esc');
    unmount();
  });

  it('calls onSelect with the first session on Enter (default selection)', () => {
    const sessions = makeSessions(3);
    const onSelect = vi.fn();
    const { stdin, unmount } = render(
      <SessionPicker
        sessions={sessions}
        loading={false}
        currentSessionId="session-0002"
        colors={baseColors}
        onSelect={onSelect}
        onCancel={vi.fn()}
      />,
    );
    // First item is selected by default, press Enter
    stdin.write('\r');
    expect(onSelect).toHaveBeenCalledWith('session-0001');
    unmount();
  });

  it('navigates down and selects the second session', async () => {
    const sessions = makeSessions(3);
    const onSelect = vi.fn();
    const { stdin, unmount } = render(
      <SessionPicker
        sessions={sessions}
        loading={false}
        currentSessionId="session-0001"
        colors={baseColors}
        onSelect={onSelect}
        onCancel={vi.fn()}
      />,
    );
    // Press down arrow, wait for render, then Enter
    stdin.write('\u001B[B'); // down arrow
    await wait(50);
    stdin.write('\r');
    expect(onSelect).toHaveBeenCalledWith('session-0002');
    unmount();
  });

  it('calls onCancel on Escape', async () => {
    const sessions = makeSessions(2);
    const onCancel = vi.fn();
    const { stdin, unmount } = render(
      <SessionPicker
        sessions={sessions}
        loading={false}
        currentSessionId="session-0001"
        colors={baseColors}
        onSelect={vi.fn()}
        onCancel={onCancel}
      />,
    );
    // Ink needs escape to be sent alone with a delay to distinguish from escape sequences
    stdin.write('\u001B');
    await wait(100);
    expect(onCancel).toHaveBeenCalled();
    unmount();
  });

  it('does not go below the last session', async () => {
    const sessions = makeSessions(2);
    const onSelect = vi.fn();
    const { stdin, unmount } = render(
      <SessionPicker
        sessions={sessions}
        loading={false}
        currentSessionId="session-0001"
        colors={baseColors}
        onSelect={onSelect}
        onCancel={vi.fn()}
      />,
    );
    // Press down 5 times (only 2 sessions), with waits for re-render
    for (let i = 0; i < 5; i++) {
      stdin.write('\u001B[B');
      await wait(20);
    }
    stdin.write('\r');
    // Should be clamped to the last session
    expect(onSelect).toHaveBeenCalledWith('session-0002');
    unmount();
  });

  it('does not go above the first session', async () => {
    const sessions = makeSessions(2);
    const onSelect = vi.fn();
    const { stdin, unmount } = render(
      <SessionPicker
        sessions={sessions}
        loading={false}
        currentSessionId="session-0001"
        colors={baseColors}
        onSelect={onSelect}
        onCancel={vi.fn()}
      />,
    );
    // Press up 5 times (already at top), with waits
    for (let i = 0; i < 5; i++) {
      stdin.write('\u001B[A');
      await wait(20);
    }
    stdin.write('\r');
    expect(onSelect).toHaveBeenCalledWith('session-0001');
    unmount();
  });

  it('shows the pointer on the selected item', () => {
    const sessions = makeSessions(3);
    const { lastFrame, unmount } = render(
      <SessionPicker
        sessions={sessions}
        loading={false}
        currentSessionId="session-0001"
        colors={baseColors}
        onSelect={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    // The first item should have the ❯ pointer
    expect(lastFrame()).toContain('❯');
    unmount();
  });
});
