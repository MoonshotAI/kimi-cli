# test/helpers

Phase 9 test-infrastructure kit for `@moonshot-ai/core`. Pure test code
— nothing in `src/` imports from here.

New tests should:

```ts
import {
  FakeKosongAdapter,
  createFullToolset,
  createTestRuntime,
  createTestSession,
  createWireE2EHarness,
} from '../helpers/index.js';
```

Do **not** import from a nested path (`helpers/wire/wire-e2e-harness.js`
etc.) — future restructuring should stay invisible to callers.

## Python → TypeScript mapping

| Python fixture / helper                       | TS helper                                  |
| --------------------------------------------- | ------------------------------------------ |
| `MockChatProvider` (`tests/conftest.py:68`)   | `new FakeKosongAdapter()` + `.script(...)` |
| `temp_work_dir` / `temp_share_dir`            | `createTempWorkDir() / createTempShareDir()` |
| `runtime` (12-field fixture)                  | `createTestRuntime()` → `TestRuntimeBundle`|
| `session`                                     | `createTestSession()` → `TestSessionBundle`|
| `approval`                                    | `createTestApproval({yolo:true})`          |
| `approval` (scripted per-tool)                | `createScriptedApproval({...})`            |
| `environment`                                 | `createTestEnvironment({os:'macOS'})`      |
| `toolset`                                     | `createFullToolset()`                      |
| `read_file_tool`                              | `createReadTool()`                         |
| `write_file_tool`                             | `createWriteTool()`                        |
| `edit_tool`                                   | `createEditTool()`                         |
| `shell_tool`                                  | `createBashTool()`                         |
| `glob_tool`                                   | `createGlobTool()`                         |
| `grep_tool`                                   | `createGrepTool()`                         |
| `task_list_tool` / `_output` / `_stop`        | `createTaskListTool() / …Output / …Stop`   |
| `web_search_tool` / `fetch_url_tool`          | `createWebSearchTool() / createFetchURLTool()` |
| `ask_user_tool`                               | `createAskUserQuestionTool()`              |
| `set_todo_list_tool`                          | `createSetTodoListTool()`                  |
| `exit_plan_mode_tool` / `enter_plan_mode`     | `createExitPlanModeTool() / createEnterPlanModeTool()` |
| `agent_tool`                                  | `createAgentTool({host, agentId})`         |
| `tool_call_context()`                         | `makeToolCallStub(name, args?)`            |
| `WireProcess` / `start_wire`                  | `startWireSubprocess({workDir, homeDir})`  |
| `send_initialize`                             | `buildInitializeRequest()` + `harness.send(...)` |
| `collect_until_response`                      | `harness.collectUntilResponse(reqId)`      |
| `collect_until_request`                       | `harness.collectUntilRequest()`            |
| `build_approval_response`                     | `buildApprovalResponse(req, 'approved')`   |
| `build_question_response`                     | `buildQuestionResponse(req, {...})`        |
| `build_tool_result_response`                  | `buildToolResultResponse(req, {...})`      |
| `normalize_value` / `summarize_messages`      | `normalizeValue() / summarizeMessages()`   |
| `_spawn_workers`                              | `spawnWorkers({count, scriptPath, shareDir})` |
| `denwa_renji` / `labor_market` / `builtin_args` / `config` | No 1:1 — inline per test.           |
| ACP harness (`tests/acp/*`)                   | Not ported (v2 drops ACP).                 |

## Core factories

### `createTestRuntime(opts?) → TestRuntimeBundle`

In-memory, no filesystem. Gives you:

- `runtime: { kosong }` — strongly-typed `Runtime`
- `kosong: FakeKosongAdapter` — `calls`, `.script(...)`, `.scriptError(...)`
- `contextState: FullContextState` (InMemoryContextState)
- `sessionJournal: InMemorySessionJournal`
- `sink: SessionEventBus` (pre-subscribed) + `events: CollectingEventSink`
- `approval: ApprovalRuntime` (yolo default)
- `environment: TestEnvironment`, `tools: Tool[]`, `soulRegistry: SoulRegistry`
- `dispose()` + `[Symbol.asyncDispose]`

