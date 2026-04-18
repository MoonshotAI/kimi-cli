/**
 * Merge multiple `McpConfig` blobs into one — Phase 21 Slice C.2.3.
 *
 * Used to combine the on-disk `[mcp.servers.*]` TOML subtree with any
 * `--mcp-config-file <path>` / `--mcp-config <json>` CLI overrides.
 * Order is later-wins, mirroring the way the host treats CLI args as
 * higher priority than config: identical `mcpServers` keys in later
 * configs replace earlier entries entirely (no per-field deep-merge —
 * MCP server shapes are tightly typed, so partial overrides are not
 * meaningful and would risk producing an invalid stdio/http hybrid).
 *
 * Returns `undefined` when the input list is empty or every entry is
 * effectively empty, so callers can keep a "no MCP wired" fast path.
 */

import type { McpConfig, McpServerConfig } from './config.js';

export function mergeMcpConfigs(configs: readonly McpConfig[]): McpConfig | undefined {
  if (configs.length === 0) return undefined;

  const merged: Record<string, McpServerConfig> = {};
  for (const cfg of configs) {
    for (const [name, server] of Object.entries(cfg.mcpServers)) {
      merged[name] = server;
    }
  }

  if (Object.keys(merged).length === 0) return undefined;
  return { mcpServers: merged };
}
