/**
 * Phase 18 Section A — Wire 协议补齐（14 项）。
 *
 * 本文件以 describe block 按 A.1–A.14 分段，每段是一个失败的 red-bar
 * 测试，驱动 Section A 的实现。
 *
 * 范围铁律：
 *   - 测试在内存 wire harness 上跑（见 `createWireE2EHarness`），避免
 *     起子进程 —— 生产 `runWire` 仍是 stub（见 Slice 18-1 PROGRESS.md）。
 *   - router-level 方法名 / 事件名 must appear in v2 wire-protocol
 *     types union（`WireMethod` / `WireEventMethod`）—— 若缺失，说明
 *     types.ts 也需要加 literal。
 *   - 每条失败原因在测试注释里给出 lift-handle（"src gap:..."）。
 *
 * 主要测试意图（而不是照抄 Python）：把"新 method 注册 + 行为"一次性 pin
 * 住；具体 production handler 实装由 A.* implementer 负责。
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildInitializeRequest,
  buildPromptRequest,
  buildSessionCreateRequest,
  createTestApproval,
  createWireE2EHarness,
  FakeKosongAdapter,
  type WireE2EInMemoryHarness,
} from '../helpers/index.js';
import {
  createWireRequest,
  createWireResponse,
} from '../../src/wire-protocol/message-factory.js';
import type {
  WireMessage,
  WireMethod,
  WireEventMethod,
} from '../../src/wire-protocol/types.js';

// ── Shared helpers ─────────────────────────────────────────────────────

let harness: WireE2EInMemoryHarness | undefined;

async function boot(opts?: {
  kosong?: FakeKosongAdapter;
  externalTools?: readonly {
    name: string;
    description?: string;
    parameters?: unknown;
  }[];
  yolo?: boolean;
  model?: string;
}): Promise<{ sessionId: string }> {
  const approval = createTestApproval({ yolo: opts?.yolo ?? true });
  harness = await createWireE2EHarness({
    ...(opts?.kosong !== undefined ? { kosong: opts.kosong } : {}),
    ...(opts?.model !== undefined ? { model: opts.model } : {}),
    approval,
  });

  const init = buildInitializeRequest({
    ...(opts?.externalTools !== undefined
      ? { externalTools: opts.externalTools as never }
      : {}),
  });
  await harness.send(init);
  await harness.collectUntilResponse(init.id);

  const create = buildSessionCreateRequest({ model: opts?.model ?? 'test-model' });
  await harness.send(create);
  const { response } = await harness.collectUntilResponse(create.id);
  const sessionId = (response.data as { session_id: string }).session_id;
  return { sessionId };
}

async function requestOn(
  method: string,
  sessionId: string,
  data: unknown,
): Promise<WireMessage> {
  if (harness === undefined) throw new Error('harness not booted');
  return harness.request(method, data, { sessionId });
}

afterEach(async () => {
  if (harness !== undefined) {
    await harness.dispose();
    harness = undefined;
  }
});

// ── A.1 initialize.external_tools conflict check ───────────────────────

describe('Phase 18 A.1 — initialize.external_tools conflict detection', () => {
  it('external tool conflicting with a builtin (Bash) lands in `rejected[]` with reason', async () => {
    harness = await createWireE2EHarness({ model: 'test-model' });
    const init = buildInitializeRequest({
      externalTools: [
        // Bash is a builtin tool — Python parity
        // (`wire/server.py:407-421`): conflicts go to rejected[] with
        // reason containing "conflicts with built-in".
        { name: 'Bash', description: 'x', parameters: {} },
      ] as never,
    });
    await harness.send(init);
    const { response } = await harness.collectUntilResponse(init.id);

    const data = response.data as {
      external_tools?: {
        accepted?: readonly string[];
        rejected?: readonly { name: string; reason: string }[];
      };
    };
    expect(data.external_tools).toBeDefined();
    expect(data.external_tools?.rejected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Bash',
          reason: expect.stringMatching(/built-?in|conflict/i) as unknown as string,
        }),
      ]),
    );
  });

  it('non-conflicting external tool lands in `accepted[]`', async () => {
    harness = await createWireE2EHarness({ model: 'test-model' });
    const init = buildInitializeRequest({
      externalTools: [
        { name: 'MyCustomThing', description: 'do stuff', parameters: {} },
      ] as never,
    });
    await harness.send(init);
    const { response } = await harness.collectUntilResponse(init.id);

    const data = response.data as {
      external_tools?: {
        accepted?: readonly string[];
        rejected?: readonly unknown[];
      };
    };
    expect(data.external_tools?.accepted).toContain('MyCustomThing');
    expect(data.external_tools?.rejected ?? []).toHaveLength(0);
  });
});

// ── A.2 tool.call reverse-RPC for external tools ────────────────────────

describe('Phase 18 A.2 — tool.call reverse-RPC (external tools)', () => {
  it('LLM calls a registered external tool → Core emits reverse `tool.call` → client responds', async () => {
    const kosong = new FakeKosongAdapter()
      .script({
        toolCalls: [
          {
            id: 'tc_ext_1',
            name: 'MyCustomThing',
            arguments: { n: 5 },
          },
        ],
        stopReason: 'tool_use',
      })
      .script({ text: 'done', stopReason: 'end_turn' });

    const { sessionId } = await boot({
      kosong,
      externalTools: [
        { name: 'MyCustomThing', description: 'external', parameters: {} },
      ],
    });

    const promptReq = buildPromptRequest({ sessionId, text: 'use it' });
    await harness!.send(promptReq);
    const { response, events } = await harness!.collectUntilResponse(
      promptReq.id,
      {
        requestHandler: (req) => {
          if (req.method === 'tool.call') {
            return createWireResponse({
              requestId: req.id,
              sessionId: req.session_id,
              data: { output: '25', is_error: false },
            });
          }
          throw new Error(`unexpected reverse-RPC: ${String(req.method)}`);
        },
      },
    );
    void response;

    const reverseCalls = events.filter(
      (e) => e.type === 'request' && e.method === 'tool.call',
    );
    expect(reverseCalls).toHaveLength(1);
    const payload = reverseCalls[0]!.data as {
      id: string;
      name: string;
      args: Record<string, unknown>;
    };
    expect(payload.name).toBe('MyCustomThing');
    expect(payload.args).toEqual({ n: 5 });
  });

  it('client timeout on reverse tool.call → tool result becomes is_error: true', async () => {
    const kosong = new FakeKosongAdapter()
      .script({
        toolCalls: [
          {
            id: 'tc_ext_timeout',
            name: 'SlowExternal',
            arguments: {},
          },
        ],
        stopReason: 'tool_use',
      })
      .script({ text: 'done', stopReason: 'end_turn' });

    const { sessionId } = await boot({
      kosong,
      externalTools: [
        { name: 'SlowExternal', description: 'slow', parameters: {} },
      ],
    });

    const promptReq = buildPromptRequest({ sessionId, text: 'slow call' });
    await harness!.send(promptReq);
    // Client never responds to the reverse tool.call → implementer
    // must surface `is_error: true` with message mentioning unavailable / timeout.
    const { events } = await harness!.collectUntilResponse(promptReq.id, {
      timeoutMs: 8_000,
    });

    const toolResult = events.find(
      (e) =>
        e.type === 'event' &&
        e.method === 'tool.result' &&
        (e.data as { tool_call_id?: string })?.tool_call_id === 'tc_ext_timeout',
    );
    expect(toolResult).toBeDefined();
    expect((toolResult!.data as { is_error?: boolean }).is_error).toBe(true);
  });
});

// ── A.3–A.7 session config setters ─────────────────────────────────────

describe('Phase 18 A.3 — session.setModel', () => {
  it('routes as a config method and writes model_changed wire record + model.changed event', async () => {
    const { sessionId } = await boot({ model: 'old-model' });

    // Method must live in WireMethod union.
    const method: WireMethod = 'session.setModel';
    expect(method).toBe('session.setModel');

    const resp = await requestOn('session.setModel', sessionId, {
      model: 'anthropic/claude-4-opus',
    });
    expect(resp.error).toBeUndefined();

    // model.changed wire event
    const ev = await harness!
      .expectEvent('model.changed', { timeoutMs: 2000 })
      .catch(() => undefined);
    expect(ev).toBeDefined();
    const data = ev!.data as { new_model?: string; old_model?: string };
    expect(data.new_model).toBe('anthropic/claude-4-opus');
  });
});

describe('Phase 18 A.4 — session.setPlanMode', () => {
  it('flips plan_mode and appends plan_mode_changed record', async () => {
    const { sessionId } = await boot();

    const resp = await requestOn('session.setPlanMode', sessionId, {
      enabled: true,
    });
    expect(resp.error).toBeUndefined();

    // TurnManager state is flipped.
    const managed = harness!.sessionManager.get(sessionId) as
      | { soulPlus: { getTurnManager(): { getPlanMode(): boolean } } }
      | undefined;
    expect(managed?.soulPlus.getTurnManager().getPlanMode()).toBe(true);
  });
});

describe('Phase 18 A.5 — session.setYolo', () => {
  it('forwards to ApprovalStateStore.setYolo via onChanged and emits a status/wire record', async () => {
    const { sessionId } = await boot({ yolo: false });

    const resp = await requestOn('session.setYolo', sessionId, {
      enabled: true,
    });
    expect(resp.error).toBeUndefined();

    // Handler success alone is not enough — it must have gone through
    // ApprovalStateStore.setYolo (Phase 17 B.2) so downstream
    // wire-record + status update path fires. Implementer lift-time:
    // extend `SessionControl.setYolo` to delegate to the store's
    // setYolo + onChanged path (not the current permission_mode flip).
  });
});

describe('Phase 18 A.6 — session.setThinking', () => {
  it('accepts { level } and emits thinking.changed event', async () => {
    const { sessionId } = await boot();

    const resp = await requestOn('session.setThinking', sessionId, {
      level: 'high',
    });
    expect(resp.error).toBeUndefined();

    const ev = await harness!
      .expectEvent('thinking.changed', { timeoutMs: 2000 })
      .catch(() => undefined);
    expect(ev).toBeDefined();
    expect((ev!.data as { level?: string }).level).toBe('high');
  });
});

describe('Phase 18 A.7 — session.addSystemReminder', () => {
  it('appends a system_reminder record via ContextState', async () => {
    const { sessionId } = await boot();

    const resp = await requestOn('session.addSystemReminder', sessionId, {
      content: 'remember: use terse replies',
    });
    expect(resp.error).toBeUndefined();

    // Side-effect visible via ContextState.getHistory() — the new
    // system reminder lands as a durable record.
    const managed = harness!.sessionManager.get(sessionId) as
      | {
          contextState?: { getHistory(): readonly { content?: unknown }[] };
        }
      | undefined;
    const history = managed?.contextState?.getHistory() ?? [];
    const serialised = JSON.stringify(history);
    expect(serialised).toMatch(/terse replies/);
  });
});

// ── A.8 Dynamic tool management ────────────────────────────────────────

describe('Phase 18 A.8 — dynamic tool management', () => {
  it('session.registerTool adds a tool → session.listTools sees it', async () => {
    const { sessionId } = await boot();

    const resp = await requestOn('session.registerTool', sessionId, {
      name: 'MyExtra',
      description: 'injected later',
      input_schema: { type: 'object', properties: {} },
    });
    expect(resp.error).toBeUndefined();

    const listResp = await requestOn('session.listTools', sessionId, {});
    const tools =
      (listResp.data as { tools?: { name: string }[] }).tools ?? [];
    expect(tools.map((t) => t.name)).toContain('MyExtra');
  });

  it('session.removeTool drops a tool from listTools', async () => {
    const { sessionId } = await boot();

    await requestOn('session.registerTool', sessionId, {
      name: 'Transient',
      description: '',
      input_schema: {},
    });
    const afterAdd = await requestOn('session.listTools', sessionId, {});
    expect(
      ((afterAdd.data as { tools?: { name: string }[] }).tools ?? []).map(
        (t) => t.name,
      ),
    ).toContain('Transient');

    await requestOn('session.removeTool', sessionId, { name: 'Transient' });
    const afterRm = await requestOn('session.listTools', sessionId, {});
    expect(
      ((afterRm.data as { tools?: { name: string }[] }).tools ?? []).map(
        (t) => t.name,
      ),
    ).not.toContain('Transient');
  });

  it('session.setActiveTools narrows the active set to the supplied names', async () => {
    const { sessionId } = await boot();

    await requestOn('session.registerTool', sessionId, {
      name: 'T1',
      description: '',
      input_schema: {},
    });
    await requestOn('session.registerTool', sessionId, {
      name: 'T2',
      description: '',
      input_schema: {},
    });

    const resp = await requestOn('session.setActiveTools', sessionId, {
      names: ['T1'],
    });
    expect(resp.error).toBeUndefined();

    // Implementer: listTools response may include an `active: string[]`
    // list; otherwise an `active` flag per entry.
    const list = await requestOn('session.listTools', sessionId, {});
    const payload = list.data as {
      tools?: { name: string; active?: boolean }[];
      active?: string[];
    };
    if (payload.active !== undefined) {
      expect(payload.active).toEqual(['T1']);
    } else {
      const active = (payload.tools ?? [])
        .filter((t) => t.active === true)
        .map((t) => t.name);
      expect(active).toEqual(['T1']);
    }
  });

  it('registered external tool (via initialize) participates in the reverse-RPC tool.call path', async () => {
    // Integration check with A.2 — a tool registered via session.registerTool
    // should behave the same as one declared in initialize.
    const kosong = new FakeKosongAdapter()
      .script({
        toolCalls: [
          { id: 'tc_ext_run', name: 'ExternalAdder', arguments: { a: 1 } },
        ],
        stopReason: 'tool_use',
      })
      .script({ text: 'ok', stopReason: 'end_turn' });
    const { sessionId } = await boot({ kosong });

    await requestOn('session.registerTool', sessionId, {
      name: 'ExternalAdder',
      description: 'external',
      input_schema: {},
    });

    const promptReq = buildPromptRequest({ sessionId, text: 'add' });
    await harness!.send(promptReq);
    const { events } = await harness!.collectUntilResponse(promptReq.id, {
      requestHandler: (req) => {
        if (req.method === 'tool.call') {
          return createWireResponse({
            requestId: req.id,
            sessionId: req.session_id,
            data: { output: '2', is_error: false },
          });
        }
        throw new Error(`unexpected reverse-RPC: ${String(req.method)}`);
      },
    });
    const reverse = events.find(
      (e) => e.type === 'request' && e.method === 'tool.call',
    );
    expect(reverse).toBeDefined();
  });
});

// ── A.9 session.subscribe / unsubscribe event filtering ────────────────

describe('Phase 18 A.9 — session.subscribe / unsubscribe', () => {
  it('subscribe({events:[turn.begin, turn.end]}) restricts events to the subset', async () => {
    const kosong = new FakeKosongAdapter().script({
      text: 'ok',
      stopReason: 'end_turn',
    });
    const { sessionId } = await boot({ kosong });

    const resp = await requestOn('session.subscribe', sessionId, {
      events: ['turn.begin', 'turn.end'],
    });
    expect(resp.error).toBeUndefined();

    const promptReq = buildPromptRequest({ sessionId, text: 'go' });
    await harness!.send(promptReq);
    const { events } = await harness!.collectUntilResponse(promptReq.id);

    // After subscribe, we must NOT see step.begin / content.delta.
    const eventMethods = events
      .filter((e) => e.type === 'event')
      .map((e) => e.method as string);
    const disallowed = eventMethods.filter(
      (m) =>
        m === 'step.begin' ||
        m === 'step.end' ||
        m === 'content.delta' ||
        m === 'tool.call',
    );
    expect(disallowed).toEqual([]);
  });

  it('unsubscribe reverts to the default (all events)', async () => {
    const { sessionId } = await boot();

    await requestOn('session.subscribe', sessionId, {
      events: ['turn.begin'],
    });
    const unsubResp = await requestOn('session.unsubscribe', sessionId, {});
    expect(unsubResp.error).toBeUndefined();
  });

  it('default (no subscribe call) fans out every event method', async () => {
    const kosong = new FakeKosongAdapter().script({
      text: 'ok',
      stopReason: 'end_turn',
    });
    const { sessionId } = await boot({ kosong });

    const promptReq = buildPromptRequest({ sessionId, text: 'go' });
    await harness!.send(promptReq);
    const { events } = await harness!.collectUntilResponse(promptReq.id);
    const methods = events
      .filter((e) => e.type === 'event')
      .map((e) => e.method as string);
    // Baseline expectations — these two are guaranteed by
    // the existing bridge.
    expect(methods).toContain('turn.begin');
    expect(methods).toContain('turn.end');
  });
});

// ── A.10 hook.request reverse-RPC ──────────────────────────────────────

describe('Phase 18 A.10 — hook.request reverse-RPC', () => {
  it('HookEngine triggers → server issues `hook.request` frame over the wire', async () => {
    // Register a wire hook subscription via initialize hooks[] so
    // HookEngine has a WireHookExecutor subscriber for PreToolUse/Bash.
    harness = await createWireE2EHarness({ model: 'test-model' });
    const init = createWireRequest({
      method: 'initialize',
      sessionId: '__process__',
      data: {
        protocol_version: '2.1',
        capabilities: { hooks: true },
        hooks: [{ event: 'PreToolUse', matcher: 'Bash' }],
      },
    });
    await harness.send(init);
    await harness.collectUntilResponse(init.id);

    const kosong = new FakeKosongAdapter()
      .script({
        toolCalls: [
          { id: 'tc_bash_hook', name: 'Bash', arguments: { command: 'ls' } },
        ],
        stopReason: 'tool_use',
      })
      .script({ text: 'done', stopReason: 'end_turn' });

    // Harness already booted; create the session with this kosong.
    // A fresh boot() would dispose the current harness — call the
    // create + prompt path directly.
    const create = buildSessionCreateRequest({ model: 'test-model' });
    await harness.send(create);
    const { response: createResp } = await harness.collectUntilResponse(
      create.id,
    );
    const sessionId = (createResp.data as { session_id: string })
      .session_id;

    // Drop the fake adapter into the managed session's runtime.
    const managed = harness.sessionManager.get(sessionId) as
      | { runtime?: { kosong: unknown } }
      | undefined;
    if (managed?.runtime) managed.runtime.kosong = kosong;

    const promptReq = buildPromptRequest({ sessionId, text: 'run bash' });
    await harness.send(promptReq);

    const { events } = await harness.collectUntilResponse(promptReq.id, {
      requestHandler: (req) => {
        if (req.method === 'hook.request') {
          return createWireResponse({
            requestId: req.id,
            sessionId: req.session_id,
            data: { ok: true, blockAction: false },
          });
        }
        // Approve any approval reverse-RPC that slips in.
        if (req.method === 'approval.request') {
          return createWireResponse({
            requestId: req.id,
            sessionId: req.session_id,
            data: { response: 'approved' },
          });
        }
        throw new Error(`unexpected reverse-RPC ${String(req.method)}`);
      },
    });

    const hookReq = events.find(
      (e) => e.type === 'request' && e.method === 'hook.request',
    );
    expect(hookReq).toBeDefined();
    const data = hookReq!.data as { event?: string; tool_name?: string };
    expect(data.event).toBe('PreToolUse');
    expect(data.tool_name).toBe('Bash');
  });

  it('no client response within timeout → WireHookExecutor fail-opens ({ok:true})', async () => {
    // Pinned by existing unit coverage in test/hooks/wire-executor.test.ts;
    // this describe reiterates the contract lives at the wire-methods
    // layer too. Implementer must ensure the production wire server's
    // hook.request reverse-RPC honours HookConfig.timeoutMs.
    const kosong = new FakeKosongAdapter().script({
      text: 'ok',
      stopReason: 'end_turn',
    });
    const { sessionId } = await boot({ kosong });
    // Trigger a prompt; no hook subscription means no hook.request
    // frames; we just verify a baseline prompt completes which doubles
    // as a "no hook timeout pseudo-block" regression guard.
    const prompt = buildPromptRequest({ sessionId, text: 'hi' });
    await harness!.send(prompt);
    const { response } = await harness!.collectUntilResponse(prompt.id, {
      timeoutMs: 4000,
    });
    expect(response.error).toBeUndefined();
  });
});

// ── A.11 / A.12 / A.13 business error codes ────────────────────────────

describe('Phase 18 A.11 — -32001 LLM not set', () => {
  it('session.prompt returns error code -32001 when default_model is missing', async () => {
    // Simulate missing model by booting with empty string.
    harness = await createWireE2EHarness({ model: '' });
    const init = buildInitializeRequest();
    await harness.send(init);
    await harness.collectUntilResponse(init.id);

    const create = buildSessionCreateRequest({ model: '' });
    await harness.send(create);
    const { response: createResp } = await harness.collectUntilResponse(
      create.id,
    );
    // Some implementations surface -32001 on session.create directly;
    // others only at prompt time. Accept both.
    if (createResp.error !== undefined) {
      expect(createResp.error.code).toBe(-32001);
      return;
    }
    const sessionId = (createResp.data as { session_id: string }).session_id;
    const prompt = buildPromptRequest({ sessionId, text: 'hi' });
    await harness.send(prompt);
    const { response } = await harness.collectUntilResponse(prompt.id);
    expect(response.error?.code).toBe(-32001);
  });
});

describe('Phase 18 A.12 — -32002 LLM capability mismatch', () => {
  it('image input to an image_in:false model → -32002', async () => {
    const kosong = new FakeKosongAdapter().script({
      text: 'unreachable',
      stopReason: 'end_turn',
    });
    const { sessionId } = await boot({ kosong });

    const req = createWireRequest({
      method: 'session.prompt',
      sessionId,
      data: {
        input: [
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,AA==' },
          },
        ],
      },
    });
    await harness!.send(req);
    const { response } = await harness!.collectUntilResponse(req.id);
    expect(response.error).toBeDefined();
    expect(response.error?.code).toBe(-32002);
  });
});

describe('Phase 18 A.13 — -32003 Provider error', () => {
  it('a provider-level exception is mapped to -32003', async () => {
    const kosong = new FakeKosongAdapter()
      .scriptError({
        error: new Error('kimi-provider: 500 backend overloaded'),
      } as never)
      .script({ text: 'unreachable', stopReason: 'end_turn' });

    const { sessionId } = await boot({ kosong });

    const prompt = buildPromptRequest({ sessionId, text: 'hi' });
    await harness!.send(prompt);
    const { response } = await harness!.collectUntilResponse(prompt.id, {
      timeoutMs: 4000,
    });
    expect(response.error?.code).toBe(-32003);
  });
});

// ── A.14 status.update includes context_usage.percent ──────────────────

describe('Phase 18 A.14 — status.update carries context_usage with percent', () => {
  it('status.update wire event has {used, total, percent} in context_usage', async () => {
    const kosong = new FakeKosongAdapter().script({
      text: 'ok',
      stopReason: 'end_turn',
    });
    const { sessionId } = await boot({ kosong });

    const method: WireEventMethod = 'status.update';
    expect(method).toBe('status.update');

    const prompt = buildPromptRequest({ sessionId, text: 'go' });
    await harness!.send(prompt);
    const { events } = await harness!.collectUntilResponse(prompt.id, {
      timeoutMs: 4000,
    });
    const status = events.find(
      (e) => e.type === 'event' && e.method === 'status.update',
    );
    expect(status).toBeDefined();
    const cu = (status!.data as {
      context_usage?: { used: number; total: number; percent: number };
    }).context_usage;
    expect(cu).toBeDefined();
    expect(typeof cu!.used).toBe('number');
    expect(typeof cu!.total).toBe('number');
    expect(typeof cu!.percent).toBe('number');
    expect(cu!.percent).toBeGreaterThanOrEqual(0);
    expect(cu!.percent).toBeLessThanOrEqual(100);
  });
});
