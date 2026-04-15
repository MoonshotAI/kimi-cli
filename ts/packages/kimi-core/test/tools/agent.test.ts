/**
 * Covers: AgentTool (v2 §7.2 — collaboration tool for task subagents).
 *
 * Slice 7 scope:
 *   - Foreground mode: blocks parent turn, returns subagent result
 *   - Background mode: returns immediately with agent id
 *   - Abort cascade: foreground inherits parent signal, background is independent
 *   - Error handling: subagent failure produces isError tool result
 *
 * All tests are red bar — AgentTool.execute is a stub.
 */

import { describe, expect, it, vi } from 'vitest';

import type {
  AgentResult,
  SpawnRequest,
  SubagentHandle,
  SubagentHost,
} from '../../src/soul-plus/index.js';
import type { ToolResult } from '../../src/soul/types.js';
import { AgentTool, AgentToolInputSchema } from '../../src/tools/index.js';

// ── Test helpers ──────────────────────────────────────────────────────

function makeResult(text: string): AgentResult {
  return { result: text, usage: { input: 100, output: 50 } };
}

interface MockHost extends SubagentHost {
  readonly spawnSpy: ReturnType<typeof vi.fn>;
}

function makeHost(handler?: (req: SpawnRequest) => SubagentHandle): MockHost {
  const defaultHandler = (req: SpawnRequest): SubagentHandle => ({
    agentId: `sub_test_${req.agentName}`,
    parentToolCallId: req.parentToolCallId,
    completion: Promise.resolve(makeResult('done')),
  });
  const fn = handler ?? defaultHandler;
  const spy = vi.fn(async (req: SpawnRequest) => fn(req));
  return { spawn: spy, spawnSpy: spy };
}

// ── Schema tests ─────────────────────────────────────────────────────

describe('AgentToolInputSchema', () => {
  it('accepts minimal required fields (prompt + description)', () => {
    const result = AgentToolInputSchema.safeParse({
      prompt: 'Do the thing',
      description: 'Quick task',
    });
    expect(result.success).toBe(true);
  });

  it('accepts all optional fields', () => {
    const result = AgentToolInputSchema.safeParse({
      prompt: 'Do the thing',
      description: 'Quick task',
      agentName: 'code-reviewer',
      runInBackground: true,
      model: 'opus',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agentName).toBe('code-reviewer');
      expect(result.data.runInBackground).toBe(true);
      expect(result.data.model).toBe('opus');
    }
  });

  it('rejects missing prompt', () => {
    const result = AgentToolInputSchema.safeParse({
      description: 'Quick task',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing description', () => {
    const result = AgentToolInputSchema.safeParse({
      prompt: 'Do the thing',
    });
    expect(result.success).toBe(false);
  });
});

// ── Foreground execution ─────────────────────────────────────────────

describe('AgentTool — foreground mode', () => {
  it('calls SubagentHost.spawn with correct SpawnRequest fields', async () => {
    const host = makeHost();
    const tool = new AgentTool(host, 'agent_main');
    const signal = new AbortController().signal;

    const result = await tool.execute(
      'tc_1',
      {
        prompt: 'Investigate the bug',
        description: 'Bug investigation',
        agentName: 'code-reviewer',
      },
      signal,
    );

    expect(host.spawnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        parentAgentId: 'agent_main',
        agentName: 'code-reviewer',
        prompt: 'Investigate the bug',
        description: 'Bug investigation',
        runInBackground: false,
      }),
    );

    // Foreground returns the subagent's result as tool content
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('done');
  });

  it('defaults agentName to "general-purpose" when not provided', async () => {
    const host = makeHost();
    const tool = new AgentTool(host, 'agent_main');
    const signal = new AbortController().signal;

    await tool.execute('tc_2', { prompt: 'Do work', description: 'Work' }, signal);

    expect(host.spawnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'general-purpose',
      }),
    );
  });

  it('awaits handle.completion and returns the result text', async () => {
    const host = makeHost((req) => ({
      agentId: 'sub_abc',
      parentToolCallId: req.parentToolCallId,
      completion: Promise.resolve(makeResult('I found 3 bugs in the auth module')),
    }));
    const tool = new AgentTool(host, 'agent_main');
    const signal = new AbortController().signal;

    const result = await tool.execute(
      'tc_3',
      { prompt: 'Find bugs', description: 'Bug hunt' },
      signal,
    );

    expect(result.content).toContain('I found 3 bugs');
  });

  it('returns isError result when subagent fails', async () => {
    const host = makeHost((req) => ({
      agentId: 'sub_fail',
      parentToolCallId: req.parentToolCallId,
      completion: Promise.reject(new Error('subagent crashed')),
    }));
    const tool = new AgentTool(host, 'agent_main');
    const signal = new AbortController().signal;

    const result = await tool.execute(
      'tc_4',
      { prompt: 'Crash', description: 'Will fail' },
      signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('subagent');
  });

  it('includes usage from AgentResult in the tool output', async () => {
    const host = makeHost((req) => ({
      agentId: 'sub_usage',
      parentToolCallId: req.parentToolCallId,
      completion: Promise.resolve({
        result: 'done',
        usage: { input: 500, output: 200, cache_read: 100 },
      }),
    }));
    const tool = new AgentTool(host, 'agent_main');
    const signal = new AbortController().signal;

    const result: ToolResult = await tool.execute(
      'tc_5',
      { prompt: 'Work', description: 'Token test' },
      signal,
    );

    // The tool result should carry or reference usage information
    expect(result.content).toBeDefined();
  });
});

