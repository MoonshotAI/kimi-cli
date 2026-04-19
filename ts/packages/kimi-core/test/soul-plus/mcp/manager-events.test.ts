/**
 * Phase 24 T3 — MCPManager emits SoulEvents via eventSink (L1: event flow).
 *
 * Decision D4-1/D4-3: MCPManager must accept `eventSink?: EventSink` in its
 * options. When provided, internal state transitions must emit:
 *   - mcp.loading(loading) → connecting
 *   - mcp.loading(loaded) → success
 *   - mcp.connected        → success (with tool_count)
 *   - mcp.tools_changed    → success (added=[...], removed=[])
 *   - status.update.mcp_status → after each real state change (D4-3 折中)
 *   - mcp.loading(error)   → failure
 *   - mcp.error            → failure
 *
 * ALL tests are skipped because they require:
 *   1. New `eventSink?: EventSink` field in `MCPManagerOptions`
 *   2. New SoulEvent variants for mcp.* + status.update.mcp_status in event-sink.ts
 *   3. New WireEventMethod literals 'mcp.loading' / 'status.update.mcp_status' in types.ts
 *   4. Emit calls inside MCPManager.connectServer() / emitStatusSnapshot()
 *
 * Phase 24 Step 4 (Step 4.4): Implementer must unskip.
 */

import { describe, expect, it, vi } from 'vitest';

import { MCPManager } from '../../../src/soul-plus/mcp/manager.js';
import type { MCPManagerOptions, McpClientFactory } from '../../../src/soul-plus/mcp/manager.js';
import type { MCPClient } from '../../../src/soul-plus/mcp/client.js';
import type { EventSink, SoulEvent } from '../../../src/soul/event-sink.js';

