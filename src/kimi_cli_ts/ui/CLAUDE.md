# UI Layer Architecture

## Rendering: Text Selection Fix

React Ink destroys terminal mouse text selection when it clears the screen. The fix has two layers:

**`ui/renderer/index.ts`** wraps `stdout.write` as a safety net to prevent Ink from clearing the screen:
- Strips `\x1b[2J` (erase screen) and `\x1b[3J` (erase scrollback) if they appear
- Rewrites those frames using CUP absolute positioning (`\x1b[row;1H`) per line — zero `\n`, no scroll pollution
- On DEC 2026 terminals, merges BSU/ESU into single atomic `stdout.write()`
- **Content shrink handling**: Tracks max rendered lines and emits `ERASE_BELOW` when content shrinks (e.g., closing a tall help panel), cleaning up orphaned lines at the bottom

By relying on this safety net, **Shell.tsx** does NOT use a fixed `height` on the root `<Box>`. This allows Ink to use incremental line-level diffing without reserving extra vertical space, avoiding excess blank lines and keeping the WelcomeBox visible without being pushed off-screen.

Debug log: `renderer-debug.log` in CWD. Key markers: `STRIP!` = clearTerminal intercepted, `FRAME#` = BSU/ESU frame, `SHRINK` = content shrink cleanup.

**Constraints:**
- Bun cannot monkey-patch Ink's ESM `log-update.js` (default exports are read-only)
- tmux does not support DEC 2026 synchronized output
- `renderer/` subdirectory has unused infrastructure files (screen.ts, diff.ts, ansi-parser.ts, patch-writer.ts) for future cell-level diffing

## Input Architecture

Single `useInput` in Shell via `useShellInput()` hook (`input-state.ts`). All rendering components are pure (no `useInput`, no keyboard state). All hotkey logic (Ctrl+C double-press exit, shell mode toggle, plan mode, editor) is also inside the hook.

```
Shell.tsx (thin orchestrator — no keyboard logic, no hotkey state)
├── useShellInput()              ← SINGLE useInput + UI state machine + hotkeys
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
| `shell/input-state.ts` | `useShellInput` hook: useInput singleton, state machine, key dispatcher, hotkeys, shellMode |
| `shell/input-stack.ts` | `useInputLayer` hook: input focus stack for layered keyboard capture |
| `shell/PromptView.tsx` | Pure render: separator + panel title + buffered lines + input with cursor |
| `shell/Shell.tsx` | Thin orchestrator: wires callbacks, renders layout. No keyboard logic. |
| `components/CommandPanel.tsx` | Controlled `ChoicePanel` + `ContentPanel` (no useInput) |
| `components/SlashMenu.tsx` | Pure render slash command menu |
| `components/MentionMenu.tsx` | Pure render @ mention menu |
| `components/StatusBar.tsx` | Pure render status bar (3 lines) |

### Rules

- **Never add `useInput` to rendering components.** All keyboard handling goes through `useShellInput` in `input-state.ts`.
- **Never add hotkey/shortcut logic to Shell.tsx.** Shell passes external callbacks (`onExit`, `onInterrupt`, `onPlanModeToggle`, `onOpenEditor`, `onNotify`) to `useShellInput`, which handles the logic internally.
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
