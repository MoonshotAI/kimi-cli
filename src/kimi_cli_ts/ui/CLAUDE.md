# UI Layer Architecture

## Rendering: Text Selection Fix

React Ink destroys terminal mouse text selection when it clears the screen. The fix has two layers:

**Shell.tsx** does NOT use a fixed `height` on the root `<Box>`. This lets Ink render only the actual content height, using incremental line-level diffing (eraseLines + overwrite). WelcomeBox is rendered via `<Static>` into terminal scrollback, and the dynamic content (prompt + status bar + panels) renders directly below. When a panel closes, Ink's `eraseLines(N)` correctly clears all N previous lines; any remaining blank space below is normal terminal viewport area.

**`ui/renderer/index.ts`** wraps `stdout.write` as a safety net:
- Strips `\x1b[2J` (erase screen) and `\x1b[3J` (erase scrollback) if they appear
- Rewrites those frames using CUP absolute positioning (`\x1b[row;1H`) per line — zero `\n`, no scroll pollution
- On DEC 2026 terminals, merges BSU/ESU into single atomic `stdout.write()`
- Guards against double-wrapping (module re-imports in reload loop) via `__rendererPatched`/`__rendererWrapped` markers on stdout

Debug log: `renderer-debug.log` in CWD. Key markers: `STRIP!` = clearTerminal intercepted, `FRAME#` = BSU/ESU frame.

**Layout constraints:**
- Do NOT add `height={termHeight-1}` to root Box — causes WelcomeBox to be pushed far from input, or lost entirely
- Do NOT use `justifyContent="flex-end"` on root Box — breaks `<Static>` rendering
- Blank terminal rows below the content after closing a tall panel is normal terminal behavior (not dirty content)

**Constraints:**
- Bun cannot monkey-patch Ink's ESM `log-update.js` (default exports are read-only)
- screen does not support DEC 2026 synchronized output
- `renderer/` subdirectory has unused infrastructure files (screen.ts, diff.ts, ansi-parser.ts, patch-writer.ts) for future cell-level diffing

## Input Architecture

Single `useInput` in Shell via `useShellInput()` hook (`input-state.ts`). All rendering components are pure (no `useInput`, no keyboard state). All hotkey logic (Ctrl+C double-press exit, shell mode toggle, plan mode, editor) is also inside the hook.

Shell.tsx is a thin orchestrator. Logic is split across focused modules:

```
Shell.tsx (orchestrator — wires hooks together, renders layout)
│
├── shell-commands.ts            ← deduplicateCommands(), createAllCommands(), SHELL_MODE_COMMANDS
├── shell-executor.ts            ← runShellCommand(), openExternalEditor()
├── useShellCallbacks.ts         ← all callback logic for useShellInput + handleApprovalResponse
│                                   uses ref-based accessor to break circular dep with inputState
├── usePromptSymbol.ts           ← getPromptSymbol() — pure function: mode/shellMode/streaming → symbol
├── useShellLayout.ts            ← useShellLayout() — terminal height + staticItems computation
│
├── useShellInput()              ← SINGLE useInput + UI state machine + hotkeys (input-state.ts)
│   ├── useInputHistory()        ← input value, cursor, history (persisted per-cwd)
│   ├── useFileMention()         ← @ file mention suggestions
│   ├── UIMode state machine     ← routes keys by current mode
│   ├── Hotkeys                  ← Ctrl+C double-press, Ctrl+X shell mode, Shift+Tab plan, Ctrl+O editor
│   ├── shellMode state          ← owned here, exposed to Shell as inputState.shellMode
│   └── Input Stack              ← dispatches to top layer if any (see input-stack.ts)
│
├── <Static>                     ← scrollback (WelcomeBox + completed messages)
├── <StreamingContent>           ← current message + spinners + approval
├── <PromptView>                 ← pure render: separator + input line with cursor
└── Bottom slot (conditional):
      ChoicePanel                ← when mode = panel_choice
    | ContentPanel               ← when mode = panel_content
    | SlashMenu                  ← when mode = slash_menu
    | MentionMenu                ← when mode = mention_menu
    | StatusBar                  ← when mode = normal (or panel_input)
```

### UI State Machine (`UIMode`)

