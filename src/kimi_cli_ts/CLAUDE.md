# Kimi CLI TypeScript Implementation

## Child CLAUDE.md Files

- `ui/CLAUDE.md` — UI layer architecture (rendering text selection fix, input architecture, state machine, slash command output)

## Quick Overview

**Kimi CLI TypeScript** is an AI agent for terminal software engineering. It implements the core agent loop, CLI routing, UI, tools, and LLM integration in TypeScript using Bun as the runtime.

- **Language**: TypeScript 5 (strict mode)
- **Runtime**: Bun 1.x (Node.js-compatible, native TS support)
- **Build**: `bun build --compile` → native binary
- **UI**: React 19 + Ink 6 (terminal React renderer)
- **CLI**: Commander.js 14
- **LLM**: Multi-provider abstraction (Anthropic, OpenAI, Google)

## Tech Stack

### Core

| Component | Package | Version | Role |
|-----------|---------|---------|------|
| Runtime | Bun | 1.x | TypeScript-first runtime, bundler, package manager |
| Language | TypeScript | 5 | Type-safe code |
| CLI | Commander.js | 14 | CLI argument parsing & routing |
| Config | @iarna/toml, zod | 2.2.5, 4.3.6 | TOML config loading, schema validation |

### UI & Terminal

| Component | Package | Version | Role |
|-----------|---------|---------|------|
| UI Framework | React | 19.2.4 | Component library |
| Terminal Renderer | Ink | 6.8.0 | React → Terminal rendering |
| Input | ink-text-input | 6.0.0 | Text input component |
| Spinner | ink-spinner | 5.0.0 | Loading animation |
| Colors | chalk | 5.6.2 | Terminal colors |

### LLM Providers

| Provider | Package | Version | Role |
|----------|---------|---------|------|
| Anthropic (Claude) | @anthropic-ai/sdk | 0.81.0 | LLM API client |
| OpenAI (GPT) | openai | 6.33.0 | LLM API client |
| Google (Gemini) | @google/genai | 1.48.0 | LLM API client |

### Utilities

| Component | Package | Version | Role |
|-----------|---------|---------|------|
| Globbing | globby | 16.2.0 | Fast file pattern matching |
| IDs | nanoid | 5.1.7 | Unique ID generation |
| Logging | log4js | 6.9.1 | Legacy logging (being phased out) |

### Development

| Tool | Package | Version | Role |
|------|---------|---------|------|
| Linter/Formatter | Biome | 2.4.10 | Code quality (replaces ESLint/Prettier) |
| Type Checking | TypeScript | 5 | tsc --noEmit |

## Directory Structure

```
src/kimi_cli_ts/
├── Root (11 files) ..................... Entry, config, app, session, LLM
├── cli/ (9 files) ...................... Command routing & dispatcher
├── soul/ (10 files) .................... Core agent loop
├── tools/ (21 files) ................... Built-in tools (file, shell, web, etc.)
├── ui/ (42 files) ...................... User interface layers
│   ├── shell/ (18 files) .............. Shell TUI (Ink-based)
│   ├── components/ (8 files) .......... React components
│   ├── hooks/ (6 files) ............... React hooks
│   ├── renderer/ (8 files) ............ Terminal rendering
│   ├── print/ (1 file) ................ Print UI mode
│   └── CLAUDE.md ...................... UI architecture docs
├── wire/ (9 files) .................... Event streaming protocol
├── utils/ (14 files) .................. Utilities (logging, async, etc.)
├── background/ (6 files) .............. Background task queue
├── subagents/ (8 files) ............... Sub-agent system
├── notifications/ (7 files) ........... User notifications
├── auth/ (3 files) .................... OAuth & token management
├── hooks/ (3 files) ................... Event hooks
├── approval_runtime/ (1 file) ......... Approval state management
├── plugin/ (2 files) .................. Plugin system
└── skill/ (subdirs) ................... Skills & flows
```

## Architecture Layers

### 1. Entry Point & CLI Routing

**File**: `index.ts`, `cli/index.ts`

```
index.ts (#!/usr/bin/env bun)
  └─ cli/index.ts (Commander.js dispatcher)
       ├─ web mode    → Web UI server
       ├─ shell mode  → Shell TUI (default)
       ├─ print mode  → Non-interactive print
       └─ acp mode    → IDE integration server
```

