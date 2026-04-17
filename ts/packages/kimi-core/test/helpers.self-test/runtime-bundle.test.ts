/**
 * Self-test — createTestRuntime / createTestSession / approval /
 * environment factories (Phase 9 §3).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { z } from 'zod';

import {
  createScriptedApproval,
  createTestApproval,
  createTestEnvironment,
  createTestRuntime,
  createTestSession,
  FakeKosongAdapter,
  makeToolCallStub,
  type TestSessionBundle,
} from '../helpers/index.js';
import type { ChatParams, ChatResponse, KosongAdapter } from '../../src/soul/runtime.js';
import type { Tool, ToolResult } from '../../src/soul/types.js';

const toCleanup: Array<{ dispose(): Promise<void> }> = [];

afterEach(async () => {
  while (toCleanup.length > 0) {
    const d = toCleanup.pop()!;
    try {
      await d.dispose();
    } catch {
      /* swallow to keep other cleanups running */
    }
  }
});

describe('createTestEnvironment', () => {
  it('macOS default', () => {
    const env = createTestEnvironment();
    expect(env.os).toBe('macOS');
    expect(env.shellName).toBe('zsh');
  });

  it('Linux default has bash', () => {
    const env = createTestEnvironment({ os: 'Linux' });
    expect(env.shellName).toBe('bash');
  });

  it('Windows default has pwsh', () => {
    const env = createTestEnvironment({ os: 'Windows' });
    expect(env.shellName).toBe('pwsh');
  });
});

describe('createTestApproval', () => {
  it('yolo=true approves by default', async () => {
    const a = createTestApproval({ yolo: true });
    const r = await a.request({
      toolCallId: 'tc_1',
      toolName: 'Bash',
      action: 'exec',
      display: { kind: 'command', command: 'ls' },
      source: { kind: 'session', session_id: 'ses_x' },
    });
    expect(r.approved).toBe(true);
  });

  it('yolo=false rejects by default', async () => {
    const a = createTestApproval({ yolo: false });
    const r = await a.request({
      toolCallId: 'tc_1',
      toolName: 'Bash',
      action: 'exec',
      display: { kind: 'command', command: 'ls' },
      source: { kind: 'session', session_id: 'ses_x' },
    });
    expect(r.approved).toBe(false);
  });
});

describe('createScriptedApproval', () => {
  it('plays decisions in order', async () => {
    const { approval, requests } = createScriptedApproval({
      decisions: [{ kind: 'approve' }, { kind: 'reject', feedback: 'no' }],
    });
    const req = {
      toolCallId: 'tc_a',
      toolName: 'Bash',
      action: 'exec',
      display: { kind: 'command' as const, command: 'ls' },
      source: { kind: 'session' as const, session_id: 'ses_x' },
    };
    const r1 = await approval.request(req);
    const r2 = await approval.request({ ...req, toolCallId: 'tc_b' });
    expect(r1.approved).toBe(true);
    expect(r2).toEqual({ approved: false, feedback: 'no' });
    expect(requests.length).toBe(2);
  });

  it('perToolName overrides queue', async () => {
    const { approval } = createScriptedApproval({
      perToolName: { Bash: { kind: 'reject' } },
      defaultDecision: { kind: 'approve' },
    });
    const mk = (tool: string) => ({
      toolCallId: `tc_${tool}`,
      toolName: tool,
      action: 'exec',
      display: { kind: 'command' as const, command: 'x' },
      source: { kind: 'session' as const, session_id: 'ses_x' },
    });
    const rBash = await approval.request(mk('Bash'));
    const rRead = await approval.request(mk('Read'));
    expect(rBash.approved).toBe(false);
    expect(rRead.approved).toBe(true);
  });
});

