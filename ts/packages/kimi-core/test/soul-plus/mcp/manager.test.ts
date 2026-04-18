/**
 * MCPManager — Slice 2.6 unit tests.
 *
 * Drives the manager with an in-memory fake `MCPClient` so the tests
 * don't touch the SDK or spawn any subprocesses. Covers:
 *   - loadAll success path with notifications in the expected order
 *   - graceful degrade on per-server failure (other servers still load)
 *   - getTools only returns connected tools with mcp__ prefix
 *   - close() disposes every client exactly once
 *   - hasFailed / getServerStatus / listServers surface state honestly
 */

import { describe, expect, it, vi } from 'vitest';

import type {
  MCPClient,
  MCPToolDefinition,
  MCPToolResult,
} from '../../../src/soul-plus/mcp/client.js';
import type { McpConfig, McpServerConfig } from '../../../src/soul-plus/mcp/config.js';
import { MCPManager, type McpLoadNotification } from '../../../src/soul-plus/mcp/manager.js';
import type { Logger } from '../../../src/utils/logger.js';

interface FakeTraits {
  readonly failOnConnect?: boolean;
  readonly tools?: MCPToolDefinition[];
}

class FakeClient implements MCPClient {
  public connected = false;
  public closed = 0;
  public toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  constructor(
    public readonly serverName: string,
    private readonly traits: FakeTraits,
  ) {}
  async connect(): Promise<void> {
    if (this.traits.failOnConnect === true) {
      throw new Error(`boom: ${this.serverName}`);
    }
    this.connected = true;
  }
  async listTools(): Promise<MCPToolDefinition[]> {
    return this.traits.tools ?? [];
  }
  async callTool(name: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    this.toolCalls.push({ name, args });
    return { content: [{ type: 'text', text: 'ok' }], isError: false };
  }
  async close(): Promise<void> {
    this.closed += 1;
    if (this.throwOnClose === true) {
      throw new Error(`close boom: ${this.serverName}`);
    }
  }
  public throwOnClose = false;
}

function makeConfig(names: string[]): McpConfig {
  const servers: Record<string, McpServerConfig> = {};
  for (const name of names) {
    servers[name] = { command: 'noop', args: [] };
  }
  return { mcpServers: servers };
}

