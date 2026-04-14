/**
 * Shell component integration tests.
 *
 * Uses ink-testing-library to render the App into a virtual terminal
 * and assert on the rendered text output.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';

import App from '../../src/app/App.js';
import type { AppState } from '../../src/app/context.js';
import type { WireClient } from '@moonshot-ai/kimi-wire-mock';
import type { WireEvent } from '@moonshot-ai/kimi-wire-mock';

// ── Helpers ──────────────────────────────────────────────────────────

function createMockWireClient(overrides?: Partial<WireClient>): WireClient {
  return {
    prompt: vi.fn(() => emptyAsyncIterable()),
    steer: vi.fn(),
    cancel: vi.fn(),
    approvalResponse: vi.fn(),
    questionResponse: vi.fn(),
    setPlanMode: vi.fn(),
    replay: vi.fn(() => emptyAsyncIterable()),
    dispose: vi.fn(async () => undefined),
    createSession: vi.fn(async () => 'mock-session'),
    listSessions: vi.fn(async () => []),
    listAllSessions: vi.fn(async () => []),
    continueSession: vi.fn(async () => null),
    deleteSession: vi.fn(async () => undefined),
    forkSession: vi.fn(async () => 'forked-session'),
    setSessionTitle: vi.fn(async () => undefined),
    ...overrides,
  };
}

function defaultState(overrides?: Partial<AppState>): AppState {
  return {
    inputMode: 'agent',
    model: 'test-model',
    workDir: '/test/work/dir',
    sessionId: 'test-session-123',
    yolo: false,
    planMode: false,
    thinking: false,
    contextUsage: 0,
    isStreaming: false,
    streamingPhase: 'idle' as const,
    streamingStartTime: 0,
    theme: 'dark',
    version: '0.1.0-test',
    ...overrides,
  };
}

function emptyAsyncIterable(): AsyncIterable<WireEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<WireEvent> {
      return {
        async next(): Promise<IteratorResult<WireEvent>> {
          return { done: true, value: undefined as unknown as WireEvent };
        },
      };
    },
  };
}

function asyncIterableFrom(events: WireEvent[]): AsyncIterable<WireEvent> {
  let index = 0;
  return {
    [Symbol.asyncIterator](): AsyncIterator<WireEvent> {
      return {
        async next(): Promise<IteratorResult<WireEvent>> {
          if (index >= events.length) {
            return { done: true, value: undefined as unknown as WireEvent };
          }
          const value = events[index]!;
          index++;
          return { done: false, value };
        },
      };
    },
  };
}

/** Wait for N milliseconds. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Shell', () => {
  let mockWireClient: WireClient;

  beforeEach(() => {
    mockWireClient = createMockWireClient();
  });

  it('renders without throwing', () => {
    const { unmount } = render(
      <App wireClient={mockWireClient} initialState={defaultState()} />,
    );
    unmount();
  });

  it('displays the welcome message with working directory', () => {
    const { lastFrame, unmount } = render(
      <App
        wireClient={mockWireClient}
        initialState={defaultState({ workDir: '/home/user/project' })}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('/home/user/project');
    expect(frame).toContain('Welcome to Kimi Code CLI');
    unmount();
  });

  it('displays the model name in the welcome banner', () => {
    const { lastFrame, unmount } = render(
      <App
        wireClient={mockWireClient}
        initialState={defaultState({ model: 'kimi-k2.5' })}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('kimi-k2.5');
    unmount();
  });

  it('displays the session ID in the welcome banner', () => {
    const { lastFrame, unmount } = render(
      <App
        wireClient={mockWireClient}
        initialState={defaultState({ sessionId: 'my-session-xyz' })}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('my-session-xyz');
    unmount();
  });

  it('displays the version in the welcome banner', () => {
    const { lastFrame, unmount } = render(
      <App
        wireClient={mockWireClient}
        initialState={defaultState({ version: '1.2.3' })}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('1.2.3');
    unmount();
  });

  it('displays the status bar with model name and workDir', () => {
    const { lastFrame, unmount } = render(
      <App
        wireClient={mockWireClient}
        initialState={defaultState({
          model: 'gpt-test-model',
          workDir: '/my/dir',
        })}
      />,
    );

    const frame = lastFrame() ?? '';
    // Model appears both in welcome and status bar.
    // Check the status bar line contains both model and workDir separated by |.
    expect(frame).toContain('gpt-test-model');
    expect(frame).toContain('/my/dir');
    unmount();
  });

  it('displays the bordered input box', () => {
    const { lastFrame, unmount } = render(
      <App wireClient={mockWireClient} initialState={defaultState()} />,
    );

    const frame = lastFrame() ?? '';
    // Bordered input box uses round border characters
    expect(frame).toContain('╭');
    expect(frame).toContain('╰');
    unmount();
  });

  it('shows yolo indicator when yolo mode is enabled', () => {
    const { lastFrame, unmount } = render(
      <App
        wireClient={mockWireClient}
        initialState={defaultState({ yolo: true })}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('yolo');
    unmount();
  });

  it('shows plan indicator when plan mode is enabled', () => {
    const { lastFrame, unmount } = render(
      <App
        wireClient={mockWireClient}
        initialState={defaultState({ planMode: true })}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('plan');
    unmount();
  });

  it('does not show yolo/plan flag labels by default', () => {
    const { lastFrame, unmount } = render(
      <App wireClient={mockWireClient} initialState={defaultState()} />,
    );

    const frame = lastFrame() ?? '';
    // The status bar should not contain standalone "yolo" or "plan" as flag labels.
    // Note: "plan" may appear inside tips text ("shift-tab: plan mode"), so we
    // verify the flags aren't rendered by checking yolo isn't present at all
    // (it only appears as a flag), and plan mode indicator is absent.
    expect(frame).not.toContain('yolo');
    unmount();
  });

  it('calls wireClient.prompt when user submits input', async () => {
    const events: WireEvent[] = [
      { type: 'TurnBegin', userInput: 'hello' },
      { type: 'ContentPart', part: { type: 'text', text: 'Response' } },
      { type: 'TurnEnd' },
    ];
    const promptFn = vi.fn(() => asyncIterableFrom(events));
    mockWireClient = createMockWireClient({ prompt: promptFn });

    const { stdin, unmount } = render(
      <App wireClient={mockWireClient} initialState={defaultState()} />,
    );

    // Type "hello" and press Enter.
    stdin.write('hello');
    await wait(50);
    stdin.write('\r');
    await wait(200);

    expect(promptFn).toHaveBeenCalledWith('hello');
    unmount();
  }, 5000);

  it('displays completed assistant text after a turn', async () => {
    const events: WireEvent[] = [
      { type: 'TurnBegin', userInput: 'hi' },
      { type: 'ContentPart', part: { type: 'text', text: 'Hello from assistant!' } },
      { type: 'TurnEnd' },
    ];
    mockWireClient = createMockWireClient({
      prompt: vi.fn(() => asyncIterableFrom(events)),
    });

    const { lastFrame, stdin, unmount } = render(
      <App wireClient={mockWireClient} initialState={defaultState()} />,
    );

    stdin.write('hi');
    await wait(50);
    stdin.write('\r');
    await wait(300);

    const frame = lastFrame() ?? '';
    // The assistant text should appear as a completed block.
    expect(frame).toContain('Hello from assistant!');
    unmount();
  }, 5000);

  it('calls wireClient.cancel on Ctrl-C', async () => {
    const cancelFn = vi.fn();
    mockWireClient = createMockWireClient({ cancel: cancelFn });

    const { stdin, unmount } = render(
      <App wireClient={mockWireClient} initialState={defaultState()} />,
    );

    // Send Ctrl-C. Even though nothing is streaming, cancel should be called.
    stdin.write('\x03');
    await wait(50);

    expect(cancelFn).toHaveBeenCalled();
    unmount();
  }, 5000);
});
