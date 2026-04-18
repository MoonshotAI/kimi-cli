# Phase 21 Section A.6.4 — hook.request reverse-RPC

## Why there is no standalone `A-hook-request.mjs`

Running a true hook.request round-trip in --wire isolation requires:
1. An actual LLM that returns a tool call, OR a way to inject one through the wire
2. A tool registered that would trigger PreToolUse
3. A mock client loop that responds to `hook.request` frames

The wire protocol today has no `session.injectToolCall` surface for (1)/(2), so
the smoke would need real model credentials. The equivalent coverage is already
in the production E2E test:

`packages/kimi-core/test/e2e/wire-hook-request-reverse-rpc.test.ts`

Driven through production `registerDefaultWireHandlers` (not the test-helper),
it covers the three Section A.6.4 scenarios:
- round-trip: client returns `{ok:true, blockAction:true}` → HookEngine aggregates block
- timeout: client never responds → fail-open (`{ok:true}`)
- malformed: client returns `{unrelated:'garbage'}` → fail-open

Running: `cd packages/kimi-core && npx vitest run test/e2e/wire-hook-request-reverse-rpc.test.ts`

All 3 cases PASS.