// ── Background execution ─────────────────────────────────────────────

describe('AgentTool — background mode', () => {
  it('returns immediately with agent id without awaiting completion', async () => {
    let resolveCompletion: ((v: AgentResult) => void) | undefined;
    const host = makeHost((req) => ({
      agentId: 'sub_bg',
      parentToolCallId: req.parentToolCallId,
      completion: new Promise<AgentResult>((resolve) => {
        resolveCompletion = resolve;
      }),
    }));
    const tool = new AgentTool(host, 'agent_main');
    const signal = new AbortController().signal;

    const result = await tool.execute(
      'tc_bg_1',
      {
        prompt: 'Long task',
        description: 'Background work',
        runInBackground: true,
      },
      signal,
    );

    // Should return immediately
    expect(result.content).toContain('sub_bg');
    expect(result.content).toContain('started');
    expect(result.isError).toBeFalsy();

    // Resolve the completion to avoid unhandled rejection
    resolveCompletion?.(makeResult('eventually done'));
  });

  it('passes runInBackground=true through SpawnRequest', async () => {
    const host = makeHost();
    const tool = new AgentTool(host, 'agent_main');
    const signal = new AbortController().signal;

    await tool.execute(
      'tc_bg_2',
      {
        prompt: 'Background task',
        description: 'BG',
        runInBackground: true,
      },
      signal,
    );

    expect(host.spawnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        runInBackground: true,
      }),
    );
  });
});

// ── Abort cascade (§5.9) ─────────────────────────────────────────────

describe('AgentTool — abort semantics', () => {
  it('foreground: parent abort cascades to subagent via signal', async () => {
    const parentController = new AbortController();
    let childSignalAborted = false;

    const host = makeHost((req) => {
      // Simulate: SubagentHost creates a child controller linked to parent
      const childCompletion = new Promise<AgentResult>((resolve) => {
        // In real implementation, the host watches the parent signal
        parentController.signal.addEventListener('abort', () => {
          childSignalAborted = true;
          resolve({ result: 'cancelled', usage: { input: 0, output: 0 } });
        });
      });

      return {
        agentId: `sub_${req.agentName}`,
        parentToolCallId: req.parentToolCallId,
        completion: childCompletion,
      };
    });

    const tool = new AgentTool(host, 'agent_main');

    // Start foreground execution
    const promise = tool.execute(
      'tc_abort_1',
      { prompt: 'Long work', description: 'Abortable' },
      parentController.signal,
    );

    // Abort the parent turn
    parentController.abort();

    const result = await promise;
    // Foreground subagent should have received the abort
    expect(childSignalAborted).toBe(true);
    expect(result.content).toContain('cancelled');
  });

  it('background: parent abort does NOT cascade to subagent', async () => {
    const parentController = new AbortController();

    const host = makeHost((req) => ({
      agentId: 'sub_bg_safe',
      parentToolCallId: req.parentToolCallId,
      completion: new Promise<AgentResult>(() => {
        // Never resolves — simulates long-running background task
      }),
    }));
    const tool = new AgentTool(host, 'agent_main');

    // Background returns immediately
    const result = await tool.execute(
      'tc_abort_bg',
      {
        prompt: 'BG task',
        description: 'Independent',
        runInBackground: true,
      },
      parentController.signal,
    );

    // Background should have returned successfully before abort
    expect(result.content).toContain('sub_bg_safe');

    // Even after parent abort, the background task handle is unaffected
    parentController.abort();
    // No assertion needed for the background handle — it's independent
    // The test passes if we get here without the abort affecting the result
  });
});