```
normal ──── "/" typed ──────→ slash_menu
normal ──── "@" typed ──────→ mention_menu
normal ──── cmd with panel ─→ panel_choice / panel_input / panel_content

slash_menu ── Esc/clear ────→ normal
slash_menu ── Enter (panel) → panel_*
slash_menu ── Enter (exec) ─→ normal

mention_menu ── Esc/clear ──→ normal
mention_menu ── Enter/Tab ──→ normal (apply selection)

panel_choice ── Esc ────────→ normal
panel_choice ── Enter ──────→ normal or panel_* (chain)

panel_input ── Esc ─────────→ normal
panel_input ── Enter ───────→ normal or panel_* (chain)

panel_content ── Esc ───────→ normal
```

### Key Files

| File | Role |
|------|------|
| `shell/Shell.tsx` | Thin orchestrator: wires hooks together, renders layout. No keyboard logic, no callbacks. |
| `shell/input-state.ts` | `useShellInput` hook: useInput singleton, state machine, key dispatcher, hotkeys, shellMode |
| `shell/input-stack.ts` | `useInputLayer` hook: input focus stack for layered keyboard capture |
| `shell/shell-commands.ts` | Command management: `deduplicateCommands`, `createAllCommands`, `SHELL_MODE_COMMANDS` |
| `shell/shell-executor.ts` | Subprocess execution: `runShellCommand`, `openExternalEditor` |
| `shell/useShellCallbacks.ts` | Callback bundle for useShellInput (onSubmit, onInterrupt, etc.) + handleApprovalResponse |
| `shell/usePromptSymbol.ts` | `getPromptSymbol()` — pure function deriving prompt symbol from UI state |
| `shell/useShellLayout.ts` | `useShellLayout()` — terminal height tracking + staticItems computation |
| `shell/PromptView.tsx` | Pure render: separator + panel title + buffered lines + input with cursor |
| `components/CommandPanel.tsx` | Controlled `ChoicePanel` + `ContentPanel` (no useInput) |
| `components/SlashMenu.tsx` | Pure render slash command menu |
| `components/MentionMenu.tsx` | Pure render @ mention menu |
| `components/StatusBar.tsx` | Pure render status bar (3 lines) |

### Rules

- **Never add `useInput` to rendering components.** All keyboard handling goes through `useShellInput` in `input-state.ts`.
- **Never add hotkey/shortcut logic to Shell.tsx.** Shell delegates callback construction to `useShellCallbacks`, which returns the bundle for `useShellInput`. Hotkey handling lives in `input-state.ts`.
- **Never put utility functions or subprocess logic in Shell.tsx.** Shell commands go in `shell-commands.ts`, execution logic in `shell-executor.ts`.
- **PromptView, ChoicePanel, ContentPanel, SlashMenu, MentionMenu, StatusBar** are pure — they receive all data via props.
- **Bottom slot is mutually exclusive**: only one of the 5 components renders at a time based on `UIMode`.
- **`<Static>` for completed content**: WelcomeBox and finished messages go into `<Static>` so they enter scrollback and are never re-drawn.
- Old `Prompt.tsx` is deprecated — `PromptView.tsx` + `input-state.ts` replace it.

### Input Stack (`input-stack.ts`)

Components that need temporary keyboard capture (e.g., ApprovalPanel) use `useInputLayer(handler)` instead of Ink's `useInput`. This pushes a handler onto a global stack. The central `useInput` in `input-state.ts` checks the stack on every keypress:

- **Ctrl+C**: Always handled globally (interrupt / double-press exit), never routed to stack
- **Esc**: Closes panels first (global), then routes to top layer if any, then falls through to interrupt
- **All other keys**: If a layer exists on the stack, routed to the top layer. Otherwise, routed to the default handler (UIMode state machine).

When the component unmounts, `useInputLayer`'s cleanup effect automatically pops the layer, restoring keyboard focus to the previous handler or the default prompt input.

```typescript
// Example: ApprovalPanel captures keyboard while mounted
export function ApprovalPanel({ request, onRespond }: ApprovalPanelProps) {
  useInputLayer((input, key) => {
    if (key.return) { onRespond("approve"); return; }
    if (key.upArrow) { /* navigate */ }
    // ...
  });
  return <Box>...</Box>;
}
```