describe('MCPManager.loadAll — happy path', () => {
  it('connects each server and exposes its tools with mcp__server__tool names', async () => {
    const clients: Record<string, FakeClient> = {};
    const notifications: McpLoadNotification[] = [];
    const manager = new MCPManager({
      config: makeConfig(['files', 'shell']),
      onNotify: (n) => notifications.push(n),
      clientFactory: (name) => {
        const client = new FakeClient(name, {
          tools: [
            {
              name: 'list',
              description: 'list items',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        });
        clients[name] = client;
        return client;
      },
    });

    await manager.loadAll();

    expect(manager.getServerStatus('files')).toBe('connected');
    expect(manager.getServerStatus('shell')).toBe('connected');
    const toolNames = manager
      .getTools()
      .map((t) => t.name)
      .toSorted();
    expect(toolNames).toEqual(['mcp__files__list', 'mcp__shell__list']);

    // Each server must emit both a 'loading' and a 'loaded' event.
    const byServer = notifications.reduce<Record<string, string[]>>((acc, n) => {
      const kinds = acc[n.serverName] ?? (acc[n.serverName] = []);
      kinds.push(n.kind);
      return acc;
    }, {});
    expect(byServer['files']).toEqual(['loading', 'loaded']);
    expect(byServer['shell']).toEqual(['loading', 'loaded']);

    // Both clients were connected (not left dormant) and not closed yet.
    expect(clients['files']!.connected).toBe(true);
    expect(clients['shell']!.connected).toBe(true);
    expect(clients['files']!.closed).toBe(0);
  });

  it('loadAll is idempotent — second call is a no-op', async () => {
    const factory = vi.fn().mockImplementation(
      (name: string) =>
        new FakeClient(name, {
          tools: [{ name: 't', description: '', inputSchema: {} }],
        }),
    );
    const manager = new MCPManager({
      config: makeConfig(['a']),
      clientFactory: factory,
    });
    await manager.loadAll();
    await manager.loadAll();
    // Factory only called during construction (not per loadAll).
    expect(factory).toHaveBeenCalledTimes(1);
  });
});

describe('MCPManager.loadAll — graceful degrade', () => {
  it('marks a failing server as failed without breaking its peers', async () => {
    const notifications: McpLoadNotification[] = [];
    const manager = new MCPManager({
      config: makeConfig(['good', 'bad']),
      onNotify: (n) => notifications.push(n),
      clientFactory: (name) => {
        if (name === 'bad') {
          return new FakeClient(name, { failOnConnect: true });
        }
        return new FakeClient(name, {
          tools: [{ name: 'ping', description: '', inputSchema: {} }],
        });
      },
    });

    await manager.loadAll();

    expect(manager.getServerStatus('good')).toBe('connected');
    expect(manager.getServerStatus('bad')).toBe('failed');
    expect(manager.hasFailed('bad')).toBe(true);

    // The good server's tool must still be exposed.
    const names = manager.getTools().map((t) => t.name);
    expect(names).toContain('mcp__good__ping');
    // No tools from the bad server.
    expect(names.some((n) => n.startsWith('mcp__bad__'))).toBe(false);

    const failNotif = notifications.find((n) => n.serverName === 'bad' && n.kind === 'failed');
    expect(failNotif).toBeDefined();
    expect(failNotif?.error).toContain('boom: bad');
  });

  it('closes any half-opened client for a failed server', async () => {
    const badClient = new FakeClient('bad', { failOnConnect: true });
    const manager = new MCPManager({
      config: makeConfig(['bad']),
      clientFactory: () => badClient,
    });
    await manager.loadAll();
    expect(badClient.closed).toBeGreaterThanOrEqual(1);
  });

  it('a throwing onNotify callback does not kill loadAll', async () => {
    const manager = new MCPManager({
      config: makeConfig(['s']),
      onNotify: () => {
        throw new Error('host notifier exploded');
      },
      clientFactory: (name) =>
        new FakeClient(name, {
          tools: [{ name: 't', description: '', inputSchema: {} }],
        }),
    });
    await expect(manager.loadAll()).resolves.toBeUndefined();
    expect(manager.getServerStatus('s')).toBe('connected');
  });
});

describe('MCPManager.close', () => {
  it('disposes every client and is idempotent', async () => {
    const clients: FakeClient[] = [];
    const manager = new MCPManager({
      config: makeConfig(['a', 'b']),
      clientFactory: (name) => {
        const c = new FakeClient(name, {
          tools: [{ name: 't', description: '', inputSchema: {} }],
        });
        clients.push(c);
        return c;
      },
    });
    await manager.loadAll();
    await manager.close();
    await manager.close();
    for (const c of clients) {
      expect(c.closed).toBe(1);
    }
    expect(manager.listServers()).toHaveLength(0);
  });

  it('logs a warning on per-server close errors but still finishes cleanly (N3)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Phase 20 R-5: console.warn fallback replaced with an injected
      // Logger. We record the warn calls on the Logger instead of on
      // `console.warn`; the final assertion continues to verify that
      // close() surfaces the failing server through the log sink.
      const warnCalls: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
      const logger: Logger = {
        debug: () => {},
        info: () => {},
        warn: (msg, meta) => {
          warnCalls.push({ msg, ...(meta !== undefined ? { meta } : {}) });
        },
        error: () => {},
        child: () => logger,
      };
      const bad = new FakeClient('grumpy', {
        tools: [{ name: 't', description: '', inputSchema: {} }],
      });
      bad.throwOnClose = true;
      const good = new FakeClient('calm', {
        tools: [{ name: 't', description: '', inputSchema: {} }],
      });
      const clients: Record<string, FakeClient> = { grumpy: bad, calm: good };
      const manager = new MCPManager({
        config: makeConfig(['grumpy', 'calm']),
        clientFactory: (name) => clients[name]!,
        logger,
      });
      await manager.loadAll();
      await expect(manager.close()).resolves.toBeUndefined();
      expect(good.closed).toBe(1);
      expect(bad.closed).toBe(1);
      const warned = warnCalls.some(
        (c) =>
          c.msg.includes('mcp-manager') &&
          c.meta !== undefined &&
          c.meta['server_name'] === 'grumpy',
      );
      expect(warned).toBe(true);
      // Grep sentinel: console.warn must remain untouched.
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
