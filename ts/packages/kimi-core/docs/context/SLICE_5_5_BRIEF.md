# Slice 5.5 — Hook Config Loading + Event Type Expansion

**Gate 1**: D1=A (TOML config loading), D2=skip /init, D3=A (all 7 event types)

---

## Scope (~250 lines)

| Task | Description | Est. |
|------|------------|------|
| T1 | Parse `[[hooks]]` from KimiConfig into HookConfig[] | ~60 |
| T2 | Register CommandHookExecutor + loaded hooks at bootstrap | ~30 |
| T3 | Expand HookEventType union with 7 new events + input types | ~80 |
| T4 | Add trigger points for new events in existing code | ~40 |
| T5 | Tests | ~100 |
| **Total** | | **~310** |

---

## T1: Hook config parser

New: `src/hooks/config-loader.ts`

Parse the `hooks` field from `KimiConfig` (currently `unknown[]`) into typed `HookConfig[]`.

Python TOML format:
```toml
[[hooks]]
event = "PreToolUse"
command = "my-hook.sh"
matcher = "Bash"
timeout = 30
```

TS parser:
```typescript
function parseHookConfigs(raw: unknown[]): CommandHookConfig[] {
  // Validate each entry: event (must be valid HookEventType), command (string),
  // optional matcher (string), optional timeout (number, default 30s)
}
```

Also update `KimiConfig.hooks` type from `unknown[]` to `CommandHookConfig[]`.

## T2: Bootstrap wiring

Modify: `apps/kimi-cli/src/wire/kimi-core-client.ts`

Currently creates HookEngine with empty executors. Change to:
1. Create `CommandHookExecutor` with Kaos
2. Load hooks from config via `parseHookConfigs(config.hooks)`
3. Register each parsed hook

## T3: Event type expansion

Modify: `src/hooks/types.ts`

Add to `HookEventType` union:
- `SubagentStart` / `SubagentStop`
- `SessionStart` / `SessionEnd`
- `PreCompact` / `PostCompact`
- `StopFailure`

Add corresponding input interfaces (following existing pattern).

## T4: Trigger points

Add `hookEngine.trigger()` calls at:
- `SubagentStart`: subagent-runner.ts before runSoulTurn
- `SubagentStop`: subagent-runner.ts after runSoulTurn (success/fail/kill)
- `SessionStart`: session-manager.ts createSession
- `SessionEnd`: session-manager.ts closeSession
- `PreCompact` / `PostCompact`: turn-manager.ts around compaction
- `StopFailure`: turn-manager.ts onTurnEnd error path