**Key Files**:
- `index.ts` - Executable shebang + entry
- `cli/index.ts` - Command routing via Commander.js
- `cli/commands/*.ts` - Command implementations (model, login, config, etc.)

### 2. App Factory & Runtime

**File**: `app.ts`

`KimiCLI.create()` wires together all components:

```typescript
KimiCLI.create({
  agent: "default",     // Agent spec to load
  config: {...},        // User config (TOML)
  mcp: {...}            // MCP servers
})
```

**Responsibilities**:
1. Load agent spec (YAML, with system prompt)
2. Create session (per-workdir, persistent)
3. Choose LLM provider (Anthropic, OpenAI, etc.)
4. Instantiate toolset (file, shell, web, etc.)
5. Restore conversation history (Context)
6. Return configured KimiSoul ready for `.run()`

**Key Files**:
- `app.ts` - App factory
- `config.ts` - TOML config loading + Zod validation
- `session.ts` - Session management (per-workdir)
- `llm.ts` - Multi-provider LLM abstraction
- `agentspec.ts` - Agent spec YAML loading

### 3. Core Agent Loop

**File**: `soul/kimisoul.ts`

The main event loop:

```
1. Accept user input
2. Append to conversation history (Context)
3. Call LLM with tools (streaming)
4. Parse tool calls
5. Execute tools (with approvals)
6. Emit wire events (for UI)
7. Repeat
```

**Responsibilities**:
- LLM chat completion with streaming
- Tool call parsing & execution
- Context compaction (when history grows)
- Error handling & retries
- Integration with approval system

**Key Files**:
- `soul/kimisoul.ts` - Main loop
- `soul/context.ts` - Conversation history + checkpoints
- `soul/approval.ts` - Tool approval facade
- `soul/compaction.ts` - Context compaction (shrink history)

### 4. Tooling System

**File**: `tools/registry.ts`

Tools are registered by import path and executed via `KimiToolset`:

```typescript
abstract class CallableTool<TParams> {
  abstract params: ZodSchema<TParams>;
  abstract call(params: TParams, context: ToolContext): Promise<string>;
}
```

**Built-in Tools** (21 files):

| Tool | Purpose |
|------|---------|
| `agent/` | Create/resume sub-agents |
| `ask_user/` | Get user input with approval |
| `background/` | Queue background tasks |
| `dmail/` | Checkpointed replies |
| `think/` | Extended reasoning |
| `todo/` | Todo list management |
| `plan/` | Planning & task breakdown |
| `shell/` | Execute shell commands |
| `web/fetch` | HTTP requests |
| `web/search` | Web search |
| `file/glob` | File pattern matching |
| `file/grep` | Text search in files |
| `file/read` | Read file contents |
| `file/read_media` | Read images/binary |
| `file/write` | Write files |
| `file/replace` | Find-replace in files |

**Key Files**:
- `tools/registry.ts` - Tool loader & registry
- `tools/types.ts` - `CallableTool<T>` base class
- `tools/*/` - Tool implementations

### 5. User Interface

**File**: `ui/shell/Shell.tsx`

React Ink-based terminal TUI with multi-mode input:

```
Shell (Ink root)
  ├─ <Static>         (scrollback: WelcomeBox + completed messages)
  ├─ <StreamingContent> (current message + spinners + approval)
  ├─ <PromptView>     (input line with cursor)
  └─ Bottom Slot (one of):
       ├─ ChoicePanel (user choice prompt)
       ├─ ContentPanel (user text input)
       ├─ SlashMenu (/ command menu)
       ├─ MentionMenu (@ file mention)
       └─ StatusBar (3-line status)
```

**Key Concepts**:

1. **Input Architecture**: Single `useInput` in `useShellInput()` hook (not in components)
2. **UI State Machine**: `UIMode` enum routes keys (normal → slash_menu → panel_choice, etc.)
3. **Input Stack**: Layered keyboard capture for approval panels
4. **Rendering Fix**: `renderer/index.ts` wraps `stdout.write` to preserve text selection

See **`ui/CLAUDE.md`** for detailed rendering and input architecture.

