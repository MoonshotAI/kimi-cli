/**
 * `kimi mcp add|remove|list` — Phase 21 Slice E.3.
 *
 * Exercises the newly-implemented CRUD commands through Commander,
 * driven by an in-memory MCP config backed by `loadConfig`/`saveConfig`
 * on the shared `McpCommandDeps` surface.
 */

import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import type { McpCommandDeps } from '../../src/cli/sub/mcp.js';
import { registerMcpCommand } from '../../src/cli/sub/mcp.js';
import type { McpConfig } from '@moonshot-ai/core';

class ExitCalled extends Error {
  constructor(public readonly code: number) {
    super(`exit(${code})`);
  }
}

interface Streams {
  stdout: string[];
  stderr: string[];
  exitCodes: number[];
}

function makeDeps(initial: McpConfig): {
  deps: McpCommandDeps;
  streams: Streams;
  saved: McpConfig[];
} {
  const streams: Streams = { stdout: [], stderr: [], exitCodes: [] };
  // Mutate-in-place so successive `add` / `remove` observe prior writes.
  let current: McpConfig = initial;
  const saved: McpConfig[] = [];

  const deps: McpCommandDeps = {
    loadConfig: vi.fn(async () => current) as McpCommandDeps['loadConfig'],
    saveConfig: vi.fn(async (next: McpConfig) => {
      current = next;
      saved.push(next);
    }) as McpCommandDeps['saveConfig'],
    configPath: '/tmp/mcp.json',
    createProvider: (() => ({
      clear: async () => {},
    })) as unknown as McpCommandDeps['createProvider'],
    startCallbackServer: (async () => ({
      port: 0,
      redirectUri: 'http://127.0.0.1:0/callback',
      waitForCode: async () => ({ code: '' }),
      close: async () => {},
    })) as McpCommandDeps['startCallbackServer'],
    createClient: (() => ({
      connect: async () => {},
      listTools: async () => [],
      close: async () => {},
    })) as McpCommandDeps['createClient'],
    exit: ((code: number) => {
      streams.exitCodes.push(code);
      throw new ExitCalled(code);
    }) as McpCommandDeps['exit'],
    stdout: {
      write: (chunk: string | Uint8Array) => {
        streams.stdout.push(
          typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(),
        );
        return true;
      },
    },
    stderr: {
      write: (chunk: string | Uint8Array) => {
        streams.stderr.push(
          typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(),
        );
        return true;
      },
    },
  };
  return { deps, streams, saved };
}

function buildProgram(deps: McpCommandDeps): Command {
  const program = new Command('kimi').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerMcpCommand(program, deps);
  return program;
}

async function runCli(deps: McpCommandDeps, argv: string[]): Promise<void> {
  const program = buildProgram(deps);
  try {
    await program.parseAsync(['node', 'kimi', ...argv]);
  } catch (err) {
    if (err instanceof ExitCalled) return;
    throw err;
  }
}

// ─── list ───────────────────────────────────────────────────────────

describe('kimi mcp list', () => {
  it('prints the config path and every server entry', async () => {
    const { deps, streams } = makeDeps({
      mcpServers: {
        linear: { url: 'https://mcp.linear.app/mcp', transport: 'http', auth: 'oauth' },
        local: { command: 'node', args: ['srv.js'] },
      },
    });
    await runCli(deps, ['mcp', 'list']);
    const text = streams.stdout.join('');
    expect(text).toContain('/tmp/mcp.json');
    expect(text).toContain('linear (http)');
    expect(text).toContain('https://mcp.linear.app/mcp');
    expect(text).toContain('oauth');
    expect(text).toContain('local (stdio): node srv.js');
  });

  it('reports no servers when the config is empty', async () => {
    const { deps, streams } = makeDeps({ mcpServers: {} });
    await runCli(deps, ['mcp', 'list']);
    expect(streams.stdout.join('').toLowerCase()).toContain('no mcp servers');
  });
});