## Slash Command Output → Message Stream

Slash command handlers that need to display text in the message stream must **return a string**. The flow is:

1. Handler returns `Promise<string>` (or `string`)
2. `useShellCallbacks.ts` `onSubmit` calls `cmd.handler(args)`, awaits the promise, and if result is a string pushes `wire.pushEvent({ type: "slash_result", text: feedback })`
3. `useWire.ts` receives `slash_result` event, creates a `UIMessage` with `role: "system"` and inserts it into the message list via `setMessages`

**Anti-pattern**: using `logger.info()` inside a handler — this only writes to the log file on disk, nothing appears in the UI. This was the original bug in `/export` and `/import`.

**Correct pattern** (e.g., `export_import.ts`):
```typescript
// Handler returns a string → displayed in message stream
export async function handleExport(...): Promise<string> {
  // ... do work ...
  return `Exported ${count} messages to ${display}\nNote: ...`;
}

// kimisoul.ts wiring — must return the string
exportCmd.handler = async (args: string) => {
  return await handleExport(this.context, this.agent.runtime.session, args);
};
```

**Key files in the chain:**
- `useShellCallbacks.ts:86-93` — checks handler return, pushes `slash_result` event
- `events.ts:65` — `{ type: "slash_result"; text: string }` event type definition
- `useWire.ts:214-224` — converts `slash_result` into a system `UIMessage`

### Migration Status

**Completed** (all handlers now return strings):
- ✅ `export_import.ts` — `/export`, `/import` 
- ✅ `misc.ts` — `/web`, `/vis`, `/reload`, `/task`
- ✅ `editor.ts` — `/editor`
- ✅ `info.ts` — `/hooks`, `/mcp`, `/debug`, `/changelog`
- ✅ `add_dir.ts` — `/add-dir`
- ✅ `feedback.ts` — `/feedback`
- ✅ `session.ts` — `/new`, `/sessions`, `/title`
- ✅ `usage.ts` — `/usage`
- ✅ `init.ts` — `/init`
- ✅ All handlers wired in `kimisoul.ts` to return strings

**Not changed** (use notify callbacks, not logger.info):
- `login.ts` — `/login`, `/logout` (use notify pattern, not slash output)
- `model.ts` — `/model` (uses notify pattern)

## `/clear` Command Logic Comparison: Python vs TS

### Python Implementation ✅

**File:** `src/kimi_cli/ui/shell/slash.py` (lines 488-494)
```python
@registry.command(aliases=["reset"])
async def clear(app: Shell, args: str):
    """Clear the context"""
    if ensure_kimi_soul(app) is None:
        return
    await app.run_soul_command("/clear")  # Executes soul-level command
    raise Reload()  # Reloads shell UI with clean display
```

**Soul-level handler in `src/kimi_cli/soul/slash.py` (lines 75-89):**
```python
@registry.command(aliases=["reset"])
async def clear(soul: KimiSoul, args: str):
    """Clear the context"""
    await soul.context.clear()
    await soul.context.write_system_prompt(soul.agent.system_prompt)
    wire_send(TextPart(text="The context has been cleared."))  # ← SENDS TO WIRE
    snap = soul.status
    wire_send(StatusUpdate(...))  # ← SENDS TO WIRE
```

**Key behaviors:**
1. Soul-level handler uses `wire_send(TextPart(...))` to **send message to the message stream** while still in the same session
2. The visualizer (`visualize.py`) catches this TextPart and wraps it with a bullet character "•"
3. Shell-level handler raises `Reload()` which reloads the UI to a clean state
4. User sees: `"• The context has been cleared."` in message stream, then fresh session reload

### TypeScript Implementation (BROKEN) ❌

**File:** `src/kimi_cli_ts/ui/shell/slash.ts` (lines 40-59)
```typescript
handler: async () => {
  await ctx.soulClear?.();  // Calls soul-level handler
  const height = ctx.getDynamicViewportHeight?.() ?? 5;
  if (ctx.triggerReload && ctx.sessionId) {
    ctx.triggerReload(ctx.sessionId);  // Unmounts Ink
  }
  // MISSING: ctx.clearMessages() ❌
  process.stdout.write(
    (eraseLine + cursorUp).repeat(height) +
    eraseLine + "\r" +
    "• The context has been cleared.\n"
  );
},
```

