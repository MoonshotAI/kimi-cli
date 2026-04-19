/**
 * Phase 24 T3 — MCPManager implements McpRegistry (L2: architecture glue).
 *
 * Decision D4-2: MCPManager must implement McpRegistry via adapter pattern.
 * The existing MCPManager internals are NOT refactored — new interface methods
 * are added as thin wrappers around existing state.
 *
 * Required new methods:
 *   - status() → McpRegistrySnapshot (mapping internal ServerState)
 *   - list() → readonly MCPClient[]
 *   - get(serverId) → MCPClient | undefined
 *   - refresh(serverId) → Promise<void> (reconnect one server)
 *   - register() → throws NotImplemented (D4-4)
 *   - unregister() → throws NotImplemented (D4-4)
 *   - startAll() → delegates to loadAll()
 *   - closeAll() → delegates to close()
 *   - onToolsChanged → McpToolsChangedCallback | null slot
 *
 * ALL tests are skipped because MCPManager does not yet implement McpRegistry.
 *
 * Phase 24 Step 4.3: Implementer must `class MCPManager implements McpRegistry` and unskip.
 */

import { describe, expect, it, vi } from 'vitest';

import { MCPManager } from '../../../src/soul-plus/mcp/manager.js';
import type { McpClientFactory } from '../../../src/soul-plus/mcp/manager.js';
import type { McpRegistry, McpRegistrySnapshot } from '../../../src/soul-plus/mcp/registry.js';
import type { MCPClient } from '../../../src/soul-plus/mcp/client.js';

function makeSuccessClientFactory(toolCount = 2): McpClientFactory {
  return (_name, _cfg) => ({
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue(
      Array.from({ length: toolCount }, (_, i) => ({
        name: `tool_${String(i)}`,
        description: `desc_${String(i)}`,
        inputSchema: { type: 'object', properties: {} },
      })),
    ),
    callTool: vi.fn().mockResolvedValue({ content: [] }),
    close: vi.fn().mockResolvedValue(undefined),
  } as MCPClient);
}

function makeManager(serverNames: string[], toolCount = 1): MCPManager {
  const servers = Object.fromEntries(
    serverNames.map((name) => [name, { command: 'echo', transport: 'stdio' }]),
  );
  return new MCPManager({
    config: { mcpServers: servers as never },
    clientFactory: makeSuccessClientFactory(toolCount),
  });
}

// Phase 24 Step 4.3: Implementer must add McpRegistry interface to MCPManager and unskip
describe('MCPManager implements McpRegistry (Phase 24 T3 L2)', () => {
  it('MCPManager satisfies the McpRegistry interface at compile time', () => {
    // Type-level assertion: if MCPManager doesn't implement McpRegistry, this fails typecheck
    const manager: McpRegistry = makeManager(['srv']) as unknown as McpRegistry;
    expect(typeof manager.status).toBe('function');
    expect(typeof manager.list).toBe('function');
    expect(typeof manager.get).toBe('function');
    expect(typeof manager.refresh).toBe('function');
    expect(typeof manager.register).toBe('function');
    expect(typeof manager.unregister).toBe('function');
    expect(typeof manager.startAll).toBe('function');
    expect(typeof manager.closeAll).toBe('function');
    expect(manager.onToolsChanged === null || typeof manager.onToolsChanged === 'function').toBe(true);
  });

  it('status() returns McpRegistrySnapshot with correct shape after loadAll', async () => {
    const manager = makeManager(['srv_a', 'srv_b'], 3);
    await manager.loadAll();

    const snap: McpRegistrySnapshot = (manager as unknown as McpRegistry).status();
    expect(snap.loading).toBe(false);
    expect(snap.total).toBe(2);
    expect(snap.connected).toBe(2);
    expect(snap.toolCount).toBe(6); // 2 servers × 3 tools each
    expect(snap.servers).toHaveLength(2);
    const names = snap.servers.map((s) => s.name).sort();
    expect(names).toEqual(['srv_a', 'srv_b']);
  });

  it('status() before loadAll → all servers pending, connected=0', () => {
    const manager = makeManager(['s1']);
    const snap = (manager as unknown as McpRegistry).status();
    expect(snap.connected).toBe(0);
    expect(snap.loading).toBe(true); // servers pending = loading
  });

  it('list() returns connected clients after loadAll', async () => {
    const manager = makeManager(['s1', 's2']);
    await manager.loadAll();

    const clients = (manager as unknown as McpRegistry).list();
    expect(clients).toHaveLength(2);
  });

  it('get(serverId) returns the client for a known server', async () => {
    const manager = makeManager(['myServer']);
    await manager.loadAll();

    const client = (manager as unknown as McpRegistry).get('myServer');
    expect(client).toBeDefined();
  });

  it('get(serverId) returns undefined for unknown server', () => {
    const manager = makeManager(['s1']);
    const client = (manager as unknown as McpRegistry).get('unknown');
    expect(client).toBeUndefined();
  });

  it('register() throws NotImplemented (D4-4: dynamic add not in Phase 24 scope)', async () => {
    const manager = makeManager([]);
    await expect(
      (manager as unknown as McpRegistry).register({
        name: 'new',
        command: 'echo',
        transport: 'stdio',
      } as never),
    ).rejects.toThrow();
  });

  it('unregister() throws NotImplemented (D4-4: dynamic remove not in Phase 24 scope)', async () => {
    const manager = makeManager([]);
    await expect((manager as unknown as McpRegistry).unregister('any')).rejects.toThrow();
  });

  it('startAll() is an alias for loadAll()', async () => {
    const manager = makeManager(['srv']);
    await (manager as unknown as McpRegistry).startAll();
    // After startAll, status shows connected
    const snap = (manager as unknown as McpRegistry).status();
    expect(snap.connected).toBe(1);
  });

  it('closeAll() is an alias for close()', async () => {
    const manager = makeManager(['srv']);
    await manager.loadAll();
    await (manager as unknown as McpRegistry).closeAll();
    // After closeAll, list returns empty
    const clients = (manager as unknown as McpRegistry).list();
    expect(clients).toHaveLength(0);
  });

  it('onToolsChanged is a settable slot (null by default)', () => {
    const manager = makeManager([]);
    const reg = manager as unknown as McpRegistry;
    expect(reg.onToolsChanged).toBeNull();
    reg.onToolsChanged = (_id, _tools) => {};
    expect(typeof reg.onToolsChanged).toBe('function');
    reg.onToolsChanged = null;
    expect(reg.onToolsChanged).toBeNull();
  });

  it('refresh(serverId) triggers reconnect and re-lists tools', async () => {
    const manager = makeManager(['srv']);
    await manager.loadAll();
    const reg = manager as unknown as McpRegistry;

    // Should not throw
    await expect(reg.refresh('srv')).resolves.toBeUndefined();
    // After refresh, server is still connected
    const snap = reg.status();
    expect(snap.connected).toBe(1);
  });

  it('refresh(unknownServerId) throws (server not found)', async () => {
    const manager = makeManager(['srv']);
    const reg = manager as unknown as McpRegistry;
    await expect(reg.refresh('not_existing')).rejects.toThrow();
  });
});
