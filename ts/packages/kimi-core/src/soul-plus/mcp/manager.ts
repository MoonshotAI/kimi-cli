/**
 * MCPManager — lifecycle orchestration for MCP servers (Slice 2.6).
 *
 * Host-owned resource. Construction is cheap; call {@link loadAll}
 * after construction to spawn the subprocess / open the HTTP
 * transport for every server in the config and run the
 * `tools/list` handshake. `loadAll` is expected to complete before
 * `SoulPlus` is constructed (Q1 方案 A): the host then merges
 * {@link getTools} into the `tools` array it passes to
 * `SoulPlusDeps`.
 *
 * Failure model — **graceful degrade**. Any single server that
 * fails to connect is marked `'failed'`; `loadAll` resolves
 * regardless so the rest of the session still boots. Tools from a
 * failed server are NOT registered, so the LLM sees a plain
 * "unknown tool" rather than a loading-state placeholder (Q2:
 * placeholder path dropped — there is no "loading" window once
 * `loadAll` has returned).
 *
 * Notifications — per-server `loading` / `loaded` / `failed`
 * events are surfaced via the caller-supplied
 * {@link MCPManagerOptions.onNotify} callback. The shape is
 * {@link McpLoadNotification}; the host is free to forward it to
 * a TUI toast, a log line, or simply discard it. `NotificationManager`
 * from Slice 2.4 is deliberately NOT wired here: it lives inside
 * `SoulPlus` which is constructed *after* `loadAll` completes, so
 * there is nothing to push to during load (Q1 方案 A).
 *
 * Session end — call {@link close} to dispose every transport.
 * Host is responsible for wiring this into its own session shutdown
 * hook (orchestrator does not own MCPManager lifecycle).
 */

import type { Tool } from '../../soul/index.js';
import { noopLogger, type Logger } from '../../utils/logger.js';
import { HttpMcpClient, StdioMcpClient, type MCPClient, type McpStderrCallback } from './client.js';
import { isHttpServer, isStdioServer, type McpConfig, type McpServerConfig } from './config.js';
import { mcpToolToKimiTool } from './tool-adapter.js';

/** Per-server lifecycle state. */
export type MCPServerStatus = 'pending' | 'connecting' | 'connected' | 'failed';

/** Loading-progress event surfaced to the host via `onNotify`. */
export interface McpLoadNotification {
  /** Server name as declared in the config. */
  readonly serverName: string;
  /** `loading` → started connecting; `loaded` → success; `failed` → gave up. */
  readonly kind: 'loading' | 'loaded' | 'failed';
  /** Count of tools exposed by this server. Only set when `kind='loaded'`. */
  readonly toolCount?: number | undefined;
  /** Error message. Only set when `kind='failed'`. */
  readonly error?: string | undefined;
}

export type McpNotifyCallback = (notif: McpLoadNotification) => void;

export interface MCPManagerOptions {
  readonly config: McpConfig;
  /** Host-injected progress callback (optional). */
  readonly onNotify?: McpNotifyCallback | undefined;
  /**
   * Host-injected stderr sink for stdio servers (optional). Receives
   * each line from a server's stderr stream; host decides how to
   * surface it (console.error, structured logger, wire, dropped).
   */
  readonly onStderr?: McpStderrCallback | undefined;
  /**
   * Override the per-tool timeout; forwarded to {@link mcpToolToKimiTool}.
   * Defaults to 60 s inside the adapter when unset.
   */
  readonly toolCallTimeoutMs?: number | undefined;
  /**
   * Factory for {@link MCPClient} instances. Tests inject an in-memory
   * fake; production leaves this undefined and the default spawns real
   * SDK transports.
   */
  readonly clientFactory?: McpClientFactory | undefined;
  /**
   * Phase 20 §C.3 / R-5 — structured logger used when a per-server
   * `client.close()` throws during shutdown. Defaults to `noopLogger`
   * so tests that don't care about the error path stay silent.
   * Production callers inject the pino adapter (via apps/kimi-cli).
   */
  readonly logger?: Logger | undefined;
}

export type McpClientFactory = (
  serverName: string,
  config: McpServerConfig,
  onStderr?: McpStderrCallback | undefined,
) => MCPClient;

interface ServerState {
  readonly name: string;
  readonly config: McpServerConfig;
  readonly client: MCPClient;
  status: MCPServerStatus;
  tools: Tool[];
  error?: string | undefined;
}

export class MCPManager {
  private readonly servers: Map<string, ServerState> = new Map();
  private readonly onNotify: McpNotifyCallback | undefined;
  private readonly onStderr: McpStderrCallback | undefined;
  private readonly toolCallTimeoutMs: number | undefined;
  private readonly clientFactory: McpClientFactory;
  private readonly logger: Logger;
  private loaded = false;