### `createTestSession(opts?) → TestSessionBundle`

File-backed. Spawns a tmp `KIMI_HOME` + workspace + share dir, runs
`SessionManager.createSession`, exposes `soulPlus` / `turnManager` /
`prompt(text)` / `dispose()`. Disposal closes the session and cleans
all tmp directories.

### `createWireE2EHarness(opts?) → WireE2EInMemoryHarness`

A `MemoryTransport` pair wired to a real `SessionManager` +
`RequestRouter` with default handlers registered for
`initialize` / `session.create` / `session.list` / `session.destroy` /
`shutdown` / `session.prompt` / `session.steer` / `session.cancel` /
`session.getStatus` / `session.getHistory` / `session.subscribe` /
`session.compact`. Tests can drive the full Wire protocol without
hand-registering routes. Supply `routerOverrides(router)` to swap in
custom handlers (e.g. emit reverse-RPC requests).

Exposes `send`, `request`, `expectEvent`, `collectUntilResponse`
(with an optional `requestHandler` for reverse-RPC auto-reply), and
`collectUntilRequest`. Subprocess alternative is
`startWireSubprocess()` — see below.

**Events semantics** (aligned with Python `wire_helpers.py`):
`collectUntilResponse` returns `{response, events}` where `events`
contains only `event` + reverse-RPC `request` frames — the
terminating `response` itself is **not** included. Same rule for
`collectUntilRequest` (returns the triggering `request`; `events`
contains only the preceding `event` frames).

## FakeKosongAdapter

Successor to `test/soul/fixtures/scripted-kosong.ts`:

```ts
const fake = new FakeKosongAdapter()
  .script({ text: 'first', stopReason: 'end_turn' })
  .script({
    toolCalls: [{ id: 'tc_0', name: 'Read', arguments: { path: '/x' } }],
    stopReason: 'tool_use',
  })
  .scriptError({ atTurn: 3, error: new Error('rate_limit') });

// Chunked streaming
fake.script({ text: 'hello world', streaming: 'chunked' });
// Custom chunks
fake.script({ text: '…', streaming: { chunks: ['foo', 'bar'] } });
```

`replaceUpcoming(turns)` swaps the unconsumed tail — useful for
plan-mode / steer tests.

## Lint clean-up (2026-04-17)

`pnpm lint` reports baseline (28 errors / 362 warnings) with zero
helpers-attributed diagnostics. Notable choices:

- **Internal barrels**: `helpers/kosong/index.ts` and
  `helpers/runtime/internal-deps.ts` let sibling files pull common
  symbols through a single import statement, keeping
  `import/max-dependencies` under 10 without inflating the file count.
- **`wire-e2e-harness.ts` disable**: the harness is the one file that
  legitimately spans hooks / router / session / soul-plus / transport
  / wire-protocol. It already consolidates through every upstream
  barrel; further splitting only produces boilerplate. `oxlint-disable
  import/max-dependencies` at the top of the file documents that.
- **`WireFrameQueue.push` spread**: `for (const l of [...listeners])`
  clones on purpose — a listener that resolves via `waitFor`
  unsubscribes itself synchronously, which would otherwise mutate the
  array mid-iteration and skip a neighbour. The `no-useless-spread`
  rule is disabled on the one line.

## Review Round 2 fixes (2026-04-17)

Addresses R2-1 / R2-2 / R2-3 + M3-补 / M5-补 / M6-补.

- **R2-1**: `createWireE2EHarness` no longer swallows dispatch errors
  — thrown routing errors are mapped to JSON-RPC style wire error
  responses (`-32600` malformed / `-32601` method not found /
  `-32602` invalid params / `-32000` session not found / `-32603`
  fallback). Clients see the failure immediately instead of
  hanging until timeout. Non-request frames still skip.
- **R2-2**: `FakeKosongAdapter` exposes `recordCall(params)` so
  `wrapExistingAsFake`'s chat-override keeps `calls` AND `callCount`
  in sync. No `as unknown as` casts.