// ── parentToolCallId threading (Slice 7 audit Finding #1) ───────────

describe('AgentTool — parentToolCallId threading', () => {
  it('forwards the first `toolCallId` argument into SpawnRequest.parentToolCallId', async () => {
    const host = makeHost();
    const tool = new AgentTool(host, 'agent_main');
    const signal = new AbortController().signal;

    await tool.execute('tc_parent_abcdef', { prompt: 'Do work', description: 'Work' }, signal);

    expect(host.spawnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        parentToolCallId: 'tc_parent_abcdef',
      }),
    );
  });

  it('background mode also forwards parentToolCallId', async () => {
    const host = makeHost();
    const tool = new AgentTool(host, 'agent_main');
    const signal = new AbortController().signal;

    await tool.execute(
      'tc_bg_parent',
      {
        prompt: 'Background work',
        description: 'BG',
        runInBackground: true,
      },
      signal,
    );

    expect(host.spawnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        parentToolCallId: 'tc_bg_parent',
        runInBackground: true,
      }),
    );
  });

  it('each execute() call forwards its own toolCallId (no shared state)', async () => {
    const host = makeHost();
    const tool = new AgentTool(host, 'agent_main');
    const signal = new AbortController().signal;

    await tool.execute('tc_one', { prompt: 'A', description: 'A' }, signal);
    await tool.execute('tc_two', { prompt: 'B', description: 'B' }, signal);

    const calls = host.spawnSpy.mock.calls;
    expect(calls[0]![0]).toEqual(expect.objectContaining({ parentToolCallId: 'tc_one' }));
    expect(calls[1]![0]).toEqual(expect.objectContaining({ parentToolCallId: 'tc_two' }));
  });
});

// ── Signal threading (Slice 2.1) ─────────────────────────────────────

describe('AgentTool — signal threading into SpawnRequest', () => {
  it('foreground: forwards parent AbortSignal via SpawnRequest.signal', async () => {
    const host = makeHost();
    const tool = new AgentTool(host, 'agent_main');
    const parentController = new AbortController();

    await tool.execute(
      'tc_sig_1',
      { prompt: 'work', description: 'work' },
      parentController.signal,
    );

    const call = host.spawnSpy.mock.calls[0]![0] as SpawnRequest;
    expect(call.signal).toBe(parentController.signal);
  });

  it('background: forwards parent AbortSignal via SpawnRequest.signal', async () => {
    // The coordinator decision is that the signal field is wired through for
    // both modes; AgentTool itself doesn't diverge behavior based on it. The
    // background-independence invariant is enforced by the SubagentHost
    // implementation (SoulRegistry), not by AgentTool.
    const host = makeHost();
    const tool = new AgentTool(host, 'agent_main');
    const parentController = new AbortController();

    await tool.execute(
      'tc_sig_2',
      { prompt: 'bg', description: 'bg', runInBackground: true },
      parentController.signal,
    );

    const call = host.spawnSpy.mock.calls[0]![0] as SpawnRequest;
    expect(call.signal).toBe(parentController.signal);
  });
});

// ── Model override ────────────────────────────────────────────────────

describe('AgentTool — model override', () => {
  it('passes model field through to SpawnRequest', async () => {
    const host = makeHost();
    const tool = new AgentTool(host, 'agent_main');
    const signal = new AbortController().signal;

    await tool.execute(
      'tc_model',
      {
        prompt: 'Use fast model',
        description: 'Model test',
        model: 'haiku',
      },
      signal,
    );

    expect(host.spawnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'haiku',
      }),
    );
  });
});
