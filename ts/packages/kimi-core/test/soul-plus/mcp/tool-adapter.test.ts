/**
 * MCP tool adapter — Slice 2.6 unit tests.
 *
 * Covers naming, happy-path execute, timeout path, callTool-error
 * path, abort propagation, and output-budget integration through a
 * fake MCPClient (no SDK required).
 */

import { describe, expect, it, vi } from 'vitest';

import type {
  CallToolOptions,
  MCPClient,
  MCPToolDefinition,
  MCPToolResult,
} from '../../../src/soul-plus/mcp/client.js';
import {
  DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS,
  MCP_TOOL_NAME_PREFIX,
  mcpToolName,
  mcpToolToKimiTool,
  parseMcpToolName,
} from '../../../src/soul-plus/mcp/tool-adapter.js';
import type { ToolResult, ToolResultContent } from '../../../src/soul/types.js';

const baseDef: MCPToolDefinition = {
  name: 'get_files',
  description: 'Return files in a folder',
  inputSchema: { type: 'object', properties: {} },
};

class FakeClient implements MCPClient {
  public calls: Array<{
    name: string;
    args: Record<string, unknown>;
    signal: AbortSignal | undefined;
  }> = [];
  constructor(
    private readonly impl: (name: string, args: Record<string, unknown>) => Promise<MCPToolResult>,
  ) {}
  async connect(): Promise<void> {}
  async listTools(): Promise<MCPToolDefinition[]> {
    return [];
  }
  async callTool(
    name: string,
    args: Record<string, unknown>,
    options?: CallToolOptions,
  ): Promise<MCPToolResult> {
    this.calls.push({ name, args, signal: options?.signal });
    return this.impl(name, args);
  }
  async close(): Promise<void> {}
}

function asTextParts(content: string | ToolResultContent[]): string[] {
  if (typeof content === 'string') return [content];
  return content
    .filter((p): p is Extract<ToolResultContent, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text);
}

describe('mcpToolName / parseMcpToolName', () => {
  it('uses the mcp__server__tool convention', () => {
    expect(mcpToolName('files', 'read')).toBe('mcp__files__read');
  });

  it('round-trips through parseMcpToolName', () => {
    const name = mcpToolName('my-server', 'get_files');
    const parsed = parseMcpToolName(name);
    expect(parsed).toEqual({ serverName: 'my-server', toolName: 'get_files' });
  });

  it('returns null for non-MCP names', () => {
    expect(parseMcpToolName('Bash')).toBeNull();
    expect(parseMcpToolName('mcp__noSeparator')).toBeNull();
  });

  it('prefix constant matches the name helper', () => {
    expect(mcpToolName('s', 't').startsWith(MCP_TOOL_NAME_PREFIX)).toBe(true);
  });
});