describe('createTestRuntime', () => {
  it('returns a complete, dispose-safe bundle', async () => {
    const bundle = createTestRuntime();
    toCleanup.push(bundle);
    expect(bundle.runtime.kosong).toBeInstanceOf(FakeKosongAdapter);
    expect(bundle.contextState.model).toBe('test-model');
    expect(bundle.events.events).toEqual([]);
    // sink → events subscription
    bundle.sink.emit({ type: 'step.begin', step: 0 });
    expect(bundle.events.count('step.begin')).toBe(1);
  });

  it('respects custom model / session id / system prompt', async () => {
    const bundle = createTestRuntime({
      model: 'claude-test-5',
      sessionId: 'ses_custom',
      systemPrompt: 'be brief',
    });
    toCleanup.push(bundle);
    expect(bundle.contextState.model).toBe('claude-test-5');
    expect(bundle.sessionId).toBe('ses_custom');
    expect(bundle.contextState.systemPrompt).toBe('be brief');
  });

  it('M5-补: wraps a non-FakeKosongAdapter so bundle.kosong tracks its calls', async () => {
    // A bare custom adapter — not a FakeKosongAdapter instance.
    class CustomAdapter implements KosongAdapter {
      readonly delegateCalls: ChatParams[] = [];
      async chat(params: ChatParams): Promise<ChatResponse> {
        this.delegateCalls.push(params);
        return {
          message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
          toolCalls: [],
          stopReason: 'end_turn',
          usage: { input: 0, output: 0 },
        };
      }
    }
    const custom = new CustomAdapter();
    const bundle = createTestRuntime({ kosong: custom });
    toCleanup.push(bundle);

    const makeParams = (): ChatParams => ({
      messages: [],
      tools: [],
      model: 'test',
      systemPrompt: '',
      signal: new AbortController().signal,
    });
    await bundle.runtime.kosong.chat(makeParams());
    await bundle.runtime.kosong.chat(makeParams());

    // bundle.kosong is the wrapper FakeKosongAdapter, NOT `custom`.
    expect(bundle.kosong).not.toBe(custom);
    expect(bundle.kosong.calls.length).toBe(2);
    expect(bundle.kosong.callCount).toBe(2);
    // The real adapter also saw the calls via delegation.
    expect(custom.delegateCalls.length).toBe(2);
  });
});

describe('createTestSession', () => {
  it('boots a file-backed session and exposes dispatch', async () => {
    const fake = new FakeKosongAdapter().script({
      text: 'hello',
      stopReason: 'end_turn',
    });
    const session: TestSessionBundle = await createTestSession({ kosong: fake });
    toCleanup.push(session);
    expect(session.sessionId.length).toBeGreaterThan(0);
    const resp = await session.prompt('hi');
    // soul runs asynchronously; dispatch returns 'started' immediately
    expect(resp).toEqual(expect.objectContaining({ status: 'started' }));
  });

  it('M3-补: scripted reject actually blocks tool.execute from running', async () => {
    // Build a Tool whose execute is a spy so the assertion goes
    // beyond "approval was asked" — we verify execute is NEVER called
    // after the approval runtime rejects.
    const executeSpy = vi.fn<
      (toolCallId: string, args: unknown, signal: AbortSignal) => Promise<ToolResult>
    >();
    executeSpy.mockResolvedValue({ content: 'UNREACHED' });
    const spyTool: Tool<{ path: string }> = {
      name: 'ReadSpy',
      description: 'test tool that must never execute when approval rejects',
      inputSchema: z.object({ path: z.string() }),
      execute: executeSpy,
    };

    const toolCall = makeToolCallStub('ReadSpy', { path: '/etc/passwd' }, 'tc_blocked');
    const fake = new FakeKosongAdapter()
      .script({
        toolCalls: [{ id: toolCall.id, name: 'ReadSpy', arguments: { path: '/etc/passwd' } }],
        stopReason: 'tool_use',
      })
      .script({ text: 'ok stopped', stopReason: 'end_turn' });

    const { approval, requests } = createScriptedApproval({
      defaultDecision: { kind: 'reject', feedback: 'nope' },
    });

    const session = await createTestSession({
      kosong: fake,
      tools: [spyTool],
      approval,
    });
    toCleanup.push(session);

    await session.prompt('read /etc/passwd');
    // Drain: wait until the approval runtime sees the request AND the
    // Soul turn emits a second chat call (the tool-use recovery turn)
    // OR the approval request arrives.
    for (let i = 0; i < 100; i += 1) {
      if (requests.length > 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(requests.length).toBeGreaterThan(0);
    expect(requests[0]?.toolName).toBe('ReadSpy');
    // Give the Soul loop a tick after the approval resolves so any
    // downstream execute would have fired.
    await new Promise((r) => setTimeout(r, 50));
    expect(executeSpy).not.toHaveBeenCalled();
  }, 15_000);
});
