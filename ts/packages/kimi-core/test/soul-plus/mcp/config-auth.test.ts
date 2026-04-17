/**
 * MCP config `auth: 'oauth'` field — Phase 19 Slice D.
 *
 * Extends the Slice 2.6 strict schema to accept an optional `auth`
 * literal on HTTP servers only. Stdio servers and unknown values must
 * still be rejected.
 */

import { describe, expect, it } from 'vitest';

import { isHttpServer, parseMcpConfig } from '../../../src/soul-plus/mcp/config.js';
import { MCPConfigError } from '../../../src/soul-plus/mcp/errors.js';

describe('parseMcpConfig — auth field (Slice D)', () => {
  it('accepts auth: "oauth" on an http server', () => {
    const cfg = parseMcpConfig({
      mcpServers: {
        linear: {
          url: 'https://mcp.linear.app/mcp',
          transport: 'http',
          auth: 'oauth',
        },
      },
    });
    const server = cfg.mcpServers['linear']!;
    expect(isHttpServer(server)).toBe(true);
    if (isHttpServer(server)) {
      expect(server.auth).toBe('oauth');
    }
  });

  it('defaults auth to undefined on an http server without the field', () => {
    const cfg = parseMcpConfig({
      mcpServers: {
        ctx: { url: 'https://mcp.context7.com/mcp', transport: 'http' },
      },
    });
    const server = cfg.mcpServers['ctx']!;
    if (isHttpServer(server)) {
      expect(server.auth).toBeUndefined();
    } else {
      throw new Error('expected http server');
    }
  });

  it('rejects auth values other than "oauth" (device / bearer / etc.)', () => {
    expect(() =>
      parseMcpConfig({
        mcpServers: {
          bad: { url: 'https://example.com/mcp', transport: 'http', auth: 'device' },
        },
      }),
    ).toThrow(MCPConfigError);
  });

  it('rejects auth on a stdio server (strict mode)', () => {
    expect(() =>
      parseMcpConfig({
        mcpServers: {
          local: { command: 'node', args: ['srv.js'], auth: 'oauth' },
        },
      }),
    ).toThrow(MCPConfigError);
  });
});