**Soul-level handler in `src/kimi_cli_ts/soul/kimisoul.ts` (lines 755-760):**
```typescript
clearCmd.handler = async () => {
  await this.context.clear();
  await this.context.writeSystemPrompt(this.agent.systemPrompt);
  logger.info("Context cleared");  // ← WRITES TO LOG FILE ONLY ❌
  this.callbacks.onStatusUpdate?.(this.status);  // ← Status update only
};
```

### Root Causes of Residual Display

1. **Missing `wire_send` in soul-level handler**: TS soul has no `wire_send` mechanism (see TODO at `kimisoul.ts:1234`). The soul-level handler only calls `onStatusUpdate`, not `onTextDelta` or equivalent. Should send the message via callbacks.

2. **Missing `clearMessages()` call**: The shell-level `/clear` handler receives `ctx.clearMessages` (wire state reset function) but never calls it. This leaves thinking text, message history, and previous content in `wire.messages`.

3. **Timing issue with `process.stdout.write`**: After `triggerReload()` calls `inkUnmount()`, the handler immediately calls `process.stdout.write()`. But:
   - The new Ink instance is created and starts rendering immediately
   - The Static component rebuilds from `wire.messages` (which hasn't been cleared!)
   - The new render likely overwrites the `process.stdout.write` output
   - The old Ink final frame's residual text (input prompt showing "/clear") persists in the terminal

4. **Static rendering from uncleared wire.messages**: When the new Ink instance renders, `useShellLayout` builds staticItems from `wire.messages`. Since messages were never cleared, all previous thinking text, responses, etc. re-appear in the new session's Static area.

### Fix Strategy

The TS version needs to:
1. **Clear wire messages BEFORE unmounting Ink**: Call `ctx.clearMessages()` in the handler before `triggerReload()`
2. **Add wire_send equivalent to soul-level handler**: Instead of just `logger.info()`, call `this.callbacks.onTextDelta()` or create a new callback to send the "context has been cleared" message to wire
3. **Ensure clean terminal state**: The Ink unmount/remount cycle needs to properly erase old content

## DEBUG

you can use screen  and bun run start to launch tui and debug ui

debug时需要使用本地磁盘log 不要污染stderr

## Integration Testing: tmux Side-by-Side Verification

Any new feature or bugfix that touches the TS version **must** be integration-tested against the Python version using tmux to confirm behavioral parity. This is a hard rule — do not skip it.

### Why

Unit tests cannot catch UI-level behavioral differences (approval dialog content, subagent event rendering, concurrent execution order, keyboard interaction timing). The only reliable way to verify TS↔Python alignment is to run both side-by-side with identical input and compare the observable output.

### Procedure

```bash
# 1. Launch both versions
tmux new-session -d -s py -x 130 -y 50 -c "$(pwd)" 'uv run kimi; exec bash'
tmux new-session -d -s ts -x 130 -y 50 -c "$(pwd)" 'bun run start; exec bash'
sleep 12  # wait for startup

# 2. Verify ready (💫 prompt visible)
tmux capture-pane -t py -p | grep "💫"
tmux capture-pane -t ts -p | grep "💫"

# 3. Send identical prompt to both
tmux send-keys -t py "your test prompt here"
tmux send-keys -t py Enter
tmux send-keys -t ts "your test prompt here"
tmux send-keys -t ts Enter

# 4. Capture and compare output
tmux capture-pane -t py -p -S -200 > /tmp/py-output.txt
tmux capture-pane -t ts -p -S -200 > /tmp/ts-output.txt
diff /tmp/py-output.txt /tmp/ts-output.txt

# 5. For approval interactions — send ONLY the number key, NOT Enter
#    (number key triggers onSelect directly; Enter causes double-fire)
tmux send-keys -t ts "1"    # approve once
tmux send-keys -t py "1"

# 6. Cleanup
tmux kill-session -t py
tmux kill-session -t ts
```

### What to Compare

| Aspect | How to check |
|--------|-------------|
| Approval dialog content | `grep -A 15 "ACTION REQUIRED"` — verify Subagent/Task metadata lines match |
| Concurrent subagent count | Look for `⟳ Using Agent` (TS) / `⠼ Using Agent` (PY) lines — count must match |
| Approval queue behavior | Approve first, wait 3s, check if second approval pops up |
| Tool execution order | Compare tool call/result sequence in output |
| Final result text | Compare the summary after all subagents complete |

### When to Run

- Any change to `soul/toolset.ts`, `soul/kimisoul.ts` (tool execution)
- Any change to `ui/hooks/useWire.ts`, `ui/shell/useShellCallbacks.ts` (approval flow)
- Any change to `subagents/runner.ts`, `subagents/builder.ts` (subagent lifecycle)
- Any change to `approval_runtime/`, `soul/approval.ts` (approval system)
- Any change to `cli/index.ts` rootWireHub event forwarding
- Any new tool or wire event type

### Gotchas

- **Do NOT send `Enter` after number key in approval panels.** Number keys (`1`/`2`/`3`/`4`) trigger selection directly in `SelectionPanel`. Sending Enter afterwards will approve the NEXT queued request due to React state update timing. This is a tmux testing artifact — real users press either number key OR arrow+Enter, not both.
- **Wait at least 12s after launch** before sending input. Ink TUI needs time to mount.
- **LLM responses are non-deterministic.** The exact wording will differ, but the structural behavior (number of subagents, approval sequence, tool calls) must match.
- **Check session logs** for debugging: `ls -1t ~/.kimi/sessions/*/*/logs.log | head -1 | xargs tail -50`

## Concurrent Subagent Execution & Approval Queue

### Problem Solved

TS version only showed one subagent running when the LLM dispatched multiple Agent tool calls in parallel. Python showed both running concurrently with separate approval dialogs.

Three layers of issues were found and fixed:

### Layer 1: Tool Execution Concurrency (`soul/toolset.ts`)

**Python** uses `ContextVar` + `asyncio.create_task()`:
```python
# toolset.handle() returns Task immediately — all tasks run concurrently
def handle(self, tool_call):
    token = current_tool_call.set(tool_call)  # ContextVar: per-task isolation
    try:
        return asyncio.create_task(_call())    # Task inherits ContextVar
    finally:
        current_tool_call.reset(token)
```

**TS had a module-level global** `let _currentToolCall` — concurrent tools clobbered each other's context. Fixed by using `AsyncLocalStorage` (Node.js equivalent of Python's `ContextVar`):