// ─── add ────────────────────────────────────────────────────────────

describe('kimi mcp add', () => {
  it('adds a stdio server with args and env', async () => {
    const { deps, saved, streams } = makeDeps({ mcpServers: {} });
    await runCli(deps, [
      'mcp',
      'add',
      'chrome',
      '--transport',
      'stdio',
      '--env',
      'FOO=bar',
      '--env',
      'BAZ=qux',
      '--',
      'npx',
      'chrome-devtools-mcp@latest',
    ]);
    expect(streams.exitCodes).toEqual([]);
    expect(saved.length).toBe(1);
    const entry = saved[0]!.mcpServers['chrome'];
    expect(entry).toEqual({
      command: 'npx',
      args: ['chrome-devtools-mcp@latest'],
      env: { FOO: 'bar', BAZ: 'qux' },
    });
  });

  it('adds an http server with headers + oauth', async () => {
    const { deps, saved } = makeDeps({ mcpServers: {} });
    await runCli(deps, [
      'mcp',
      'add',
      'linear',
      '--transport',
      'http',
      '--header',
      'Authorization: Bearer xyz',
      '--auth',
      'oauth',
      'https://mcp.linear.app/mcp',
    ]);
    expect(saved[0]!.mcpServers['linear']).toEqual({
      url: 'https://mcp.linear.app/mcp',
      transport: 'http',
      headers: { Authorization: 'Bearer xyz' },
      auth: 'oauth',
    });
  });

  it('rejects a duplicate name without --force', async () => {
    const { deps, streams } = makeDeps({
      mcpServers: { existing: { command: 'a' } },
    });
    await runCli(deps, [
      'mcp',
      'add',
      'existing',
      '--transport',
      'stdio',
      '--',
      'other',
    ]);
    expect(streams.exitCodes).toContain(1);
    expect(streams.stderr.join('').toLowerCase()).toMatch(/already exists|force/);
  });

  it('overwrites a duplicate name with --force', async () => {
    const { deps, saved, streams } = makeDeps({
      mcpServers: { existing: { command: 'a' } },
    });
    await runCli(deps, [
      'mcp',
      'add',
      'existing',
      '--transport',
      'stdio',
      '--force',
      '--',
      'new-cmd',
      'arg1',
    ]);
    expect(streams.exitCodes).toEqual([]);
    expect(saved[0]!.mcpServers['existing']).toEqual({
      command: 'new-cmd',
      args: ['arg1'],
    });
  });

  it('rejects --env on an http transport', async () => {
    const { deps, streams } = makeDeps({ mcpServers: {} });
    await runCli(deps, [
      'mcp',
      'add',
      'x',
      '--transport',
      'http',
      '--env',
      'FOO=1',
      'https://example.com/mcp',
    ]);
    expect(streams.exitCodes).toContain(1);
    expect(streams.stderr.join('').toLowerCase()).toContain('env');
  });
});

// ─── remove ─────────────────────────────────────────────────────────

describe('kimi mcp remove', () => {
  it('removes an existing entry', async () => {
    const { deps, saved, streams } = makeDeps({
      mcpServers: {
        keep: { url: 'https://keep.example/mcp', transport: 'http' },
        drop: { command: 'bye' },
      },
    });
    await runCli(deps, ['mcp', 'remove', 'drop']);
    expect(streams.exitCodes).toEqual([]);
    expect(saved[0]!.mcpServers).toEqual({
      keep: { url: 'https://keep.example/mcp', transport: 'http' },
    });
  });

  it('exits 1 when the name does not exist', async () => {
    const { deps, saved, streams } = makeDeps({ mcpServers: {} });
    await runCli(deps, ['mcp', 'remove', 'absent']);
    expect(streams.exitCodes).toContain(1);
    expect(saved.length).toBe(0);
    expect(streams.stderr.join('').toLowerCase()).toContain('not found');
  });
});