- **R2-3**: wire harness `dispose()` now closes sessions first, then
  detaches the event listener, then closes the transport pair, then
  cleans temp dirs.
- **M3-补**: scripted-approval self-test now uses a custom `Tool`
  with a `vi.fn()` execute spy and asserts `spy` was never called
  after the reject.
- **M5-补**: new self-test in `runtime-bundle.test.ts` defines a
  `CustomAdapter implements KosongAdapter`, invokes chat twice,
  asserts `bundle.kosong.calls.length === 2 && callCount === 2` and
  that the underlying adapter also recorded both.
- **M6-补**: `tool-factories.test.ts` M6 case now asserts
  `toBe(sharedBg)` identity against Bash / TaskList / TaskOutput /
  TaskStop. Field access goes through a narrow `{'backgroundManager'
  in tool}` / `{'manager' in tool}` duck-type helper — TS `private`
  is a compile-time annotation only, and the runtime slot is
  present. No `as unknown as` casts; no src modifications required.

## Review Round 1 fixes (2026-04-17)

All 7 major + 3 nit findings from
`ts-refact-temp/context/slice-9-test-infra/review-round-1.md` are
addressed. Highlights:

- **Real SessionManager wiring** — `createWireE2EHarness` mints a tmp
  `PathConfig` + real `SessionManager` and registers a default
  handler set (M1).
- **step-block reorder + tool_call_order** — `summarizeMessages`
  extracts `step.end`/`tool.result` before sorting, then orders
  `tool.result` by the matching `tool.call` sequence (M2).
- **Approval actually wired** — `createTestSession({approval})`
  builds a `ToolCallOrchestrator` and passes it to SessionManager so
  scripted reject decisions veto the tool call (M3).
- **Events shape** — `collectUntilResponse` / `collectUntilRequest`
  exclude the terminator from `events` (M4).
- **Shared wrap-existing** — both `create-test-runtime` and
  `create-test-session` use `resolveKosongPair` so custom adapter
  calls are visible on `.kosong.calls` (M5).
- **Shared BackgroundProcessManager** — `createFullToolset` threads
  a single manager through Bash + Task{List,Output,Stop} (M6).
- **TimeoutError** — `spawnWorkers` rejects the Promise with a
  `TimeoutError` instance and SIGKILLs every live worker (M7).
- **Error context** — wire timeout messages now include method /
  request id / pid (N1).
- **Import dedup** — tool-factories uses `AlwaysSkipQuestionRuntime`
  directly (N2).
- **Barrel** — `CollectingEventSink` + `TimeoutError` exported (N3).

## Known gaps (to fill in Phase 10 / 11)

- **Subprocess wire harness**: `apps/kimi-cli/src/index.ts:runWire`
  currently prints `Wire mode: not yet implemented (Phase 11)`, so
  `startWireSubprocess()` is dead-on-arrival. The harness machinery
  (spawn + JSON-line framing + queue) is in place; Phase 11 just has
  to wire the real entrypoint. `canStartWireSubprocess()` returns
  `false` today; self-tests use `describe.skipIf(...)` accordingly.
- **`TestEnvironment` shim**: src/ has no `Environment` type. We
  define a local shape under `helpers/runtime/create-test-environment.ts`.
  Promote into src/ when a production consumer appears.
- **Tool registry matching Python `KimiToolset`**: `createFullToolset`
  currently assembles 17 tools but does not honor `--active-tools`
  config. When SessionManager or Agent YAML plumbing exposes a
  canonical list, swap the inner array for that source.
- **Per-session scripted approval rules**: `createScriptedApproval`
  resolves decisions via a queue + per-tool table. Python extends this
  with "rule injection" for session-scope approvals; ignore until a
  test case actually demonstrates the need.

## Self-test

`test/helpers.self-test/*.test.ts` verifies the core contracts of
each helper. Run with:

```bash
pnpm -C packages/kimi-core exec vitest run test/helpers.self-test
```

The subprocess self-test is tagged `skip-if-no-bin` via
`describe.skipIf(!canStartWireSubprocess())`, so a missing or stubbed
CLI binary does not fail CI.