**Key Files**:
- `ui/shell/Shell.tsx` - Main TUI orchestrator
- `ui/shell/input-state.ts` - `useShellInput` hook + state machine
- `ui/shell/input-stack.ts` - Layered input capture
- `ui/shell/PromptView.tsx` - Pure render: input line with cursor
- `ui/components/*.tsx` - React components (panels, menus, etc.)
- `ui/renderer/index.ts` - Ink stdout wrapper (text selection fix)
- `ui/hooks/*.ts` - React hooks (approval, file mention, git status, etc.)

### 6. Wire Protocol & Events

**File**: `wire/index.ts`

JSON-RPC protocol for streaming events between soul and UI:

```typescript
type WireMessage =
  | { type: "start", agent: {...} }
  | { type: "message_start", role: "user" | "assistant", ... }
  | { type: "content_block_delta", index: number, delta: {...} }
  | { type: "tool_use", tool_name: string, tool_input: {...} }
  | { type: "tool_result", tool_name: string, result: string }
  | { type: "approval_request", ... }
  | { type: "message_stop", ... }
  | { type: "error", ... }
```

UIs consume these events via websocket or stdio stream.

**Key Files**:
- `wire/index.ts` - Wire message types & transport
- `wire/transport.ts` - JSON-RPC serialization

### 7. Sub-agents

**File**: `soul/agent.ts` (LaborMarket), `tools/agent/agent.ts` (Agent tool)

Sub-agents are persistent workers (created once, resumed by ID):

```typescript
const agent = await KimiCLI.create({
  agent: "explorer",  // Sub-agent spec
  agent_id: "..."     // Resume if exists
});
```

Instances are stored in `~/.kimi/sessions/{SESSION_ID}/subagents/{agent_id}/`:
- `metadata.json` - Instance info
- `context.jsonl` - Conversation history
- `logs.jsonl` - Wire events

**Key Files**:
- `soul/agent.ts` - `LaborMarket` builtin type registry
- `tools/agent/` - Agent tool (create/resume)
- `subagents/store.ts` - Sub-agent persistence

## Key Patterns

### 1. Tool Implementation

```typescript
import { CallableTool } from "@/tools/types";
import { z } from "zod";

export class MyTool extends CallableTool<MyParams> {
  name = "my_tool";
  description = "Does something";

  params = z.object({
    input: z.string().describe("Input text"),
  });

  async call(params: MyParams, context: ToolContext): Promise<string> {
    // context.sessionId, context.workDir, context.config, context.llm, etc.
    return "result";
  }
}
```

### 2. React Component (TUI)

```typescript
import { Box, Text } from "ink";

export function MyComponent({ data }: MyComponentProps) {
  // Pure component — no useInput, no hooks except custom
  return (
    <Box>
      <Text>{data}</Text>
    </Box>
  );
}
```

### 3. Agent Spec (YAML)

```yaml
# src/kimi_cli_ts/agents/default.yaml
name: "default"
extends: "base"

system_prompt: |
  You are Kimi, a helpful AI assistant.

tools:
  - module: tools.file.read
  - module: tools.shell
  - module: tools.web.fetch

subagents:
  explorer:
    extends: default
    system_prompt: "You explore codebases..."
```

## Configuration

### User Config (`~/.kimi/config.toml`)

```toml
[model]
provider = "anthropic"  # anthropic, openai, google
model = "claude-3-5-sonnet-20241022"

[auth]
anthropic_api_key = "sk-..."
openai_api_key = "sk-..."

[ui]
theme = "auto"
editor = "vim"

[mcp]
enabled = true
```

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `KIMI_LOG_LEVEL` | `info` | Logging level (debug, info, warn, error) |
| `KIMI_WORK_DIR` | CWD | Working directory for tools |
| `KIMI_SESSION_ID` | (auto) | Session ID (MD5 of workdir) |

## Logging & Debugging

**File**: `utils/logging.ts`

All logs written to disk via log4js. **Never use `process.stderr` for debug output in interactive (TUI) mode** — always use the disk logger.

### Log Location

Logs are written to **`~/.kimi/sessions/{SESSION_ID}/logs.log`** (log4js file appender):

```
[2026-04-04 12:00:00.000] [INFO] Turn completed
[2026-04-04 12:00:01.000] [ERROR] Tool failed: connection timeout
```

- Max file size: 5MB with 1 backup rotation
- Controlled via `KIMI_LOG_LEVEL` env var (debug/info/warn/error)
- Buffered before session dir is set, flushed when `setLogDir()` is called

