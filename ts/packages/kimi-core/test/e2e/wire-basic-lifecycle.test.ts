/* oxlint-disable vitest/warn-todo -- Phase 12 intentionally uses it.todo
   to track src gaps. See migration-report.md §12.6. */
/**
 * Wire E2E — basic full-turn lifecycle (Phase 12.6).
 *
 * Migrated from Python `tests/e2e/test_basic_e2e.py::test_scripted_echo_
 * kimi_cli_agent_e2e` (L196). Python was parametrized across
 * `mode in {"print", "wire", "shell"}`; Phase 12 only migrates the
 * **wire** leg (print is a kimi-cli concern; shell=PTY was dropped in
 * v2). Scenario:
 *
 *   1. User prompt → LLM step 1 returns tool_call Read(path=sample.js)
 *   2. Read tool executes → content fed back into context
 *   3. LLM step 2 returns tool_call Write(path=translated.py, content=…)
 *   4. Write tool executes → content lands on disk
 *   5. LLM step 3 returns a final text ending the turn
 *   6. Test reads `translated.py` directly off disk and asserts the
 *      Python-equivalent translation was written (tool side-effect
 *      verification — bypasses the wire but confirms the tool really
 *      ran, per §12.6 (c)).
 *
 * Harness: in-memory (`createWireE2EHarness`) — the subprocess variant
 * sits as `it.todo` pending Phase 11 (`canStartWireSubprocess()`
 * returns false today; see test/helpers/wire/wire-subprocess-harness.ts).
 *
 * Tools: real `ReadTool` + `WriteTool` backed by `localKaos` against a
 * tmp workspace. The harness's own `workDir` (a temp dir via
 * `createTempEnv()`) is reused as the workspace so all reads / writes
 * are fully sandboxed and cleaned by `harness.dispose()`.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { localKaos } from '@moonshot-ai/kaos';
import { afterEach, describe, expect, it } from 'vitest';

import { ReadTool, WriteTool, type WorkspaceConfig } from '../../src/tools/index.js';
import {
  buildInitializeRequest,
  buildPromptRequest,
  buildSessionCreateRequest,
  createTempEnv,
  createTestApproval,
  createWireE2EHarness,
  FakeKosongAdapter,
  type TempEnvHandle,
  type WireE2EInMemoryHarness,
} from '../helpers/index.js';
import { installWireEventBridge } from './helpers/wire-event-bridge.js';

let harness: WireE2EInMemoryHarness | undefined;
let disposeBridge: (() => void) | undefined;
let tempEnv: TempEnvHandle | undefined;

afterEach(async () => {
  disposeBridge?.();
  disposeBridge = undefined;
  if (harness !== undefined) {
    await harness.dispose();
    harness = undefined;
  }
  if (tempEnv !== undefined) {
    await tempEnv.cleanup();
    tempEnv = undefined;
  }
});

const SAMPLE_JS_SRC = "console.log('hi');\n";
const TRANSLATED_PY_SRC = "print('hi')\n";

describe('wire basic lifecycle — wire mode (in-memory harness)', () => {
  it('scripted 3-step turn reads sample.js + writes translated.py', async () => {
    // FakeKosongAdapter with a 3-step script — emulates Python's
    // scripted_echo provider across consecutive LLM calls within one
    // session.prompt. Each entry is a single chat() invocation; TurnManager
    // loops over them, executing the returned tool_calls in between.
    const kosong = new FakeKosongAdapter()
      .script({
        toolCalls: [
          {
            id: 'tc_read_1',
            name: 'Read',
            arguments: { path: 'sample.js' },
          },
        ],
        stopReason: 'tool_use',
      })
      .script({
        toolCalls: [
          {
            id: 'tc_write_1',
            name: 'Write',
            arguments: { path: 'translated.py', content: TRANSLATED_PY_SRC },
          },
        ],
        stopReason: 'tool_use',
      })
      .script({
        text: 'done',
        stopReason: 'end_turn',
      });

    // Yolo approval so no reverse-RPC approval round-trip is needed —
    // this test pins the tool execution + multi-step lifecycle, not the
    // approval path (that lives in 12.1). See migration-report §12.6.
    const approval = createTestApproval({ yolo: true });

    // Own the tmp workspace so ReadTool / WriteTool can point at it
    // before the harness boots. Passing workDir/shareDir/homeDir to
    // createWireE2EHarness skips its internal createTempEnv(); we own
    // the cleanup via `tempEnv.cleanup()` in afterEach.
    tempEnv = await createTempEnv();
    const workspace: WorkspaceConfig = {
      workspaceDir: tempEnv.workDir.path,
      additionalDirs: [],
    };
    // Seed sample.js inside the workspace before boot.
    await writeFile(join(workspace.workspaceDir, 'sample.js'), SAMPLE_JS_SRC, 'utf8');

    const tools = [new ReadTool(localKaos, workspace), new WriteTool(localKaos, workspace)];
    harness = await createWireE2EHarness({
      kosong,
      approval,
      tools,
      workDir: workspace.workspaceDir,
      shareDir: tempEnv.shareDir.path,
      homeDir: tempEnv.homeDir.path,
    });

    // Drive the wire protocol: initialize → session.create → prompt.
    await harness.send(buildInitializeRequest());
    const createReq = buildSessionCreateRequest({ model: 'test-model' });
    await harness.send(createReq);
    const { response: createRes } = await harness.collectUntilResponse(createReq.id);
    const sessionId = (createRes.data as { session_id: string }).session_id;

    const managed = harness.sessionManager.get(sessionId);
    if (managed === undefined) throw new Error('session not materialised');
    const turnManager = managed.soulPlus.getTurnManager();
    const bridge = installWireEventBridge({
      server: harness.server,
      eventBus: harness.eventBus,
      addTurnLifecycleListener: (l) => turnManager.addTurnLifecycleListener(l),
      sessionId,
    });
    disposeBridge = bridge.dispose;

    const promptReq = buildPromptRequest({ sessionId, text: 'translate sample.js to python' });
    await harness.send(promptReq);
    const { response: promptRes } = await harness.collectUntilResponse(promptReq.id);
    expect(promptRes.error).toBeUndefined();
    const turnId = (promptRes.data as { turn_id: string }).turn_id;

    // Wait for turn.end and confirm success.
    const endEv = await harness.expectEvent('turn.end', {
      matcher: (m) => (m.data as { turn_id?: string } | undefined)?.turn_id === turnId,
      timeoutMs: 10_000,
    });
    const endData = endEv.data as { success: boolean; reason: string };
    expect(endData.success).toBe(true);
    expect(endData.reason).toBe('done');

    // Tool side-effect: translated.py lands on disk with the expected
    // content (§12.6 (c) — real file I/O, not a wire snapshot).
    const written = await readFile(join(harness.workDir, 'translated.py'), 'utf8');
    expect(written).toBe(TRANSLATED_PY_SRC);

    // FakeKosong should have been called exactly 3 times (one per
    // LLM step).
    expect(kosong.callCount).toBe(3);

    // On step 2 the LLM context should have contained the read result,
    // shaped as a user-role tool_result message (schema contract).
    const step2 = kosong.calls[1];
    expect(step2).toBeDefined();
    const messages = step2!.messages;
    // Flatten messages to find the Read result — shape varies across
    // adapters (some use content blocks, some use plain strings).
    const flattened = JSON.stringify(messages);
    expect(flattened).toContain(SAMPLE_JS_SRC.trim());
  }, 15_000);
});

describe('wire basic lifecycle — subprocess mode', () => {
  it.todo(
    'wire subprocess variant: `kimi --wire` binary speaking stdio. ' +
      'Pending Phase 11 — canStartWireSubprocess() returns false today ' +
      '(test/helpers/wire/wire-subprocess-harness.ts:86). Expected: same ' +
      '3-step scripted_echo asserting translated.py on disk + turn.end ' +
      'reason=done over the subprocess transport.',
  );
});
