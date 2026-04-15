/**
 * useSession hook tests.
 *
 * Tests the session management logic via a minimal React rendering
 * using ink-testing-library.
 */

import React, { useEffect, useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';

import { useSession } from '../../src/app/hooks/useSession.js';
import type { WireClient, WireMessage } from '../../src/wire/index.js';
import type { AppState } from '../../src/app/context.js';
import type { SessionInfo } from '../../src/wire/methods.js';

// ── Helpers ──────────────────────────────────────────────────────────

function emptyAsyncIterable(): AsyncIterable<WireMessage> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<WireMessage> {
      return {
        async next() {
          return new Promise(() => {});
        },
      };
    },
  };
}

function createMockWireClient(sessions: SessionInfo[] = []): WireClient {
  return {
    initialize: vi.fn(async () => ({ protocol_version: '2.1', capabilities: {} })),
    createSession: vi.fn(async () => ({ session_id: 'new-session' })),
    listSessions: vi.fn(async () => ({ sessions })),
    destroySession: vi.fn(async () => undefined),
    prompt: vi.fn(async () => ({ turn_id: 'turn_1' })),
    steer: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    fork: vi.fn(async () => ({ session_id: 'forked' })),
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
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A test component that exercises useSession and exposes results.
function TestHarness({
  wireClient,
  sessionId,
  setState,
  onResult,
}: {
  wireClient: WireClient;
  sessionId: string;
  setState: (patch: Partial<AppState>) => void;
  onResult: (result: ReturnType<typeof useSession>) => void;
}) {
  const result = useSession({ wireClient, sessionId, setState });
  // Expose the result to the test on every render.
  useEffect(() => {
    onResult(result);
  });

  return <Text>sessions: {result.sessions.length}</Text>;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('useSession', () => {
  let mockWireClient: WireClient;
  let mockSetState: ReturnType<typeof vi.fn>;

  const mockSessions: SessionInfo[] = [
    {
      id: 'session-0001',
      work_dir: '/test/dir',
      title: 'First session',
      created_at: Date.now() - 3600_000,
      updated_at: Date.now() - 60_000,
      archived: false,
    },
    {
      id: 'session-0002',
      work_dir: '/test/dir',
      title: null,
      created_at: Date.now() - 7200_000,
      updated_at: Date.now() - 120_000,
      archived: false,
    },
  ];

  beforeEach(() => {
    mockSetState = vi.fn();
    mockWireClient = createMockWireClient(mockSessions);
  });

  it('fetches sessions on mount', async () => {
    let latestResult: ReturnType<typeof useSession> | undefined;
    const { unmount } = render(
      <TestHarness
        wireClient={mockWireClient}
        sessionId="session-0001"
        setState={mockSetState}
        onResult={(r) => { latestResult = r; }}
      />,
    );

    await wait(50);
    expect(mockWireClient.listSessions).toHaveBeenCalledTimes(1);
    expect(latestResult!.sessions).toHaveLength(2);
    unmount();
  });

  it('provides switchSession that updates state and resumes', async () => {
    let latestResult: ReturnType<typeof useSession> | undefined;
    const { unmount } = render(
      <TestHarness
        wireClient={mockWireClient}
        sessionId="session-0001"
        setState={mockSetState}
        onResult={(r) => { latestResult = r; }}
      />,
    );

    await wait(50);
    latestResult!.switchSession('session-0002');
    expect(mockSetState).toHaveBeenCalledWith({ sessionId: 'session-0002' });
    expect(mockWireClient.resume).toHaveBeenCalledWith('session-0002');
    unmount();
  });

  it('handles empty session list gracefully', async () => {
    mockWireClient = createMockWireClient([]);
    let latestResult: ReturnType<typeof useSession> | undefined;
    const { unmount } = render(
      <TestHarness
        wireClient={mockWireClient}
        sessionId="session-0001"
        setState={mockSetState}
        onResult={(r) => { latestResult = r; }}
      />,
    );

    await wait(50);
    expect(latestResult!.sessions).toHaveLength(0);
    expect(latestResult!.loadingSessions).toBe(false);
    unmount();
  });

  it('refreshSessions re-fetches from Wire', async () => {
    let latestResult: ReturnType<typeof useSession> | undefined;
    const { unmount } = render(
      <TestHarness
        wireClient={mockWireClient}
        sessionId="session-0001"
        setState={mockSetState}
        onResult={(r) => { latestResult = r; }}
      />,
    );

    await wait(50);
    expect(mockWireClient.listSessions).toHaveBeenCalledTimes(1);

    // Refresh
    await latestResult!.refreshSessions();
    expect(mockWireClient.listSessions).toHaveBeenCalledTimes(2);
    unmount();
  });
});
