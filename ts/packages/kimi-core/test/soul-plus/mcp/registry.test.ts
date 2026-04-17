/**
 * McpRegistry + NoopMcpRegistry — Slice 7.2 (决策 #100) tests.
 *
 * The registry is the host-side façade owning lifecycle for every
 * MCP server: connect, refresh, close, tool-change notifications.
 * `NoopMcpRegistry` is the zero-install placeholder so the rest of
 * kimi-core can depend on the interface unconditionally.
 *
 * These tests pin:
 *   - The 9-method interface shape exists and compiles.
 *   - NoopMcpRegistry's return shapes match the "empty snapshot"
 *     contract (list=[], get=undefined, status all-zero, all
 *     mutations resolve without throwing).
 *   - `onToolsChanged` is a nullable slot the host may assign.
 */

import { describe, expect, it } from 'vitest';

import type { McpRegistry, McpRegistrySnapshot } from '../../../src/soul-plus/mcp/registry.js';
import { NoopMcpRegistry } from '../../../src/soul-plus/mcp/registry.js';

describe('NoopMcpRegistry', () => {
  it('register / unregister / refresh resolve without side effects', async () => {
    const reg = new NoopMcpRegistry();
    await expect(
      reg.register({
        name: 'x',
        transport: 'stdio',
        command: 'echo',
      } as unknown as Parameters<McpRegistry['register']>[0]),
    ).resolves.toBeUndefined();
    await expect(reg.unregister('x')).resolves.toBeUndefined();
    await expect(reg.refresh('x')).resolves.toBeUndefined();
  });

  it('list returns an empty array', () => {
    const reg = new NoopMcpRegistry();
    expect(reg.list()).toEqual([]);
  });

  it('get returns undefined for any server id', () => {
    const reg = new NoopMcpRegistry();
    expect(reg.get('anything')).toBeUndefined();
  });

  it('status returns the empty snapshot', () => {
    const reg = new NoopMcpRegistry();
    const snap: McpRegistrySnapshot = reg.status();
    expect(snap.loading).toBe(false);
    expect(snap.total).toBe(0);
    expect(snap.connected).toBe(0);
    expect(snap.toolCount).toBe(0);
    expect(snap.servers).toEqual([]);
  });

  it('startAll / closeAll resolve without throwing', async () => {
    const reg = new NoopMcpRegistry();
    await expect(reg.startAll()).resolves.toBeUndefined();
    await expect(reg.closeAll()).resolves.toBeUndefined();
  });

  it('onToolsChanged defaults to null and is settable', () => {
    const reg = new NoopMcpRegistry();
    expect(reg.onToolsChanged).toBeNull();
    reg.onToolsChanged = () => {};
    expect(typeof reg.onToolsChanged).toBe('function');
    reg.onToolsChanged = null;
    expect(reg.onToolsChanged).toBeNull();
  });
});

describe('McpRegistry interface shape', () => {
  it('NoopMcpRegistry satisfies the McpRegistry interface', () => {
    const reg: McpRegistry = new NoopMcpRegistry();
    expect(typeof reg.register).toBe('function');
    expect(typeof reg.unregister).toBe('function');
    expect(typeof reg.refresh).toBe('function');
    expect(typeof reg.list).toBe('function');
    expect(typeof reg.get).toBe('function');
    expect(typeof reg.status).toBe('function');
    expect(typeof reg.startAll).toBe('function');
    expect(typeof reg.closeAll).toBe('function');
    // onToolsChanged is a slot, not a function — it's nullable.
    expect(reg.onToolsChanged === null || typeof reg.onToolsChanged === 'function').toBe(true);
  });
});
