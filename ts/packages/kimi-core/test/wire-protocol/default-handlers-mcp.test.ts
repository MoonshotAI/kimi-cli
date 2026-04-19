/**
 * Phase 24 T3 — default-handlers mcp.list / mcp.refresh connected to real McpRegistry.
 *
 * Decision D4-4: only mcp.list and mcp.refresh are connected to real McpRegistry.
 * The remaining 8 MCP wire methods (connect / disconnect / listResources /
 * readResource / listPrompts / getPrompt / startAuth / resetAuth) remain stubs.
 *
 * ALL tests are skipped because they require:
 *   1. `DefaultHandlersDeps` to accept `mcpRegistry?: McpRegistry`
 *   2. `mcp.list` handler to call `mcpRegistry.status()` and return servers
 *   3. `mcp.refresh` handler to call `mcpRegistry.refresh(server_id)` and return `{ok: true}`
 *
 * Phase 24 Step 4.7: Implementer must add mcpRegistry to DefaultHandlersDeps and unskip.
 *
 * Note: mcp.connect / mcp.disconnect and other stubs are verified to remain noop.
 */

import { describe, expect, it, vi } from 'vitest';

import type { McpRegistry, McpRegistrySnapshot } from '../../src/soul-plus/mcp/registry.js';
import { WireCodec } from '../../src/wire-protocol/codec.js';

// We need to test via the wire harness. The test helper makes a full
// DefaultHandlers-backed server. We'll use a fake McpRegistry.

function makeFakeRegistry(servers: McpRegistrySnapshot['servers'] = []): McpRegistry {
  const snap: McpRegistrySnapshot = {
    loading: false,
    total: servers.length,
    connected: servers.filter((s) => s.status === 'connected').length,
    toolCount: servers.reduce((sum, s) => sum + s.toolCount, 0),
    servers,
  };
  return {
    status: vi.fn().mockReturnValue(snap),
    refresh: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockReturnValue([]),
    get: vi.fn().mockReturnValue(undefined),
    register: vi.fn().mockRejectedValue(new Error('not implemented')),
    unregister: vi.fn().mockRejectedValue(new Error('not implemented')),
    startAll: vi.fn().mockResolvedValue(undefined),
    closeAll: vi.fn().mockResolvedValue(undefined),
    onToolsChanged: null,
  };
}

// Phase 24 Step 4.7: Implementer must wire McpRegistry into DefaultHandlersDeps and unskip
describe('default-handlers — mcp.list / mcp.refresh real routing (Phase 24 T3 L3)', () => {
  // We need to instantiate installDefaultHandlers with mcpRegistry injected.
  // The test sends wire messages directly through the router.

  it('mcp.list request → returns servers from McpRegistry.status()', async () => {
    const registry = makeFakeRegistry([
      { name: 'server_a', status: 'connected', toolCount: 3 },
      { name: 'server_b', status: 'failed', toolCount: 0, error: 'timeout' },
    ]);

    // Phase 24: installDefaultHandlers is a test helper (moved from src per RR2-M-B)
    const { installDefaultHandlers } = await import('../helpers/wire/install-default-handlers.js');
    const codec = new WireCodec();
    const responses: unknown[] = [];

    // Build a minimal router context with mcpRegistry injected
    // This is the intended post-Phase-24 API — will fail until Implementer wires it
    const handle = installDefaultHandlers({
      sessionManager: {} as never,
      mcpRegistry: registry,
    } as never);

    // Simulate mcp.list request
    const req = codec.encode({
      id: 'req_mcp_list',
      time: Date.now(),
      session_id: '__process__',
      type: 'request',
      from: 'client',
      to: 'server',
      method: 'mcp.list',
    });

    // Route the request through the handler
    const resp = await handle(req);
    if (resp) {
      const decoded = codec.decode(resp);
      responses.push(decoded);
    }

    expect(responses).toHaveLength(1);
    const data = (responses[0] as { data: { servers: unknown[] } }).data;
    expect(data.servers).toHaveLength(2);
    expect(data.servers[0]).toMatchObject({ name: 'server_a', status: 'connected' });
  });

  it('mcp.refresh request with server_id → calls McpRegistry.refresh(server_id)', async () => {
    const registry = makeFakeRegistry([{ name: 'srv', status: 'connected', toolCount: 1 }]);

    const { installDefaultHandlers } = await import('../helpers/wire/install-default-handlers.js');
    const codec = new WireCodec();

    const handle = installDefaultHandlers({
      sessionManager: {} as never,
      mcpRegistry: registry,
    } as never);

    const req = codec.encode({
      id: 'req_mcp_refresh',
      time: Date.now(),
      session_id: '__process__',
      type: 'request',
      from: 'client',
      to: 'server',
      method: 'mcp.refresh',
      data: { server_id: 'srv' },
    });

    const resp = await handle(req);
    const decoded = resp ? codec.decode(resp) : undefined;

    // Registry.refresh was called with the server_id
    expect(vi.mocked(registry.refresh)).toHaveBeenCalledWith('srv');
    // Response indicates success
    expect((decoded?.data as { ok: boolean })?.ok).toBe(true);
  });

  it('mcp.connect → still returns stub response (D4-4 not connected)', async () => {
    const registry = makeFakeRegistry();

    const { installDefaultHandlers } = await import('../helpers/wire/install-default-handlers.js');
    const codec = new WireCodec();

    const handle = installDefaultHandlers({
      sessionManager: {} as never,
      mcpRegistry: registry,
    } as never);

    const req = codec.encode({
      id: 'req_mcp_connect',
      time: Date.now(),
      session_id: '__process__',
      type: 'request',
      from: 'client',
      to: 'server',
      method: 'mcp.connect',
      data: { server_id: 'srv' },
    });

    const resp = await handle(req);
    const decoded = resp ? codec.decode(resp) : undefined;

    // D4-4: mcp.connect remains noop stub, registry.refresh NOT called
    expect(vi.mocked(registry.refresh)).not.toHaveBeenCalled();
    // Still returns a response (not an error)
    expect(decoded?.type).toBe('response');
  });

  it('mcp.list without mcpRegistry injected → returns empty servers (fallback)', async () => {
    // When no mcpRegistry is provided, mcp.list should return { servers: [] }
    // (backward-compatible: existing noop behavior preserved)
    const { installDefaultHandlers } = await import('../helpers/wire/install-default-handlers.js');
    const codec = new WireCodec();

    const handle = installDefaultHandlers({ sessionManager: {} as never } as never);

    const req = codec.encode({
      id: 'req_no_reg',
      time: Date.now(),
      session_id: '__process__',
      type: 'request',
      from: 'client',
      to: 'server',
      method: 'mcp.list',
    });

    const resp = await handle(req);
    const decoded = resp ? codec.decode(resp) : undefined;
    const data = decoded?.data as { servers: unknown[] } | undefined;
    expect(data?.servers ?? []).toEqual([]);
  });
});
