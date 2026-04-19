/**
 * Slice 5 / 决策 #96 (L1): Tool Result Budget enforcement at the
 * ToolCallOrchestrator afterToolCall seam.
 *
 * Specification (v2 §10.6):
 *   - DEFAULT_BUILTIN_MAX_RESULT_CHARS = 50_000
 *   - DEFAULT_MCP_MAX_RESULT_CHARS    = 100_000
 *   - PREVIEW_SIZE_BYTES               = 2_000
 *   - afterToolCall checks `tool.maxResultSizeChars ?? DEFAULT_BUILTIN_MAX_RESULT_CHARS`:
 *       maxChars === Infinity   → never persist (adaptive tools like Read)
 *       content.length > maxChars → persist full content to
 *                                   `pathConfig.toolResultArchivePath(sessionId, toolCallId)`
 *                                   and REPLACE result.content with:
 *         `<persisted-output path="...">\n<preview (2000 chars)>\n</persisted-output>`
 *
 * Contract points coordinator needs to pin (see migration-report.md):
 *   Q1. PathConfig extension — we assume option (a): extend
 *       `src/session/path-config.ts` with a `toolResultArchivePath` method.
 *   Q2. Default builtin vs MCP distinction — we assume option (c): the
 *       orchestrator uses DEFAULT_BUILTIN_MAX_RESULT_CHARS when
 *       `tool.maxResultSizeChars` is undefined; MCP adapters construct
 *       themselves with `maxResultSizeChars: 100_000` explicitly.
 *
 * This file drives the orchestrator through its afterToolCall seam
 * end-to-end. Phase 5 Implementer must decide the internal wiring (new
 * dep on ToolCallOrchestrator? Separate ToolResultPersister pulled out of
 * the orchestrator?). The test targets an IMPLEMENTATION-VISIBLE seam:
 * `orchestrator.enforceResultBudget(tool, toolCallId, result)` — the
 * Implementer MAY rename it but the migration-report asks for a helper
 * of this signature so tests can isolate the budget logic.
 *
 * Expected to FAIL before Phase 5:
 *   - `DEFAULT_BUILTIN_MAX_RESULT_CHARS` / `DEFAULT_MCP_MAX_RESULT_CHARS`
 *     exports do not exist.
 *   - `PathConfig.toolResultArchivePath` does not exist.
 *   - Orchestrator has no result-budget enforcement method.
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  DEFAULT_BUILTIN_MAX_RESULT_CHARS,
  DEFAULT_MCP_MAX_RESULT_CHARS,
} from '../../src/tools/index.js';

import { HookEngine } from '../../src/hooks/engine.js';
import type { HookExecutor } from '../../src/hooks/types.js';
import { AlwaysAllowApprovalRuntime } from '../../src/soul-plus/approval-runtime.js';
import { ToolCallOrchestrator } from '../../src/soul-plus/orchestrator.js';
import { PathConfig } from '../../src/session/index.js';
import type { Tool, ToolResult } from '../../src/soul/types.js';

// ── helpers ───────────────────────────────────────────────────────────

function noopHookEngine(): HookEngine {
  const executor: HookExecutor = {
    type: 'command',
    execute: vi.fn().mockResolvedValue({ ok: true }),
  };
  return new HookEngine({ executors: new Map([['command', executor]]) });
}

function makeTool(
  overrides: Partial<Tool> & { maxResultSizeChars?: number },
): Tool {
  return {
    name: 'FakeBudgetTool',
    description: 'test',
    inputSchema: z.object({}),
    async execute(): Promise<ToolResult> {
      return { content: 'ok' };
    },
    ...overrides,
  };
}

interface BudgetableOrchestrator {
  enforceResultBudget(
    tool: Tool,
    toolCallId: string,
    result: ToolResult,
  ): Promise<ToolResult>;
}

function makeOrchestrator(args: {
  sessionId?: string;
  pathConfig?: PathConfig;
}): BudgetableOrchestrator {
  // The Phase 5 Implementer will extend ToolCallOrchestratorDeps with a
  // `pathConfig` field (or thread it through a sub-service). The cast
  // here is the Test Migrator's declared expectation — see
  // migration-report.md Q1 for the contract point.
  const deps = {
    hookEngine: noopHookEngine(),
    sessionId: args.sessionId ?? 'sess_budget',
    agentId: 'agent_main',
    approvalRuntime: new AlwaysAllowApprovalRuntime(),
    pathConfig: args.pathConfig,
  } as unknown as ConstructorParameters<typeof ToolCallOrchestrator>[0];
  const orch = new ToolCallOrchestrator(deps);
  return orch as unknown as BudgetableOrchestrator;
}

// ── constants ─────────────────────────────────────────────────────────

describe.sequential('Tool result budget — constants (决策 #96 L1)', () => {
  it('DEFAULT_BUILTIN_MAX_RESULT_CHARS = 50_000', () => {
    expect(DEFAULT_BUILTIN_MAX_RESULT_CHARS).toBe(50_000);
  });
  it('DEFAULT_MCP_MAX_RESULT_CHARS = 100_000', () => {
    expect(DEFAULT_MCP_MAX_RESULT_CHARS).toBe(100_000);
  });
});

// ── PathConfig extension (Q1 contract point, assumed option (a)) ─────

describe.sequential('PathConfig.toolResultArchivePath (Q1 contract assumption)', () => {
  it('builds a deterministic per-session, per-tool-call file path under sessionDir', () => {
    const cfg = new PathConfig({ home: '/test/kimi' });
    const p: string = cfg.toolResultArchivePath('ses_1', 'tc_42');
    expect(p.startsWith('/test/kimi/sessions/ses_1/')).toBe(true);
    // filename carries the tool_call_id; extension is implementer-owned.
    expect(p).toContain('tc_42');
  });

  it('distinct tool call ids map to distinct file paths', () => {
    const cfg = new PathConfig({ home: '/test/kimi' });
    const a: string = cfg.toolResultArchivePath('ses_1', 'tc_a');
    const b: string = cfg.toolResultArchivePath('ses_1', 'tc_b');
    expect(a).not.toBe(b);
  });

  it('distinct session ids map to distinct file paths for the same tool call id', () => {
    const cfg = new PathConfig({ home: '/test/kimi' });
    const x: string = cfg.toolResultArchivePath('ses_x', 'tc_1');
    const y: string = cfg.toolResultArchivePath('ses_y', 'tc_1');
    expect(x).not.toBe(y);
  });
});

// ── afterToolCall budget enforcement ──────────────────────────────────

describe.sequential('Orchestrator — budget enforcement at afterToolCall seam', () => {
  let workDir: string;
  let pathConfig: PathConfig;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kimi-tool-budget-'));
    pathConfig = new PathConfig({ home: workDir });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('small result (< DEFAULT_BUILTIN_MAX_RESULT_CHARS) passes through unchanged and writes no file', async () => {
    const tool = makeTool({}); // uses default builtin budget
    const orch = makeOrchestrator({ sessionId: 'ses_small', pathConfig });
    const input: ToolResult = { content: 'small output' };

    const out = await orch.enforceResultBudget(tool, 'tc_small', input);

    expect(out.content).toBe('small output');
    const archivePath = pathConfig.toolResultArchivePath('ses_small', 'tc_small');
    await expect(stat(archivePath)).rejects.toThrow(); // file must not exist
  });

  it('large result (> DEFAULT_BUILTIN_MAX_RESULT_CHARS) is persisted and replaced with preview', async () => {
    const big = 'A'.repeat(DEFAULT_BUILTIN_MAX_RESULT_CHARS + 500);
    const tool = makeTool({});
    const orch = makeOrchestrator({ sessionId: 'ses_big', pathConfig });
    const input: ToolResult = { content: big };

    const out = await orch.enforceResultBudget(tool, 'tc_big', input);

    const archivePath = pathConfig.toolResultArchivePath('ses_big', 'tc_big');
    const onDisk = await readFile(archivePath, 'utf8');
    expect(onDisk).toBe(big);

    expect(typeof out.content).toBe('string');
    const replaced = out.content as string;
    expect(replaced).toContain('<persisted-output');
    expect(replaced).toContain(archivePath);
    expect(replaced).toContain('</persisted-output>');
    // Preview cap — 2000 chars from the head of the raw content.
    expect(replaced).toContain('A'.repeat(2000));
  });

  it('preview is truncated to first 2000 characters of the original content', async () => {
    const prefix = 'X'.repeat(2000);
    const suffix = 'Y'.repeat(DEFAULT_BUILTIN_MAX_RESULT_CHARS);
    const tool = makeTool({});
    const orch = makeOrchestrator({ sessionId: 'ses_cap', pathConfig });

    const out = await orch.enforceResultBudget(
      tool,
      'tc_cap',
      { content: prefix + suffix },
    );

    const replaced = out.content as string;
    // `replaced` wraps the preview in `<persisted-output path="...">...</persisted-output>`,
    // and the path embeds an mkdtemp suffix (base62 — may contain `Y`), so the
    // Y-exclusion check must run only against the preview body.
    const previewStart = replaced.indexOf('>\n') + 2;
    const previewEnd = replaced.lastIndexOf('\n</persisted-output>');
    const previewOnly = replaced.slice(previewStart, previewEnd);
    expect(previewOnly).toContain(prefix);
    expect(previewOnly.includes('Y')).toBe(false);
  });

  it('tool.maxResultSizeChars === Infinity never persists, even for huge content', async () => {
    const huge = 'Z'.repeat(DEFAULT_BUILTIN_MAX_RESULT_CHARS * 4);
    const tool = makeTool({ maxResultSizeChars: Number.POSITIVE_INFINITY });
    const orch = makeOrchestrator({ sessionId: 'ses_inf', pathConfig });

    const out = await orch.enforceResultBudget(tool, 'tc_inf', { content: huge });

    expect(out.content).toBe(huge);
    const archivePath = pathConfig.toolResultArchivePath('ses_inf', 'tc_inf');
    await expect(stat(archivePath)).rejects.toThrow();
  });

  it('custom maxResultSizeChars = 100 triggers persistence above 100 chars', async () => {
    const tool = makeTool({ maxResultSizeChars: 100 });
    const orch = makeOrchestrator({ sessionId: 'ses_c100', pathConfig });

    const under = await orch.enforceResultBudget(
      tool,
      'tc_under',
      { content: 'short string' },
    );
    expect(under.content).toBe('short string');

    const over = await orch.enforceResultBudget(
      tool,
      'tc_over',
      { content: 'q'.repeat(150) },
    );
    const replaced = over.content as string;
    expect(replaced).toContain('<persisted-output');
    const overPath = pathConfig.toolResultArchivePath('ses_c100', 'tc_over');
    expect(await readFile(overPath, 'utf8')).toBe('q'.repeat(150));
  });

  it('isError-flagged results still go through the same budget check (huge error output persists)', async () => {
    const tool = makeTool({});
    const orch = makeOrchestrator({ sessionId: 'ses_err', pathConfig });
    const bigErr = 'E'.repeat(DEFAULT_BUILTIN_MAX_RESULT_CHARS + 10);

    const out = await orch.enforceResultBudget(
      tool,
      'tc_err',
      { content: bigErr, isError: true },
    );

    expect(out.isError).toBe(true);
    const replaced = out.content as string;
    expect(replaced).toContain('<persisted-output');
    const p = pathConfig.toolResultArchivePath('ses_err', 'tc_err');
    expect(await readFile(p, 'utf8')).toBe(bigErr);
  });

  it('MCP tool with maxResultSizeChars = DEFAULT_MCP_MAX_RESULT_CHARS (100_000) holds content up to 100K', async () => {
    const tool = makeTool({
      name: 'mcp__github__list_issues',
      maxResultSizeChars: DEFAULT_MCP_MAX_RESULT_CHARS,
    });
    const orch = makeOrchestrator({ sessionId: 'ses_mcp', pathConfig });

    // 80K: under MCP budget, would be OVER builtin — MCP override saves it.
    const content80k = 'M'.repeat(80_000);
    const out = await orch.enforceResultBudget(
      tool,
      'tc_mcp_small',
      { content: content80k },
    );
    expect(out.content).toBe(content80k);

    // 120K: over MCP budget too, must persist.
    const content120k = 'M'.repeat(120_000);
    const big = await orch.enforceResultBudget(
      tool,
      'tc_mcp_big',
      { content: content120k },
    );
    expect((big.content as string).startsWith('<persisted-output')).toBe(true);
  });

  it('Phase 17 B.3: McpToolAdapter factory sets maxResultSizeChars = DEFAULT_MCP_MAX_RESULT_CHARS on the wrapped Tool', async () => {
    // Phase 17 B.3 — the MCP adapter must surface the 100K cap through
    // the field itself, not just via the default-per-branch orchestrator
    // logic. This pins regression at the construction site.
    const { mcpToolToKimiTool } = await import(
      '../../src/soul-plus/mcp/tool-adapter.js'
    );
    const fakeClient = {
      callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    } as unknown as Parameters<typeof mcpToolToKimiTool>[0]['client'];
    const wrapped = mcpToolToKimiTool({
      serverName: 'test-server',
      mcpTool: {
        name: 'ping',
        description: 'pings',
        inputSchema: { type: 'object', properties: {} },
      },
      client: fakeClient,
    });
    expect(wrapped.maxResultSizeChars).toBe(DEFAULT_MCP_MAX_RESULT_CHARS);
  });

  it('two tool calls in the same session write to distinct archive files', async () => {
    const tool = makeTool({});
    const orch = makeOrchestrator({ sessionId: 'ses_multi', pathConfig });
    const big = 'A'.repeat(DEFAULT_BUILTIN_MAX_RESULT_CHARS + 1);

    await orch.enforceResultBudget(tool, 'tc_one', { content: big });
    await orch.enforceResultBudget(tool, 'tc_two', { content: big });

    const p1 = pathConfig.toolResultArchivePath('ses_multi', 'tc_one');
    const p2 = pathConfig.toolResultArchivePath('ses_multi', 'tc_two');
    expect(p1).not.toBe(p2);
    await expect(stat(p1)).resolves.toBeDefined();
    await expect(stat(p2)).resolves.toBeDefined();
  });
});

// ── End-to-end: budget fires through the live afterToolCall closure ───
//
// The other tests above poke `enforceResultBudget` directly. This block
// proves the production wiring: TurnManager-built `toolsByName` →
// `buildAfterToolCall(ctx, toolsByName)` closure → enforceResultBudget
// invocation → `resultOverride` returned with a preview marker.

import type { AfterToolCallContext, ToolCall } from '../../src/soul/types.js';
import type { SoulContextState } from '../../src/storage/context-state.js';

describe.sequential('Orchestrator — closure-path budget enforcement (end-to-end)', () => {
  let workDir: string;
  let pathConfig: PathConfig;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kimi-tool-budget-e2e-'));
    pathConfig = new PathConfig({ home: workDir });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('buildAfterToolCall closure persists oversized results when toolsByName is threaded', async () => {
    const tool = makeTool({});
    const deps = {
      hookEngine: noopHookEngine(),
      sessionId: 'ses_e2e',
      agentId: 'agent_main',
      approvalRuntime: new AlwaysAllowApprovalRuntime(),
      pathConfig,
    } as unknown as ConstructorParameters<typeof ToolCallOrchestrator>[0];
    const orch = new ToolCallOrchestrator(deps);

    // Reproduce TurnManager's wiring: wrap → index → build closure with map.
    const wrapped = orch.wrapTools([tool]);
    const toolsByName = new Map(wrapped.map((t) => [t.name, t]));
    const closure = orch.buildAfterToolCall({ turnId: 'turn_1' }, toolsByName);

    const big = 'A'.repeat(DEFAULT_BUILTIN_MAX_RESULT_CHARS + 10);
    const toolCall: ToolCall = { id: 'tc_e2e', name: tool.name, args: {} };
    const ctx: AfterToolCallContext = {
      toolCall,
      args: {},
      result: { content: big },
      context: {} as unknown as SoulContextState,
    };

    const out = await closure(ctx, new AbortController().signal);

    expect(out?.resultOverride).toBeDefined();
    const replaced = out?.resultOverride?.content as string;
    expect(replaced).toContain('<persisted-output');
    expect(replaced).toContain('</persisted-output>');

    // File was actually written.
    const onDisk = await readFile(
      pathConfig.toolResultArchivePath('ses_e2e', 'tc_e2e'),
      'utf8',
    );
    expect(onDisk).toBe(big);
  });

  it('closure preserves Phase 5 fields through wrapTools — Infinity tool is never persisted', async () => {
    const tool = makeTool({ maxResultSizeChars: Number.POSITIVE_INFINITY });
    const deps = {
      hookEngine: noopHookEngine(),
      sessionId: 'ses_inf',
      agentId: 'agent_main',
      approvalRuntime: new AlwaysAllowApprovalRuntime(),
      pathConfig,
    } as unknown as ConstructorParameters<typeof ToolCallOrchestrator>[0];
    const orch = new ToolCallOrchestrator(deps);

    const wrapped = orch.wrapTools([tool]);
    // Sanity: wrapSingle must have forwarded `maxResultSizeChars`.
    expect(wrapped[0]?.maxResultSizeChars).toBe(Number.POSITIVE_INFINITY);

    const toolsByName = new Map(wrapped.map((t) => [t.name, t]));
    const closure = orch.buildAfterToolCall({ turnId: 'turn_1' }, toolsByName);

    const huge = 'Z'.repeat(DEFAULT_BUILTIN_MAX_RESULT_CHARS * 4);
    const toolCall: ToolCall = { id: 'tc_inf', name: tool.name, args: {} };
    const ctx: AfterToolCallContext = {
      toolCall,
      args: {},
      result: { content: huge },
      context: {} as unknown as SoulContextState,
    };

    const out = await closure(ctx, new AbortController().signal);

    // No resultOverride → original result flows through unchanged.
    expect(out?.resultOverride).toBeUndefined();
    await expect(stat(pathConfig.toolResultArchivePath('ses_inf', 'tc_inf'))).rejects.toThrow();
  });
});

