/**
 * buildMcpManager — shared MCP construction helper (RR2-M-A).
 *
 * Extracts the common MCPManager construction + loadAll + error-handling
 * block that was duplicated between `bootstrapCoreShell` (TUI path) and
 * `runWire` (wire path). Callers pass the MCPManager constructor so each
 * path controls whether the import is eager or lazy.
 */

import type {
  EventSink,
  Logger,
  MCPManager,
  McpConfig,
  Tool,
} from '@moonshot-ai/core';

interface McpLoadNotif {
  readonly kind: 'loading' | 'loaded' | 'failed';
  readonly serverName: string;
  readonly toolCount?: number | undefined;
  readonly error?: string | undefined;
}

export interface BuildMcpManagerOptions {
  readonly config: McpConfig;
  readonly eventSink: EventSink;
  readonly logger?: Logger | undefined;
  /** The MCPManager class (passed by value so callers control eager vs lazy import). */
  readonly MCPManager: new (opts: {
    config: McpConfig;
    eventSink?: EventSink | undefined;
    logger?: Logger | undefined;
    onNotify?: (notif: McpLoadNotif) => void;
    onStderr?: (server: string, line: string) => void;
  }) => MCPManager;
  /** The MCPConfigError class for instanceof checks in error handling. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly MCPConfigError: new (...args: any[]) => Error;
  /**
   * When true, non-MCPConfigError exceptions are re-thrown after logging.
   * bootstrapCoreShell: false (fall through, degraded mode)
   * runWire: true (unexpected errors should surface)
   */
  readonly rethrowUnknown?: boolean | undefined;
}

export interface BuildMcpManagerResult {
  readonly manager: MCPManager | undefined;
  readonly tools: readonly Tool[];
}

export async function buildMcpManager(
  opts: BuildMcpManagerOptions,
): Promise<BuildMcpManagerResult> {
  let manager: MCPManager | undefined;
  try {
    manager = new opts.MCPManager({
      config: opts.config,
      eventSink: opts.eventSink,
      ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
      onNotify: (notif: McpLoadNotif) => {
        if (notif.kind === 'loading') {
          process.stderr.write(`[mcp] ${notif.serverName}: connecting...\n`);
        } else if (notif.kind === 'loaded') {
          process.stderr.write(
            `[mcp] ${notif.serverName}: ${String(notif.toolCount ?? 0)} tools loaded\n`,
          );
        } else {
          process.stderr.write(
            `[mcp] ${notif.serverName}: failed (${notif.error ?? 'unknown error'})\n`,
          );
        }
      },
      onStderr: (server, line) => {
        process.stderr.write(`[mcp:${server}] ${line}\n`);
      },
    });
    await manager.loadAll();
    return { manager, tools: manager.getTools() };
  } catch (error) {
    if (manager !== undefined) {
      await manager.close();
    }
    if (!(error instanceof opts.MCPConfigError) && opts.rethrowUnknown === true) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    const label = error instanceof opts.MCPConfigError ? 'MCP config invalid' : 'MCP startup failed';
    process.stderr.write(`warning: ${label}, skipping: ${message}\n`);
    return { manager: undefined, tools: [] };
  }
}
