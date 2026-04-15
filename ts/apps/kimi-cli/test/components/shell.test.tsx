/**
 * Shell component integration tests.
 *
 * Uses ink-testing-library to render the App into a virtual terminal
 * and assert on the rendered text output.
 *
 * Wire 2.1: WireClient interface uses session-scoped methods with
 * prompt(sessionId, input) returning { turn_id }, and events arriving
 * via subscribe(sessionId).
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';

import App from '../../src/app/App.js';
import type { AppState } from '../../src/app/context.js';
import type { WireClient, WireMessage } from '../../src/wire/index.js';
import { createEvent } from '../../src/wire/index.js';

// ── Helpers ──────────────────────────────────────────────────────────

function emptyAsyncIterable(): AsyncIterable<WireMessage> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<WireMessage> {
      return {
        async next(): Promise<IteratorResult<WireMessage>> {
          // Never resolves -- keeps subscribe alive
          return new Promise(() => {});
        },
      };
    },
  };
}

function asyncIterableFrom(events: WireMessage[]): AsyncIterable<WireMessage> {
  let index = 0;
  let resolve: (() => void) | null = null;

  return {
    [Symbol.asyncIterator](): AsyncIterator<WireMessage> {
      return {
        async next(): Promise<IteratorResult<WireMessage>> {
          if (index >= events.length) {
            // Keep the subscription alive (never close)
            return new Promise(() => {});
          }
          const value = events[index]!;
          index++;
          return { done: false, value };
        },
      };
    },
  };
}

/** Create a mock event stream that can be pushed to. */
function createPushableStream(): {
  iterable: AsyncIterable<WireMessage>;
  push: (msg: WireMessage) => void;
  end: () => void;
} {
  const buffer: WireMessage[] = [];
  let resolve: (() => void) | null = null;
  let done = false;

  const push = (msg: WireMessage): void => {
    buffer.push(msg);
    if (resolve !== null) {
      const r = resolve;
      resolve = null;
      r();
    }
  };

  const end = (): void => {
    done = true;
    if (resolve !== null) {
      const r = resolve;
      resolve = null;
      r();
    }
  };

  const iterable: AsyncIterable<WireMessage> = {
    [Symbol.asyncIterator](): AsyncIterator<WireMessage> {
      return {
        async next(): Promise<IteratorResult<WireMessage>> {
          while (buffer.length === 0 && !done) {
            await new Promise<void>((r) => { resolve = r; });
          }
          if (buffer.length > 0) {
            return { done: false, value: buffer.shift()! };
          }
          return { done: true, value: undefined as unknown as WireMessage };
        },
      };
    },
  };

  return { iterable, push, end };
}

function createMockWireClient(overrides?: Partial<WireClient>): WireClient {
  return {
    initialize: vi.fn(async () => ({ protocol_version: '2.1', capabilities: {} })),
    createSession: vi.fn(async () => ({ session_id: 'mock-session' })),
    listSessions: vi.fn(async () => ({ sessions: [] })),
    destroySession: vi.fn(async () => undefined),
    prompt: vi.fn(async () => ({ turn_id: 'turn_1' })),
    steer: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    fork: vi.fn(async () => ({ session_id: 'forked-session' })),
    rename: vi.fn(async () => undefined),
    getStatus: vi.fn(async () => ({ state: 'idle' })),
    getUsage: vi.fn(async () => ({
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cache_read_tokens: 0,
      total_cache_write_tokens: 0,
      total_cost_usd: 0,
    })),
    compact: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    setThinking: vi.fn(async () => undefined),
    setPlanMode: vi.fn(async () => undefined),
    setYolo: vi.fn(async () => undefined),
    subscribe: vi.fn(() => emptyAsyncIterable()),
    respondToRequest: vi.fn(),
    dispose: vi.fn(async () => undefined),
    ...overrides,
  };
}

function defaultState(overrides?: Partial<AppState>): AppState {
  return {
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
    expect(frame).toContain('gpt-test-model');
    expect(frame).toContain('/my/dir');
    unmount();
  });

  it('displays the bordered input box', () => {
    const { lastFrame, unmount } = render(
      <App wireClient={mockWireClient} initialState={defaultState()} />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('\u256D');
    expect(frame).toContain('\u2570');
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
    expect(frame).not.toContain('yolo');
    unmount();
  });

  it('calls wireClient.prompt when user submits input', async () => {
    const stream = createPushableStream();
    const opts = { session_id: 'test-session-123', turn_id: 'turn_1' };

    const promptFn = vi.fn(async (_sid: string, _input: string) => {
      // Push events into the stream after prompt is called
      stream.push(createEvent('turn.begin', { turn_id: 'turn_1', user_input: 'hello', input_kind: 'user' }, opts));
      stream.push(createEvent('content.delta', { type: 'text', text: 'Response' }, opts));
      stream.push(createEvent('turn.end', { turn_id: 'turn_1', reason: 'done', success: true }, opts));
      return { turn_id: 'turn_1' };
    });

    mockWireClient = createMockWireClient({
      prompt: promptFn,
      subscribe: vi.fn(() => stream.iterable),
    });

    const { stdin, unmount } = render(
      <App wireClient={mockWireClient} initialState={defaultState()} />,
    );

    // Type "hello" and press Enter.
    stdin.write('hello');
    await wait(50);
    stdin.write('\r');
    await wait(200);

    expect(promptFn).toHaveBeenCalledWith('test-session-123', 'hello');
    unmount();
  }, 5000);

  it('displays completed assistant text after a turn', async () => {
    const stream = createPushableStream();
    const opts = { session_id: 'test-session-123', turn_id: 'turn_1' };

    mockWireClient = createMockWireClient({
      prompt: vi.fn(async () => {
        stream.push(createEvent('turn.begin', { turn_id: 'turn_1', user_input: 'hi', input_kind: 'user' }, opts));
        stream.push(createEvent('content.delta', { type: 'text', text: 'Hello from assistant!' }, opts));
        stream.push(createEvent('turn.end', { turn_id: 'turn_1', reason: 'done', success: true }, opts));
        return { turn_id: 'turn_1' };
      }),
      subscribe: vi.fn(() => stream.iterable),
    });

    const { lastFrame, stdin, unmount } = render(
      <App wireClient={mockWireClient} initialState={defaultState()} />,
    );

    stdin.write('hi');
    await wait(50);
    stdin.write('\r');
    await wait(300);

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Hello from assistant!');
    unmount();
  }, 5000);

  it('calls wireClient.cancel on Ctrl-C', async () => {
    const cancelFn = vi.fn(async () => undefined);
    mockWireClient = createMockWireClient({ cancel: cancelFn });

    const { stdin, unmount } = render(
      <App wireClient={mockWireClient} initialState={defaultState()} />,
    );

    stdin.write('\x03');
    await wait(50);

    expect(cancelFn).toHaveBeenCalled();
    unmount();
  }, 5000);
});