describe('mcpToolToKimiTool execute', () => {
  it('calls the client with the MCP tool name and passes the args through', async () => {
    const client = new FakeClient(async () => ({
      content: [{ type: 'text', text: 'hello' }],
      isError: false,
    }));
    const tool = mcpToolToKimiTool({
      serverName: 'files',
      mcpTool: baseDef,
      client,
    });
    const controller = new AbortController();
    const result = await tool.execute('tc-1', { path: '/tmp' }, controller.signal);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.name).toBe('get_files');
    expect(client.calls[0]!.args).toEqual({ path: '/tmp' });
    expect(result.isError).toBe(false);
    expect(asTextParts(result.content)).toContain('hello');
  });

  it('coerces non-object args to {}', async () => {
    const client = new FakeClient(async () => ({
      content: [{ type: 'text', text: 'ok' }],
    }));
    const tool = mcpToolToKimiTool({ serverName: 's', mcpTool: baseDef, client });
    const controller = new AbortController();
    await tool.execute('tc-2', 'not-an-object' as unknown, controller.signal);
    expect(client.calls[0]?.args).toEqual({});
  });

  it('propagates isError from MCP results while still converting content', async () => {
    const client = new FakeClient(async () => ({
      content: [{ type: 'text', text: 'something broke' }],
      isError: true,
    }));
    const tool = mcpToolToKimiTool({ serverName: 's', mcpTool: baseDef, client });
    const controller = new AbortController();
    const result = await tool.execute('tc-3', {}, controller.signal);
    expect(result.isError).toBe(true);
    expect(asTextParts(result.content)).toContain('something broke');
  });

  it('returns a friendly ToolError on generic callTool rejection', async () => {
    const client = new FakeClient(async () => {
      throw new Error('connection reset');
    });
    const tool = mcpToolToKimiTool({ serverName: 's', mcpTool: baseDef, client });
    const controller = new AbortController();
    const result: ToolResult = await tool.execute('tc-4', {}, controller.signal);
    expect(result.isError).toBe(true);
    expect(asTextParts(result.content).join(' ')).toContain('connection reset');
  });

  it('returns a dedicated timeout error when the MCP call hangs', async () => {
    vi.useFakeTimers();
    try {
      const client: MCPClient = {
        async connect() {},
        async listTools() {
          return [];
        },
        callTool: () => new Promise(() => {}),
        async close() {},
      };
      const tool = mcpToolToKimiTool({
        serverName: 's',
        mcpTool: baseDef,
        client,
        timeoutMs: 500,
      });
      const controller = new AbortController();
      const pending = tool.execute('tc-5', {}, controller.signal);
      await vi.advanceTimersByTimeAsync(500);
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(asTextParts(result.content).join(' ')).toMatch(/timed out/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-throws aborts so Soul produces its synthetic abort result', async () => {
    const client: MCPClient = {
      async connect() {},
      async listTools() {
        return [];
      },
      callTool: () =>
        new Promise((_, reject) => {
          // never resolves unless aborted
          setTimeout(() => reject(new Error('late rejection')), 10_000).unref();
        }),
      async close() {},
    };
    const tool = mcpToolToKimiTool({ serverName: 's', mcpTool: baseDef, client });
    const controller = new AbortController();
    const pending = tool.execute('tc-6', {}, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
  });

  it('default timeout constant matches Python parity value', () => {
    expect(DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS).toBe(60_000);
  });

  it('forwards an AbortSignal into client.callTool so the SDK can cancel in-flight requests (M1)', async () => {
    const client = new FakeClient(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    const tool = mcpToolToKimiTool({ serverName: 's', mcpTool: baseDef, client });
    const controller = new AbortController();
    await tool.execute('tc-sig', {}, controller.signal);
    expect(client.calls).toHaveLength(1);
    const forwarded = client.calls[0]!.signal;
    expect(forwarded).toBeDefined();
    // Must be a child controller, not the parent — tool-adapter
    // links its own timer through the same controller so both abort
    // sources converge on one cancellation.
    expect(forwarded).not.toBe(controller.signal);
  });

  it('aborts the forwarded signal when the parent signal aborts (M1)', async () => {
    let capturedSignal: AbortSignal | undefined;
    const client: MCPClient = {
      async connect() {},
      async listTools() {
        return [];
      },
      callTool: (_name, _args, options) =>
        new Promise((_, reject) => {
          capturedSignal = options?.signal;
          capturedSignal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      async close() {},
    };
    const tool = mcpToolToKimiTool({ serverName: 's', mcpTool: baseDef, client });
    const controller = new AbortController();
    const pending = tool.execute('tc-sig-abort', {}, controller.signal);
    // Give the microtask queue a turn so callTool runs and captures
    // the signal before we abort.
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('aborts the forwarded signal when the timeout fires (M1)', async () => {
    vi.useFakeTimers();
    try {
      let capturedSignal: AbortSignal | undefined;
      const client: MCPClient = {
        async connect() {},
        async listTools() {
          return [];
        },
        callTool: (_name, _args, options) =>
          new Promise(() => {
            capturedSignal = options?.signal;
          }),
        async close() {},
      };
      const tool = mcpToolToKimiTool({
        serverName: 's',
        mcpTool: baseDef,
        client,
        timeoutMs: 200,
      });
      const controller = new AbortController();
      const pending = tool.execute('tc-sig-timeout', {}, controller.signal);
      await vi.advanceTimersByTimeAsync(200);
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(capturedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('mcpToolToKimiTool description', () => {
  it('prepends a prefix telling the LLM it is an MCP tool', () => {
    const client = new FakeClient(async () => ({ content: [] }));
    const tool = mcpToolToKimiTool({
      serverName: 'files',
      mcpTool: baseDef,
      client,
    });
    expect(tool.description).toContain('MCP');
    expect(tool.description).toContain('files');
    expect(tool.description).toContain('Return files in a folder');
  });

  it('falls back when the MCP tool has an empty description', () => {
    const client = new FakeClient(async () => ({ content: [] }));
    const tool = mcpToolToKimiTool({
      serverName: 'files',
      mcpTool: { ...baseDef, description: '' },
      client,
    });
    expect(tool.description).toContain('No description provided.');
  });
});

// ── Slice 7.2 (决策 #100) — metadata / budget / display alignment ───────

describe('mcpToolToKimiTool — v2 metadata alignment (Phase 7)', () => {
  it('carries source="mcp" + serverId + originalName in metadata', () => {
    const client = new FakeClient(async () => ({ content: [] }));
    const tool = mcpToolToKimiTool({
      serverName: 'files',
      mcpTool: baseDef,
      client,
    });
    const meta = (tool as unknown as { metadata?: Record<string, unknown> }).metadata;
    expect(meta).toBeDefined();
    expect(meta?.['source']).toBe('mcp');
    expect(meta?.['serverId']).toBe('files');
    expect(meta?.['originalName']).toBe('get_files');
  });

  it('sets maxResultSizeChars to 100_000 by default', () => {
    const client = new FakeClient(async () => ({ content: [] }));
    const tool = mcpToolToKimiTool({
      serverName: 'files',
      mcpTool: baseDef,
      client,
    });
    const maxChars = (tool as unknown as { maxResultSizeChars?: number }).maxResultSizeChars;
    expect(maxChars).toBe(100_000);
  });

  it('exposes a `display` slot for Phase 7 generic fallback (may be undefined)', () => {
    const client = new FakeClient(async () => ({ content: [] }));
    const tool = mcpToolToKimiTool({
      serverName: 'files',
      mcpTool: baseDef,
      client,
    });
    // Phase 1 of MCP display can be undefined (generic fallback), but
    // the property must exist as a contract so the UI layer can probe it
    // without `in`/`hasOwnProperty` checks leaking across versions.
    expect('display' in (tool as unknown as Record<string, unknown>)).toBe(true);
  });
});