  constructor(options: MCPManagerOptions) {
    this.onNotify = options.onNotify;
    this.onStderr = options.onStderr;
    this.toolCallTimeoutMs = options.toolCallTimeoutMs;
    this.clientFactory = options.clientFactory ?? defaultClientFactory;
    this.logger = options.logger ?? noopLogger;

    for (const [name, serverConfig] of Object.entries(options.config.mcpServers)) {
      const client = this.clientFactory(name, serverConfig, this.onStderr);
      this.servers.set(name, {
        name,
        config: serverConfig,
        client,
        status: 'pending',
        tools: [],
      });
    }
  }

  /**
   * Connect every server in parallel and populate each server's
   * `tools` array. Never throws on per-server failure — servers that
   * can't start are marked `'failed'` and the manager carries on.
   * Call exactly once per session.
   */
  async loadAll(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;

    await Promise.all([...this.servers.values()].map((state) => this.connectServer(state)));
  }

  /**
   * All tools from successfully-connected servers, already adapted to
   * the kimi-core `Tool` shape with `mcp__<server>__<tool>` names.
   * Safe to call before `loadAll` (returns an empty array).
   */
  getTools(): Tool[] {
    const out: Tool[] = [];
    for (const state of this.servers.values()) {
      if (state.status === 'connected') {
        out.push(...state.tools);
      }
    }
    return out;
  }

  /**
   * Inspect a server's lifecycle state. Mainly used by tests and by
   * host code that wants to render a status page; kimi-core's own
   * runtime path only looks at {@link getTools}.
   */
  getServerStatus(name: string): MCPServerStatus | undefined {
    return this.servers.get(name)?.status;
  }

  /** True when a named server failed to connect during `loadAll`. */
  hasFailed(name: string): boolean {
    return this.servers.get(name)?.status === 'failed';
  }

  /** All server names known to the manager, in declaration order. */
  listServers(): string[] {
    return [...this.servers.keys()];
  }

  /** Close every transport. Idempotent; safe to call multiple times. */
  async close(): Promise<void> {
    const states = [...this.servers.values()];
    this.servers.clear();
    await Promise.all(
      states.map(async (state) => {
        try {
          await state.client.close();
        } catch (error) {
          // Cleanup must not throw — session is already on its way
          // out and we just want to release fds. We do NOT bubble
          // this up, but we leave a structured breadcrumb so a
          // developer tracking a zombie subprocess can see the
          // original failure instead of chasing a silent drop.
          this.logger.warn('[mcp-manager] error while closing server', {
            server_name: state.name,
            err: error,
          });
        }
      }),
    );
  }

  private async connectServer(state: ServerState): Promise<void> {
    state.status = 'connecting';
    this.emit({ serverName: state.name, kind: 'loading' });

    try {
      await state.client.connect();
      const mcpTools = await state.client.listTools();
      state.tools = mcpTools.map((mcpTool) =>
        mcpToolToKimiTool({
          serverName: state.name,
          mcpTool,
          client: state.client,
          ...(this.toolCallTimeoutMs !== undefined ? { timeoutMs: this.toolCallTimeoutMs } : {}),
        }),
      );
      state.status = 'connected';
      this.emit({
        serverName: state.name,
        kind: 'loaded',
        toolCount: state.tools.length,
      });
    } catch (error) {
      state.status = 'failed';
      state.tools = [];
      state.error = error instanceof Error ? error.message : String(error);
      this.emit({
        serverName: state.name,
        kind: 'failed',
        error: state.error,
      });
      // Try to close any half-opened transport so a failed connect
      // does not leak a zombie subprocess. Swallow close errors — we
      // already logged the original failure.
      try {
        await state.client.close();
      } catch {
        /* ignore */
      }
    }
  }

  private emit(notif: McpLoadNotification): void {
    if (this.onNotify === undefined) return;
    try {
      this.onNotify(notif);
    } catch {
      // Host callbacks must not crash the session.
    }
  }
}

function defaultClientFactory(
  serverName: string,
  config: McpServerConfig,
  onStderr?: McpStderrCallback | undefined,
): MCPClient {
  if (isStdioServer(config)) {
    return new StdioMcpClient(serverName, config, onStderr);
  }
  if (isHttpServer(config)) {
    return new HttpMcpClient(serverName, config);
  }
  // Exhaustive guard: adding a new transport variant without a branch
  // here is a compile error.
  const _never: never = config;
  void _never;
  throw new Error(`Unknown MCP server config for "${serverName}"`);
}
