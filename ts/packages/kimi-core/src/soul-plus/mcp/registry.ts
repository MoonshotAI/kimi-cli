/**
 * McpRegistry interface + NoopMcpRegistry — Slice 7.2 (决策 #100).
 *
 * The registry is the host-side façade that owns lifecycle for every
 * connected MCP server. `NoopMcpRegistry` is the production zero-install
 * placeholder that kimi-core wires in when MCP is disabled, so upstream
 * code can depend on the interface unconditionally. A real connector-
 * backed implementation lands in a later slice; the no-op shape here is
 * its final form.
 */

import type { Tool } from '../../soul/types.js';
import type { MCPClient } from './client.js';
import type { McpServerConfig } from './config.js';

export interface McpRegistrySnapshot {
  readonly loading: boolean;
  readonly total: number;
  readonly connected: number;
  readonly toolCount: number;
  readonly servers: ReadonlyArray<{
    readonly name: string;
    readonly status: 'pending' | 'connecting' | 'connected' | 'failed';
    readonly toolCount: number;
    readonly error?: string | undefined;
  }>;
}

export type McpToolsChangedCallback = (serverId: string, tools: Tool[]) => void;

export interface McpRegistry {
  register(config: McpServerConfig & { readonly name: string }): Promise<void>;
  unregister(serverId: string): Promise<void>;
  refresh(serverId: string): Promise<void>;
  list(): readonly MCPClient[];
  get(serverId: string): MCPClient | undefined;
  status(): McpRegistrySnapshot;
  startAll(): Promise<void>;
  closeAll(): Promise<void>;
  onToolsChanged: McpToolsChangedCallback | null;
}

export class NoopMcpRegistry implements McpRegistry {
  onToolsChanged: McpToolsChangedCallback | null = null;

  async register(_config: McpServerConfig & { readonly name: string }): Promise<void> {
    void _config;
  }
  async unregister(_serverId: string): Promise<void> {
    void _serverId;
  }
  async refresh(_serverId: string): Promise<void> {
    void _serverId;
  }
  list(): readonly MCPClient[] {
    return [];
  }
  get(_serverId: string): MCPClient | undefined {
    void _serverId;
    return undefined;
  }
  status(): McpRegistrySnapshot {
    return { loading: false, total: 0, connected: 0, toolCount: 0, servers: [] };
  }
  async startAll(): Promise<void> {}
  async closeAll(): Promise<void> {}
}
