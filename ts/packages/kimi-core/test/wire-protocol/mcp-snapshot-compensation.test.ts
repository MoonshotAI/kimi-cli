/**
 * Phase 24 RR2-B-A — MCP snapshot compensation integration test.
 *
 * Proves that events emitted by MCPManager.loadAll BEFORE a session bridge
 * listener is installed are permanently lost (SessionEventBus has no
 * pre-subscribe buffer), and that emitting a status.update.mcp_status
 * snapshot AFTER the listener is installed is the correct compensation.
 *
 * This test pins the invariant that justifies the snapshot emit in
 * `registerManagedSession` (kimi-core-client.ts) and `installBridge`
 * (index.ts) immediately after `eventBus.on(listener)`.
 */

import { describe, expect, it } from 'vitest';

import type { BusEvent } from '../../src/soul-plus/session-event-bus.js';
import { SessionEventBus } from '../../src/soul-plus/session-event-bus.js';
import type { SoulEvent } from '../../src/soul/index.js';

// Helpers to create minimal typed SoulEvents for the test.
// Cast through unknown because SoulEvent is a discriminated union and these
// "mcp.*" shapes are extended event types outside the base Soul type set.
function mcpLoading(): SoulEvent {
  return { type: 'mcp.loading', data: { serverName: 'srv_a' } } as unknown as SoulEvent;
}
function mcpConnected(): SoulEvent {
  return {
    type: 'mcp.connected',
    data: { serverName: 'srv_a', toolCount: 3 },
  } as unknown as SoulEvent;
}
function mcpStatusSnapshot(): SoulEvent {
  return {
    type: 'status.update.mcp_status',
    data: {
      loading: false,
      total: 1,
      connected: 1,
      toolCount: 3,
      servers: [{ name: 'srv_a', status: 'connected', toolCount: 3 }],
    },
  } as unknown as SoulEvent;
}

describe('RR2-B-A mcp snapshot compensation (Phase 24)', () => {
  it('events emitted before any listener is installed are silently lost', () => {
    const bus = new SessionEventBus();
    const received: BusEvent[] = [];

    // Simulate MCPManager.loadAll completing before any session exists.
    bus.emit(mcpLoading());
    bus.emit(mcpConnected());

    // Bridge installs its listener only when a session is created.
    bus.on((e) => { received.push(e); });

    // Pre-install events never reach the listener — no buffer.
    expect(received).toHaveLength(0);
  });

  it('snapshot emitted after bridge install delivers current MCP state', () => {
    const bus = new SessionEventBus();
    const received: BusEvent[] = [];

    // Pre-install MCP lifecycle events — these are lost.
    bus.emit(mcpLoading());
    bus.emit(mcpConnected());

    // Bridge installs listener (session.create / session.resume).
    bus.on((e) => { received.push(e); });

    // RR2-B-A compensation: mcpManager.status() snapshot emitted after install.
    bus.emit(mcpStatusSnapshot());

    // Bridge receives exactly the snapshot; earlier mcp.loading / mcp.connected
    // are NOT replayed.
    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe('status.update.mcp_status');
    const data = (received[0] as unknown as { data: { servers: unknown[]; connected: number } }).data;
    expect(data.servers).toHaveLength(1);
    expect(data.connected).toBe(1);
  });

  it('without snapshot compensation, bridge would see no MCP state', () => {
    // Documents the buggy path to anchor why compensation is needed.
    const bus = new SessionEventBus();
    const received: BusEvent[] = [];

    bus.emit(mcpLoading());
    bus.emit(mcpConnected());

    bus.on((e) => { received.push(e); });
    // No snapshot emitted — bridge sees nothing.

    expect(received).toHaveLength(0);
  });

  it('multiple listeners on a shared bus each receive the snapshot (N2 multi-session)', () => {
    // When sharedEventBus is used, all sessions share one bus. The snapshot
    // is process-level state and should reach every installed listener.
    // This verifies the current design is safe for multi-session scenarios.
    const bus = new SessionEventBus();

    bus.emit(mcpLoading()); // pre-install, lost to both

    const receivedA: BusEvent[] = [];
    const receivedB: BusEvent[] = [];

    bus.on((e) => { receivedA.push(e); }); // session A installs
    bus.on((e) => { receivedB.push(e); }); // session B installs

    // Session A's createSession compensation emit (single snapshot per
    // createSession call). Since the bus is shared, B also receives it.
    bus.emit(mcpStatusSnapshot());

    expect(receivedA).toHaveLength(1);
    expect(receivedA[0]!.type).toBe('status.update.mcp_status');
    // B gets it too — correct: it also needs the current MCP state.
    expect(receivedB).toHaveLength(1);
    expect(receivedB[0]!.type).toBe('status.update.mcp_status');
  });
});