```typescript
const _toolCallStorage = new AsyncLocalStorage<ToolCall | null>();

handle(toolCall: ToolCall): Promise<ToolResult> {
  return _toolCallStorage.run(toolCall, () =>
    this._executeToolAsync(toolCall),
  );
}
```

`kimisoul.ts` `_executeToolsShielded()` follows 3-phase pattern:
1. **Dispatch**: create all promises immediately (non-blocking)
2. **Collect**: `Promise.all()` — true concurrent execution
3. **Append**: sequential context append (maintains order)

### Layer 2: Approval Queue (`ui/hooks/useWire.ts`)

**Python** queues approval requests in a `deque[ApprovalRequest]`, shows them one by one.

**TS had** `pendingApproval: ApprovalRequest | null` — new requests replaced the old one. Fixed by using an array queue:

```typescript
const [approvalQueue, setApprovalQueue] = useState<ApprovalRequest[]>([]);

case "approval_request":
  setApprovalQueue(prev => [...prev, event.request]);  // enqueue
case "approval_response":
  setApprovalQueue(prev => prev.filter(r => r.id !== event.requestId));  // dequeue
```

`pendingApproval` is derived as `approvalQueue[0]` — the head of the queue.

`Shell.tsx` uses `key={wire.pendingApproval.id}` on `<ApprovalPanel>` to force React to remount when the head changes (resets all internal state like selection index).

### Layer 3: Double-Fire Prevention (`useShellCallbacks.ts`, `SelectionPanel.tsx`)

**Bug**: When user presses number key "1" to approve, `SelectionPanel` calls `onSelect(0)` immediately. 300ms later, the Enter key arrives. By then React has updated the queue — `pendingApproval` points to the NEXT request. The Enter event triggers `onSelect` again on the NEW `SelectionPanel` instance, auto-approving the second request without user intent.