### Usage

```typescript
import { logger } from "../utils/logging.ts";

logger.debug("Detailed trace info", someVar);
logger.info("Normal operation info");
logger.warn("Something unexpected");
logger.error("Something failed", err.message);
```

### Debugging TUI

To debug the interactive Shell TUI:

1. Open a screen session with two windows
2. In window 1, run: `bun run start` (launches TUI)
3. In window 2, tail the log: `tail -f ~/.kimi/sessions/<SESSION_ID>/logs.log`
4. Set `KIMI_LOG_LEVEL=debug` for verbose output: `KIMI_LOG_LEVEL=debug bun run start`

Renderer debug log is at `renderer-debug.log` in CWD (separate from the main log).

### stderr/stdout Rules

- **Interactive mode (TUI)**: Never use `process.stderr` or `process.stdout` directly for diagnostics. Use the disk `logger` from `utils/logging.ts`.
- **Print mode** (`--print`): `process.stdout` is for LLM text output, `process.stderr` is for user-visible diagnostics (tool calls, errors, notifications). This is the CLI output contract — do not change it.
- **Renderer**: `ui/renderer/index.ts` wraps `process.stdout.write` to intercept Ink's screen clearing. This is infrastructure, not logging.

## Building & Running

### Development

```bash
# Start interactive shell TUI
bun run src/kimi_cli_ts/index.ts

# Type checking
bun run check  # or: tsc --noEmit

# Linting/formatting
bun run format  # Biome
bun run lint    # Biome check
```

### Production Binary

```bash
# Compile to native binary
bun build --compile --outfile ./dist/kimi

# Binary size: ~80-100 MB (includes Bun + dependencies)
```

## Conventions

### Code Style

- **TypeScript**: Strict mode (`strict: true`)
- **Line length**: 100 characters (match Python side)
- **Linter**: Biome (replaces ESLint/Prettier)
- **Module imports**: `@/` alias for `src/kimi_cli_ts/`

### File Naming

- **Components**: PascalCase, `.tsx` (e.g., `Shell.tsx`)
- **Functions/utilities**: camelCase, `.ts` (e.g., `logging.ts`)
- **Types**: PascalCase, exported from `types.ts`
- **Tests**: `*.test.ts` in same dir

### Async Patterns

```typescript
// Async tool execution (fire-and-forget with approval)
await toolset.run(toolCall, {
  approval: approvalRuntime,  // Optional approval
  timeout: 30000,             // 30s timeout
});

// Streaming LLM response
for await (const event of llm.stream(messages, tools)) {
  // Process event
}
```

## Common Tasks

### Add a New Tool

1. Create `tools/my_tool/index.ts`
2. Extend `CallableTool<MyParams>`
3. Define `params` (Zod schema)
4. Implement `call(params, context)`
5. Register in `tools/registry.ts`

### Add a UI Component

1. Create `ui/components/MyComponent.tsx`
2. Use React + Ink (no `useInput`)
3. Receive all data via props
4. Integrate in `Shell.tsx`

### Add a Slash Command

1. Create `ui/shell/commands/my_command.ts`
2. Export `class MyCommand extends SlashCommand`
3. Register in `ui/shell/slash.ts`

## Important Notes

1. **No `useInput` in components**: Keyboard handling is centralized in `useShellInput()` hook.
2. **Pure components**: `PromptView`, panels, menus are pure (props-only, no hooks except custom).
3. **Ink stdout wrapper**: `renderer/index.ts` intercepts Ink's screen clearing to preserve text selection.
4. **Tool approval**: All tool calls can be intercepted by `ApprovalRuntime` before execution.
5. **Persistent sessions**: Sessions persist under `~/.kimi/sessions/`, indexed by workdir + session ID.
6. **JSONL everywhere**: Wire events, logs, context are stored as JSONL for streaming & replay.

## References

- **Python Side**: `/Users/yuan/git/kimi-cli/AGENTS.md` (architecture parallels)
- **UI Details**: `ui/CLAUDE.md` (rendering & input architecture)
- **Biome Config**: `.biomeignore`, `.biomerc.json` (linting rules)
- **TypeScript Config**: `tsconfig.json` (compiler settings)

debug时需要使用本地磁盘log 不要污染stderr