function makeSuccessClientFactory(toolNames: string[] = ['tool_a']): McpClientFactory {
  return (_serverName, _config) => {
    const client: MCPClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue(
        toolNames.map((name) => ({
          name,
          description: `desc ${name}`,
          inputSchema: { type: 'object', properties: {} },
        })),
      ),
      callTool: vi.fn().mockResolvedValue({ content: [] }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    return client;
  };
}

function makeFailingClientFactory(errorMessage = 'connect failed'): McpClientFactory {
  return (_serverName, _config) => {
    const client: MCPClient = {
      connect: vi.fn().mockRejectedValue(new Error(errorMessage)),
      listTools: vi.fn().mockResolvedValue([]),
      callTool: vi.fn().mockResolvedValue({ content: [] }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    return client;
  };
}

function makeEventCollectingSink(): { sink: EventSink; events: SoulEvent[] } {
  const events: SoulEvent[] = [];
  const sink: EventSink = { emit: (e) => events.push(e) };
  return { sink, events };
}

// Phase 24 Step 4.4: Implementer must add eventSink dep to MCPManagerOptions and unskip
describe('MCPManager — SoulEvent emission via eventSink (Phase 24 T3 L1)', () => {
  it('loadAll() success → emits mcp.loading(loading), mcp.loading(loaded), mcp.connected, mcp.tools_changed, status.update.mcp_status in order', async () => {
    const { sink, events } = makeEventCollectingSink();

    const manager = new MCPManager({
      config: { mcpServers: { myServer: { command: 'echo', transport: 'stdio' } as never } },
      clientFactory: makeSuccessClientFactory(['tool_a', 'tool_b']),
      // Phase 24 new field:
      eventSink: sink,
    } as unknown as MCPManagerOptions);

    await manager.loadAll();

    const types = events.map((e) => e.type);

    // mcp.loading(loading) fires BEFORE connect
    expect(types).toContain('mcp.loading');
    // mcp.loading(loaded) fires on success
    const loadingEvents = events.filter((e) => e.type === 'mcp.loading') as Array<
      Extract<SoulEvent, { type: 'mcp.loading' }>
    >;
    const loadingStatuses = loadingEvents.map((e) => (e as { data: { status: string } }).data.status);
    expect(loadingStatuses).toContain('loading');
    expect(loadingStatuses).toContain('loaded');

    // mcp.connected with tool_count
    const connectedEvt = events.find((e) => e.type === 'mcp.connected') as
      | Extract<SoulEvent, { type: 'mcp.connected' }>
      | undefined;
    expect(connectedEvt).toBeDefined();
    expect((connectedEvt as { data: { tool_count: number } }).data.tool_count).toBe(2);

    // mcp.tools_changed with added tools
    const toolsChangedEvt = events.find((e) => e.type === 'mcp.tools_changed');
    expect(toolsChangedEvt).toBeDefined();

    // status.update.mcp_status (D4-3: emitted on real state change)
    expect(types).toContain('status.update.mcp_status');

    // Order invariant: mcp.loading(loading) must come before mcp.connected
    const loadingIdx = types.indexOf('mcp.loading');
    const connectedIdx = types.indexOf('mcp.connected');
    expect(loadingIdx).toBeLessThan(connectedIdx);
  });

  it('loadAll() failure → emits mcp.loading(loading), mcp.loading(error), mcp.error, status.update.mcp_status', async () => {
    const { sink, events } = makeEventCollectingSink();

    const manager = new MCPManager({
      config: { mcpServers: { badServer: { command: 'bad', transport: 'stdio' } as never } },
      clientFactory: makeFailingClientFactory('timeout'),
      eventSink: sink,
    } as unknown as MCPManagerOptions);

    await manager.loadAll();

    const types = events.map((e) => e.type);

    // mcp.loading(error) on failure
    const loadingEvents = events.filter((e) => e.type === 'mcp.loading') as Array<{
      data: { status: string; server_name: string; error?: string };
    }>;
    const errorLoading = loadingEvents.find((e) => e.data.status === 'error');
    expect(errorLoading).toBeDefined();
    expect(errorLoading!.data.error).toContain('timeout');

    // mcp.error fired
    expect(types).toContain('mcp.error');
    const errEvt = events.find((e) => e.type === 'mcp.error') as
      | { data: { server_id: string; error: string } }
      | undefined;
    expect(errEvt).toBeDefined();
    expect(errEvt!.data.error).toContain('timeout');

    // status snapshot still emitted on failure (D4-3)
    expect(types).toContain('status.update.mcp_status');
  });

  it('loadAll() without eventSink → no side effects (backward compat)', async () => {
    // No eventSink passed — must not throw
    const manager = new MCPManager({
      config: { mcpServers: { s: { command: 'echo', transport: 'stdio' } as never } },
      clientFactory: makeSuccessClientFactory(),
    });
    await expect(manager.loadAll()).resolves.toBeUndefined();
  });

  it('mcp.loading events carry server_name matching config key', async () => {
    const { sink, events } = makeEventCollectingSink();

    const manager = new MCPManager({
      config: { mcpServers: { 'my-tools': { command: 'echo', transport: 'stdio' } as never } },
      clientFactory: makeSuccessClientFactory(),
      eventSink: sink,
    } as unknown as MCPManagerOptions);

    await manager.loadAll();

    const loadingEvts = events.filter((e) => e.type === 'mcp.loading') as Array<{
      data: { server_name: string };
    }>;
    expect(loadingEvts.every((e) => e.data.server_name === 'my-tools')).toBe(true);
  });

  it('refresh(serverId) → emits full event sequence again (mcp.loading + mcp.connected + tools_changed + status)', async () => {
    const { sink, events } = makeEventCollectingSink();

    const manager = new MCPManager({
      config: { mcpServers: { srv: { command: 'echo', transport: 'stdio' } as never } },
      clientFactory: makeSuccessClientFactory(['t1']),
      eventSink: sink,
    } as unknown as MCPManagerOptions);

    await manager.loadAll();
    events.length = 0; // reset collector

    // Phase 24: MCPManager.refresh() reconnects the server → re-emits events
    await (manager as unknown as { refresh: (id: string) => Promise<void> }).refresh('srv');

    const types = events.map((e) => e.type);
    expect(types).toContain('mcp.loading');
    expect(types).toContain('mcp.connected');
    expect(types).toContain('status.update.mcp_status');
  });

  it('status.update.mcp_status event carries McpRegistrySnapshot shape', async () => {
    const { sink, events } = makeEventCollectingSink();

    const manager = new MCPManager({
      config: { mcpServers: { srv: { command: 'echo', transport: 'stdio' } as never } },
      clientFactory: makeSuccessClientFactory(['tool_1']),
      eventSink: sink,
    } as unknown as MCPManagerOptions);

    await manager.loadAll();

    const statusEvt = events.find((e) => e.type === 'status.update.mcp_status') as
      | { data: { loading: boolean; total: number; connected: number; toolCount: number; servers: unknown[] } }
      | undefined;
    expect(statusEvt).toBeDefined();
    expect(statusEvt!.data.loading).toBe(false);
    expect(statusEvt!.data.total).toBe(1);
    expect(statusEvt!.data.connected).toBe(1);
    expect(statusEvt!.data.toolCount).toBe(1);
    expect(statusEvt!.data.servers).toHaveLength(1);
  });
});