**Fix**: `handleApprovalResponse` in `useShellCallbacks.ts` uses:
1. `respondedIdsRef` (Set) — tracks already-responded request IDs across renders
2. Time-window debounce (400ms) — ignores rapid-fire responses

```typescript
const respondedIdsRef = useRef(new Set<string>());
const lastRespondTimeRef = useRef(0);

const handleApprovalResponse = useCallback((decision, feedback) => {
  const current = wire.pendingApproval;
  if (!current) return;
  if (respondedIdsRef.current.has(current.id)) return;     // already handled
  if (Date.now() - lastRespondTimeRef.current < 400) return; // debounce
  respondedIdsRef.current.add(current.id);
  lastRespondTimeRef.current = Date.now();
  onApprovalResponseExternal?.(current.id, decision, feedback);
  wire.pushEvent({ type: "approval_response", ... });
}, [...]);
```

### Layer 4: Subagent Info in Approval Panel (`soul/approval.ts`, `subagents/runner.ts`, `cli/index.ts`)

**Python** shows `Subagent: coder (agent_id)` and `Task: description` in the approval dialog by:
1. Setting `ApprovalSource` with `agent_id` and `subagent_type` via ContextVar before soul execution
2. Enriching `source_description` from `subagent_store.get_instance(agent_id).description` before UI display

**TS was missing both**. Fixed by:
1. `subagents/runner.ts`: wraps soul execution in `runWithApprovalSourceAsync(source, fn)` so all inner `approval.request()` calls inherit the source
2. `soul/approval.ts`: reads `getCurrentApprovalSourceOrNull()` from AsyncLocalStorage (mirrors Python's `get_current_approval_source_or_none()`)
3. `cli/index.ts`: enriches `source_description` from `subagentStore.getInstance(agent_id).description` when forwarding approval requests to UI

### Key Architectural Pattern: AsyncLocalStorage = Python ContextVar

| Python | TypeScript | Purpose |
|--------|-----------|---------|
| `ContextVar[ToolCall]` | `AsyncLocalStorage<ToolCall>` | Per-tool-call context in concurrent execution |
| `ContextVar[ApprovalSource]` | `AsyncLocalStorage<ApprovalSource>` | Per-subagent approval source |
| `asyncio.create_task()` inherits ContextVar | `AsyncLocalStorage.run()` wraps async execution | Context propagation |

### Files Changed

| File | Change |
|------|--------|
| `soul/toolset.ts` | `AsyncLocalStorage` for `_currentToolCall`, non-blocking `handle()` |
| `soul/kimisoul.ts` | 3-phase concurrent tool execution |
| `soul/approval.ts` | Read approval source from `AsyncLocalStorage` |
| `subagents/runner.ts` | `runWithApprovalSourceAsync()` wrapping soul execution |
| `ui/hooks/useWire.ts` | Approval queue (array instead of single value) |
| `ui/shell/useShellCallbacks.ts` | Double-fire prevention (Set + debounce) |
| `ui/shell/Shell.tsx` | `key={request.id}` on ApprovalPanel |
| `cli/index.ts` | Enrich `source_description` from subagent store |

### RootWireHub Event Flow for Approvals

```
Subagent Shell tool → approval.request() → ApprovalRuntime.createRequest()
  → _publishWireRequest() → rootWireHub.publishNowait()
  → cli/index.ts rootHubQueue.get() → enrich source_description
  → pushEvent({ type: "approval_request", request })
  → useWire: setApprovalQueue(prev => [...prev, request])
  → Shell.tsx: <ApprovalPanel key={id} request={queue[0]} />

User approves → handleApprovalResponse()
  → onApprovalResponseExternal() → approvalRuntime.resolve()
  → wire.pushEvent({ type: "approval_response" })
  → useWire: setApprovalQueue(prev => prev.filter(...))
  → Next request becomes queue[0] → ApprovalPanel re-renders
```

**Important**: Do NOT forward `ApprovalResponse` from rootWireHub to UI pushEvent. Responses flow only through `handleApprovalResponse → wire.pushEvent`. Forwarding both causes double-processing and phantom auto-approvals.