/**
 * MCP config parser — Slice 2.6 unit tests.
 */

import { describe, expect, it } from 'vitest';

import { isHttpServer, isStdioServer, parseMcpConfig } from '../../../src/soul-plus/mcp/config.js';
import { MCPConfigError } from '../../../src/soul-plus/mcp/errors.js';

describe('parseMcpConfig', () => {
  it('accepts a stdio server with command + args + env', () => {
    const cfg = parseMcpConfig({
      mcpServers: {
        'chrome-devtools': {
          command: 'npx',
          args: ['chrome-devtools-mcp@latest'],
          env: { NODE_ENV: 'production' },
        },
      },
    });
    const server = cfg.mcpServers['chrome-devtools']!;
    expect(isStdioServer(server)).toBe(true);
    if (isStdioServer(server)) {
      expect(server.command).toBe('npx');
      expect(server.args).toEqual(['chrome-devtools-mcp@latest']);
      expect(server.env).toEqual({ NODE_ENV: 'production' });
    }
  });

  it('accepts an http server with url + transport', () => {
    const cfg = parseMcpConfig({
      mcpServers: {
        context7: {
          url: 'https://mcp.context7.com/mcp',
          transport: 'http',
          headers: { CONTEXT7_API_KEY: 'xxx' },
        },
      },
    });
    const server = cfg.mcpServers['context7']!;
    expect(isHttpServer(server)).toBe(true);
    if (isHttpServer(server)) {
      expect(server.url).toBe('https://mcp.context7.com/mcp');
      expect(server.transport).toBe('http');
    }
  });

  it('accepts sse as a transport alias for streamable http', () => {
    const cfg = parseMcpConfig({
      mcpServers: {
        legacy: { url: 'https://example.com/mcp', transport: 'sse' },
      },
    });
    const server = cfg.mcpServers['legacy']!;
    expect(isHttpServer(server)).toBe(true);
  });

  it('accepts an empty mcpServers map', () => {
    const cfg = parseMcpConfig({ mcpServers: {} });
    expect(Object.keys(cfg.mcpServers)).toHaveLength(0);
  });

  it('rejects a stdio server missing command', () => {
    expect(() => parseMcpConfig({ mcpServers: { bad: { args: [] } } })).toThrow(MCPConfigError);
  });

  it('rejects an http server with a non-URL url', () => {
    expect(() =>
      parseMcpConfig({ mcpServers: { bad: { url: 'not a url', transport: 'http' } } }),
    ).toThrow(MCPConfigError);
  });

  it('rejects a top-level config without mcpServers', () => {
    expect(() => parseMcpConfig({ servers: {} })).toThrow(MCPConfigError);
  });

  it('rejects unknown fields at server level in strict mode', () => {
    expect(() =>
      parseMcpConfig({
        mcpServers: { bad: { command: 'foo', unexpected: 'field' } },
      }),
    ).toThrow(MCPConfigError);
  });
});
