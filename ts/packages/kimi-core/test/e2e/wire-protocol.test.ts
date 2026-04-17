/* oxlint-disable vitest/warn-todo -- Phase 10 intentionally uses it.todo
   to track src implementation gaps. See MIGRATION_REPORT_phase_10.md §6. */
/**
 * Wire E2E — protocol handshake + external-tool plumbing (Phase 10 C1).
 *
 * Migrated from Python `tests_e2e/test_wire_protocol.py`:
 *   - test_initialize_handshake              → initialize handshake
 *   - test_initialize_external_tool_conflict → external_tools conflict (todo)
 *   - test_external_tool_call                → reverse-RPC tool.call     (todo)
 *   - test_prompt_without_initialize         → rewritten as session-scoped
 *
 * Notes:
 *   - Python protocol_version=1.9; TS is 2.1 (v2-update §3.4). Snapshots
 *     are NOT copied from Python — we assert the TS contract directly.
 *   - Initialize handshake in TS advertises capabilities.events/methods
 *     rather than Python's slash_commands/hooks list. Those fields are a
 *     separate src concern (skill/hook registries are session-scoped, not
 *     process-scoped today).
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildInitializeRequest,
  buildPromptRequest,
  buildSessionCreateRequest,
  createWireE2EHarness,
  FakeKosongAdapter,
  type WireE2EInMemoryHarness,
} from '../helpers/index.js';

let harness: WireE2EInMemoryHarness | undefined;

afterEach(async () => {
  if (harness !== undefined) {
    await harness.dispose();
    harness = undefined;
  }
});

describe('wire protocol — initialize handshake', () => {
  it('returns protocol version 2.1 with events and methods capabilities', async () => {
    harness = await createWireE2EHarness({
      kosongOptions: { turns: [{ text: 'hello' }] },
    });

    const req = buildInitializeRequest();
    await harness.send(req);
    const { response } = await harness.collectUntilResponse(req.id);

    expect(response.type).toBe('response');
    expect(response.error).toBeUndefined();

    const data = response.data as {
      protocol_version: string;
      capabilities: { events: readonly string[]; methods: readonly string[] };
    };
    expect(data.protocol_version).toBe('2.1');
    expect(Array.isArray(data.capabilities.events)).toBe(true);
    expect(Array.isArray(data.capabilities.methods)).toBe(true);

    // Wire events advertised by the v2 core (turn / step lifecycle, content
    // streaming, tool ack, status). Python used slash_commands / hooks —
    // those remain a separate src concern (see migration report). The
    // arrayContaining assertion surfaces the full missing list on failure
    // rather than stopping at the first miss.
    expect(data.capabilities.events).toEqual(
      expect.arrayContaining(['turn.begin', 'turn.end', 'step.begin', 'content.delta', 'tool.call']),
    );
    expect(data.capabilities.methods).toEqual(
      expect.arrayContaining(['initialize', 'session.create', 'session.prompt', 'session.cancel', 'shutdown']),
    );
  });

  // Python coverage gaps — see MIGRATION_REPORT_phase_10.md:
  //
  //   - external_tools rejected-with-reason response path does not exist in
  //     the TS default initialize handler (`helpers/wire/default-handlers.ts`
  //     only returns {protocol_version, capabilities}). It is tracked as
  //     a Phase 11 deliverable so this case stays as `it.todo`.
  it.todo('rejects external_tools that conflict with built-ins (see phase-11 external-tools impl)');

  // External tools should surface as reverse-RPC `tool.call` requests from
  // core to client whenever an LLM returns a tool_call for a name that is
  // not in the local Tool registry. The plumbing (reverse-RPC bridge in
  // Soul / orchestrator → wire request) is not implemented in src yet, so
  // this case is held pending Phase 11.
  it.todo('reverse-RPC tool.call for unregistered external tool (see phase-11 external-tools impl)');
});

describe('wire protocol — prompt lifecycle entry point', () => {
  // Python `test_prompt_without_initialize` relied on a stateless
  // `prompt` method that implicitly spun up a session. The TS v2 wire
  // contract requires `session.create` first — `session.prompt` is
  // session-scoped (§3.5). This rewrite enforces the new contract.
  it('session.prompt on unknown session id returns -32000 Session not found', async () => {
    harness = await createWireE2EHarness({
      kosongOptions: { turns: [{ text: 'hi' }] },
    });

    const req = buildPromptRequest({ sessionId: 'ses_never_created', text: 'hi' });
    await harness.send(req);
    const { response } = await harness.collectUntilResponse(req.id);

    expect(response.error?.code).toBe(-32000);
    expect(response.error?.message).toMatch(/session not found/i);
  });

  it('session.create followed by session.prompt returns started response', async () => {
    harness = await createWireE2EHarness({
      kosong: new FakeKosongAdapter({ turns: [{ text: 'ok' }] }),
    });

    const createReq = buildSessionCreateRequest({ model: 'test-model' });
    await harness.send(createReq);
    const { response: createRes } = await harness.collectUntilResponse(createReq.id);
    const sessionId = (createRes.data as { session_id: string }).session_id;
    expect(sessionId).toMatch(/^ses_/);

    const promptReq = buildPromptRequest({ sessionId, text: 'ping' });
    await harness.send(promptReq);
    const { response: promptRes } = await harness.collectUntilResponse(promptReq.id);
    const payload = promptRes.data as { turn_id: string; status: string };
    expect(payload.status).toBe('started');
    expect(payload.turn_id).toMatch(/^turn_/);
  });
});
