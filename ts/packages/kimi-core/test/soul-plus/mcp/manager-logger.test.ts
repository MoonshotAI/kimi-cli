/**
 * Slice 20-B R-5 (part 3) — MCPManager structured logger.
 *
 * `src/soul-plus/mcp/manager.ts:182` calls `console.warn` directly when
 * a per-server `client.close()` throws during shutdown. That breaks the
 * same grep gate as NotificationManager (phase-20-todo.md hard indicator:
 * `grep console.warn packages/kimi-core/src` = 0). There is no `logger`
 * slot on `MCPManagerOptions` today.
 *
 * Phase 20 §C.3 adds:
 *   - `logger?: Logger` to `MCPManagerOptions`, default = `noopLogger`.
 *   - `close()` routes the catch-block warning through
 *     `this.logger.warn('[mcp-manager] error while closing server', {
 *       server_name, err })` — structured, greppable, session-scoped.
 *
 * Red bars below:
 *   - MCPManager construction accepts `logger: Logger`.
 *   - When a client's `close()` throws, logger.warn is invoked with
 *     structured meta containing the server name and the error.
 *   - `console.warn` stays at zero invocations when a logger is
 *     injected.
 *   - Even when no logger is provided, `console.warn` is zero (default
 *     noopLogger, not a console fallback).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  MCPClient,
  MCPToolDefinition,
  MCPToolResult,
} from '../../../src/soul-plus/mcp/client.js';
import type {
  McpConfig,
  McpServerConfig,
} from '../../../src/soul-plus/mcp/config.js';
import { MCPManager } from '../../../src/soul-plus/mcp/manager.js';
import type { Logger } from '../../../src/utils/logger.js';

// ── Fake MCP client — flipped into "throw on close" for this suite ──────

interface FakeTraits {
  readonly failOnConnect?: boolean;
  readonly throwOnClose?: boolean;
  readonly tools?: readonly MCPToolDefinition[];
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
    if (this.traits.failOnConnect === true) throw new Error('boom');
    this.connected = true;
  }
  async listTools(): Promise<MCPToolDefinition[]> {
    return [...(this.traits.tools ?? [])];
  }
  async callTool(name: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    this.toolCalls.push({ name, args });
    return { content: [{ type: 'text', text: 'ok' }], isError: false };
  }
  async close(): Promise<void> {
    this.closed += 1;
    if (this.traits.throwOnClose === true) {
      throw new Error(`close failed for ${this.serverName}`);
    }
  }
}

function makeConfig(names: string[]): McpConfig {
  const servers: Record<string, McpServerConfig> = {};
  for (const name of names) {
    servers[name] = { command: 'noop', args: [] };
  }
  return { mcpServers: servers };
}

// ── Recording logger ────────────────────────────────────────────────────

interface LoggerCall {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly msg: string;
  readonly meta?: Record<string, unknown> | undefined;
}

function makeRecordingLogger(): { logger: Logger; calls: LoggerCall[] } {
  const calls: LoggerCall[] = [];
  const make = (bindings: Record<string, unknown> = {}): Logger => ({
    debug: (msg, meta) =>
      calls.push({ level: 'debug', msg, meta: { ...bindings, ...meta } }),
    info: (msg, meta) =>
      calls.push({ level: 'info', msg, meta: { ...bindings, ...meta } }),
    warn: (msg, meta) =>
      calls.push({ level: 'warn', msg, meta: { ...bindings, ...meta } }),
    error: (msg, meta) =>
      calls.push({ level: 'error', msg, meta: { ...bindings, ...meta } }),
    child: (b) => make({ ...bindings, ...b }),
  });
  return { logger: make(), calls };
}

// ── Tests ───────────────────────────────────────────────────────────────

let warnSpy: ReturnType<typeof vi.spyOn> | undefined;

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- vitest MockInstance is any-typed; restoration is safe.
  warnSpy?.mockRestore();
  warnSpy = undefined;
});

describe('Phase 20 R-5 — MCPManager accepts a Logger', () => {
  it('construction typechecks with logger: Logger', () => {
    const { logger } = makeRecordingLogger();
    const manager = new MCPManager({
      config: makeConfig(['a']),
      logger,
      clientFactory: (name) =>
        new FakeClient(name, { tools: [{ name: 't', description: '', inputSchema: {} }] }),
    });
    expect(manager).toBeInstanceOf(MCPManager);
  });
});

describe('Phase 20 R-5 — close() routes failures through logger.warn', () => {
  it('records a warn call with server name + error in structured meta', async () => {
    const { logger, calls } = makeRecordingLogger();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const manager = new MCPManager({
      config: makeConfig(['files']),
      logger,
      clientFactory: (name) =>
        new FakeClient(name, {
          throwOnClose: true,
          tools: [{ name: 'list', description: '', inputSchema: {} }],
        }),
    });
    await manager.loadAll();
    await manager.close();

    const warnCalls = calls.filter((c) => c.level === 'warn');
    expect(warnCalls.length).toBeGreaterThanOrEqual(1);

    // Meta must carry the server name as a named key (not interpolated
    // into the msg). Key name is up to the implementer — accept any of
    // a small set of conventional choices.
    const meta = warnCalls[0]!.meta!;
    const serverKey =
      'server_name' in meta
        ? meta['server_name']
        : 'serverName' in meta
          ? meta['serverName']
          : meta['server'];
    expect(serverKey).toBe('files');

    // The error itself must be attached (not stringified into msg) so
    // downstream log aggregators can capture the stack.
    const errorish = Object.values(meta).some(
      (v) =>
        v instanceof Error ||
        (typeof v === 'string' && v.includes('close failed for files')),
    );
    expect(errorish).toBe(true);
  });

  it('does NOT call console.warn when a Logger is injected', async () => {
    const { logger } = makeRecordingLogger();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const manager = new MCPManager({
      config: makeConfig(['files']),
      logger,
      clientFactory: (name) =>
        new FakeClient(name, {
          throwOnClose: true,
          tools: [{ name: 'list', description: '', inputSchema: {} }],
        }),
    });
    await manager.loadAll();
    await manager.close();

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does NOT call console.warn when NO logger is supplied (default = noopLogger)', async () => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const manager = new MCPManager({
      config: makeConfig(['files']),
      // logger intentionally omitted
      clientFactory: (name) =>
        new FakeClient(name, {
          throwOnClose: true,
          tools: [{ name: 'list', description: '', inputSchema: {} }],
        }),
    });
    await manager.loadAll();
    await manager.close();

    // Grep sentinel: `console.warn` inside packages/kimi-core/src must
    // remain zero. This proves the fallback path uses `noopLogger`,
    // NOT `console.warn`.
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
