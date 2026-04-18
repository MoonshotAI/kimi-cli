/**
 * `kimi mcp auth|test|reset-auth` CLI handlers — Phase 19 Slice D.
 *
 * These exercise the Commander sub-commands through `parseAsync`,
 * injecting `McpCommandDeps` so the test never hits a real MCP server
 * or opens a browser. The production code path (no deps → real impls)
 * is covered indirectly by the kimi-core unit tests.
 */

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { McpCommandDeps } from '../../src/cli/sub/mcp.js';
import { registerMcpCommand } from '../../src/cli/sub/mcp.js';

// ─── Fixture factory ────────────────────────────────────────────────

interface CaptureStreams {
  readonly stdout: string[];
  readonly stderr: string[];
  readonly exitCodes: number[];
}

function makeDeps(overrides: Partial<McpCommandDeps> = {}): {
  deps: McpCommandDeps;
  streams: CaptureStreams;
} {
  const streams: CaptureStreams = { stdout: [], stderr: [], exitCodes: [] };

  const fakeProvider = {
    clear: vi.fn<() => Promise<void>>(async () => {}),
  };
  const fakeCallbackServer = {
    port: 54321,
    redirectUri: 'http://127.0.0.1:54321/callback',
    waitForCode: vi.fn<() => Promise<{ code: string }>>(async () => ({ code: 'auth-code-xyz' })),
    close: vi.fn<() => Promise<void>>(async () => {}),
  };

  // Transport fake: first connect throws UnauthorizedError, finishAuth succeeds, second connect OK.
  let connectCallCount = 0;
  const fakeTransport = {
    finishAuth: vi.fn<(code: string) => Promise<void>>(async () => {}),
  };

  const fakeClient = {
    connect: vi.fn<() => Promise<void>>(async () => {
      connectCallCount += 1;
      if (connectCallCount === 1) {
        const err = new Error('Unauthorized');
        (err as Error & { name: string }).name = 'UnauthorizedError';
        throw err;
      }
    }),
    listTools: vi.fn<() => Promise<Array<{ name: string; description: string }>>>(async () => [
      { name: 'search', description: 'Search for something' },
      { name: 'fetch', description: 'Fetch a page' },
    ]),
    close: vi.fn<() => Promise<void>>(async () => {}),
    transport: fakeTransport,
  };

  const defaultDeps: McpCommandDeps = {
    loadConfig: async () => ({
      mcpServers: {
        linear: { url: 'https://mcp.linear.app/mcp', transport: 'http', auth: 'oauth' },
        ctx: { url: 'https://mcp.context7.com/mcp', transport: 'http' },
        local: { command: 'node', args: ['srv.js'] },
      },
    }),
    saveConfig: vi.fn<(c: import('@moonshot-ai/core').McpConfig) => Promise<void>>(
      async () => {},
    ),
    configPath: '/tmp/test-mcp.json',
    createProvider: vi.fn(() => fakeProvider) as unknown as McpCommandDeps['createProvider'],
    startCallbackServer: vi.fn(async () => fakeCallbackServer) as McpCommandDeps['startCallbackServer'],
    createClient: vi.fn(() => fakeClient) as McpCommandDeps['createClient'],
    exit: ((code: number) => {
      streams.exitCodes.push(code);
      throw new ExitCalled(code);
    }) as McpCommandDeps['exit'],
    stdout: {
      write: (chunk: string | Uint8Array) => {
        streams.stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
        return true;
      },
    } as McpCommandDeps['stdout'],
    stderr: {
      write: (chunk: string | Uint8Array) => {
        streams.stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
        return true;
      },
    } as McpCommandDeps['stderr'],
  };

  return { deps: { ...defaultDeps, ...overrides }, streams };
}

class ExitCalled extends Error {
  constructor(public readonly code: number) {
    super(`exit(${code})`);
  }
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

// ─── Tests ──────────────────────────────────────────────────────────

describe('kimi mcp auth <name>', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs the full PKCE dance: callback server → provider → connect retry → success', async () => {
    const { deps, streams } = makeDeps();
    await runCli(deps, ['mcp', 'auth', 'linear']);

    // Sequence: start server → make provider → make client → connect (throws Unauthorized) →
    //   waitForCode → transport.finishAuth → retry connect → close.
    expect(deps.startCallbackServer).toHaveBeenCalledTimes(1);
    expect(deps.createProvider).toHaveBeenCalledWith('linear', 54321);
    expect(deps.createClient).toHaveBeenCalledTimes(1);

    const joined = streams.stdout.join('');
    expect(joined.toLowerCase()).toMatch(/success|authorized|linear/);
    expect(streams.exitCodes.every((c) => c === 0) || streams.exitCodes.length === 0).toBe(true);
  });

  it('exits 1 when the server name is not in the config', async () => {
    const { deps, streams } = makeDeps();
    await runCli(deps, ['mcp', 'auth', 'does-not-exist']);
    expect(streams.exitCodes).toContain(1);
    expect(streams.stderr.join('').toLowerCase()).toMatch(/not found|unknown|no such/);
  });

  it('exits 1 when the named server is stdio (OAuth only applies to http)', async () => {
    const { deps, streams } = makeDeps();
    await runCli(deps, ['mcp', 'auth', 'local']);
    expect(streams.exitCodes).toContain(1);
    expect(streams.stderr.join('').toLowerCase()).toMatch(/http|oauth|stdio|only/);
  });
});

describe('kimi mcp test <name>', () => {
  let capturedStdout = '';

  beforeEach(() => {
    capturedStdout = '';
  });

  it('prints tool list and tool count on successful connection', async () => {
    const { deps, streams } = makeDeps();
    await runCli(deps, ['mcp', 'test', 'ctx']);
    capturedStdout = streams.stdout.join('');
    expect(capturedStdout).toContain('search');
    expect(capturedStdout).toContain('fetch');
    // Expect a count indication (e.g. "2 tool" or "2 tools").
    expect(capturedStdout).toMatch(/2\s*tools?/i);
    expect(streams.exitCodes.every((c) => c === 0) || streams.exitCodes.length === 0).toBe(true);
  });

  it('exits 1 when the server name is not in the config', async () => {
    const { deps, streams } = makeDeps();
    await runCli(deps, ['mcp', 'test', 'nope']);
    expect(streams.exitCodes).toContain(1);
  });
});

describe('kimi mcp reset-auth <name>', () => {
  it('calls provider.clear() and confirms on stdout', async () => {
    const clearSpy = vi.fn<() => Promise<void>>(async () => {});
    const { deps, streams } = makeDeps({
      createProvider: vi.fn(() => ({ clear: clearSpy })) as unknown as McpCommandDeps['createProvider'],
    });

    await runCli(deps, ['mcp', 'reset-auth', 'linear']);

    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(streams.stdout.join('').toLowerCase()).toMatch(/reset|removed|cleared|linear/);
    expect(streams.exitCodes.every((c) => c === 0) || streams.exitCodes.length === 0).toBe(true);
  });

  it('exits 1 when the server name is not in the config', async () => {
    const { deps, streams } = makeDeps();
    await runCli(deps, ['mcp', 'reset-auth', 'nope']);
    expect(streams.exitCodes).toContain(1);
  });
});
