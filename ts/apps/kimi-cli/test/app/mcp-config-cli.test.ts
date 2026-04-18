/**
 * Phase 21 Slice C.2.3 — MCP config CLI merge.
 *
 * Verifies `mergeMcpConfigs` (kimi-core) treats CLI inputs as later-wins
 * over the disk `[mcp.servers.*]` subtree, and that malformed inline
 * JSON surfaces as a clear error rather than being swallowed.
 */

import { describe, expect, it } from 'vitest';

import {
  MCPConfigError,
  mergeMcpConfigs,
  parseMcpConfig,
  type McpConfig,
} from '@moonshot-ai/core';

function makeConfig(servers: Record<string, unknown>): McpConfig {
  return parseMcpConfig({ mcpServers: servers });
}

describe('mergeMcpConfigs', () => {
  it('preserves disk entries when no CLI overrides are present', () => {
    const disk = makeConfig({
      filesystem: { command: 'npx', args: ['-y', 'fs-server'] },
      slack: { url: 'https://slack.example.com/mcp', transport: 'http' },
    });

    const merged = mergeMcpConfigs([disk]);
    expect(merged).toBeDefined();
    expect(Object.keys(merged!.mcpServers).sort()).toEqual(['filesystem', 'slack']);
  });

  it('CLI overrides win against disk for matching server names', () => {
    const disk = makeConfig({
      filesystem: { command: 'npx', args: ['-y', 'fs-server'] },
    });
    const cli = makeConfig({
      filesystem: { command: '/usr/local/bin/fs-server-prod' },
      slack: { url: 'https://slack.example.com/mcp', transport: 'http' },
    });

    const merged = mergeMcpConfigs([disk, cli]);
    expect(merged).toBeDefined();
    const fs = merged!.mcpServers['filesystem'];
    expect(fs).toBeDefined();
    if (fs && 'command' in fs) {
      expect(fs.command).toBe('/usr/local/bin/fs-server-prod');
    } else {
      throw new Error('expected stdio server entry');
    }
    // Disk-only siblings are untouched; CLI-only entries are appended.
    expect(merged!.mcpServers['slack']).toBeDefined();
  });

  it('parseMcpConfig throws MCPConfigError on a malformed inline payload', () => {
    expect(() => parseMcpConfig({ mcpServers: { broken: { foo: 'bar' } } })).toThrow(
      MCPConfigError,
    );
  });
});
