# Slice 5.3 — Subagent Runtime Design Brief

**Gate 1 decisions**: D1=B (foreground+background), D2=B (YAML allowed/exclude_tools), D3=A (full scope)

---

## 1. Scope (D3=A)

| Task | Description | Est. lines |
|------|------------|-----------|
| T4.1 | `runSubagentTurn` callback — child Soul creation + turn loop | ~200 |
| T4.2 | SubagentStore persistence + SubagentEvent bubbling | ~180 |
| T4.3 | AgentTool integration (output format, background dispatch) | ~80 |
| T4.4 | Recovery — stale foreground cleanup on resume | ~60 |
| T3.3 | AgentTypeRegistry + YAML loader — agent definitions + tool subset resolution | ~260 |
| Tests | Unit + integration | ~450 |
| **Total** | | **~1230** |

---

## 2. Architecture Overview

```
AgentTool.execute()
  │
  ├── SubagentHost.spawn()  [SoulRegistry]
  │     │
  │     ├── SubagentStore.createInstance()  — persist meta.json
  │     │
  │     ├── runSubagentTurn(request, signal)
  │     │     │
  │     │     ├── AgentTypeRegistry.resolve(agentName) → tool list + system prompt
  │     │     ├── create child ContextState + SessionJournal (in subagents/<id>/)
  │     │     ├── create child TurnManager + SoulConfig (filtered tools)
  │     │     ├── runSoulTurn(input, config, runtime, sink, signal)
  │     │     ├── bubble SubagentEvents to parent sink
  │     │     └── return AgentResult { result, usage }
  │     │
  │     └── SubagentStore.updateInstance(status)
  │
  ├── Foreground: await handle.completion → ToolResult
  └── Background: register as BackgroundTask → immediate return
```

---

## 3. New Files

### 3.1 `src/soul-plus/subagent-store.ts` (~120 lines)

Persistence layer for subagent instances. Python parity with `SubagentStore`.

```typescript
interface SubagentInstanceRecord {
  agent_id: string;
  subagent_type: string;
  status: SubagentStatus;
  description: string;
  parent_tool_call_id: string;
  created_at: number;
  updated_at: number;
}

class SubagentStore {
  constructor(sessionDir: string);

  // FS layout: <sessionDir>/subagents/<agent_id>/
  //   meta.json      — SubagentInstanceRecord
  //   wire.jsonl     — child wire events
  //   context.jsonl  — child conversation context (reserved, not wired in 5.3)

  createInstance(opts: CreateInstanceOpts): Promise<SubagentInstanceRecord>;
  getInstance(agentId: string): Promise<SubagentInstanceRecord | null>;
  updateInstance(agentId: string, patch: Partial<Pick<SubagentInstanceRecord, 'status' | 'description'>>): Promise<SubagentInstanceRecord>;
  listInstances(): Promise<SubagentInstanceRecord[]>;
}
```

**Design decisions**:
- Atomic write (tmp+rename) for meta.json, matching StateCache pattern from Slice 5.1
- No per-session write mutex needed — each subagent has its own directory
- `context.jsonl` file is created but **not wired** in 5.3 (child context restoration requires Context layer changes beyond scope; the child gets a fresh ContextState each run, same as Python's first-run path)

### 3.2 `src/soul-plus/agent-type-registry.ts` (~160 lines)

YAML agent definition loader and tool subset resolver (D2=B).

```typescript
/** Parsed from a single agent YAML file */
interface AgentTypeDefinition {
  name: string;
  description: string;
  whenToUse: string;
  systemPromptSuffix: string;      // ROLE_ADDITIONAL from YAML
  allowedTools: string[] | null;    // null = inherit parent tools
  excludeTools: string[];
  defaultModel: string | null;
}

/** Mirrors Python ResolvedAgentSpec from agentspec.py */
interface ResolvedAgentSpec {
  name: string;
  systemPromptPath: string;
  systemPromptArgs: Record<string, string>;
  model: string | null;
  whenToUse: string;
  tools: string[];
  allowedTools: string[] | null;
  excludeTools: string[];
  subagents: Record<string, { path: string; description: string }>;
}

class AgentTypeRegistry {
  register(name: string, def: AgentTypeDefinition): void;
  resolve(name: string): AgentTypeDefinition;  // throws if unknown
  list(): AgentTypeDefinition[];
  resolveToolSet(name: string, parentTools: readonly Tool[]): Tool[];
}
```

**Tool subset resolution** (Python parity from `agent.py:457-460`):
```
resolveToolSet(name, parentTools):
  def = resolve(name)
  if def.allowedTools != null:
    base = parentTools.filter(t => def.allowedTools.includes(t.name))
  else:
    base = [...parentTools]
  return base.filter(t => !def.excludeTools.includes(t.name))
```

### 3.2.1 `src/soul-plus/agent-yaml-loader.ts` (~100 lines)

YAML file parser for agent definitions. Python parity with `agentspec.py`.

**Dependency**: `js-yaml` (add to `packages/kimi-core/package.json`)

```typescript
/**
 * Load and resolve a single agent YAML file.
 * Handles `extend:` inheritance chain (Python parity: agentspec.py:_load_agent_spec).
 */
function loadAgentSpec(agentFilePath: string): Promise<ResolvedAgentSpec>;

/**
 * Given the parent agent.yaml, discover and register all subagent types.
 * Python parity: agent.py:421-442 (labor_market registration loop).
 */
function loadSubagentTypes(parentAgentYaml: string): Promise<AgentTypeDefinition[]>;
```

**YAML structure** (Python parity from `agents/default/`):
```yaml
version: 1
agent:
  extend: ./agent.yaml           # optional base
  system_prompt_args:
    ROLE_ADDITIONAL: "..."
  when_to_use: "..."
  allowed_tools: [...]           # whitelist (null = inherit)
  exclude_tools: [...]           # blacklist
  subagents:                     # only on parent
    coder:
      path: ./coder.yaml
      description: "..."
```

**Inheritance resolution** (Python parity from `agentspec.py:111-159`):
1. If `extend` field present → load base YAML recursively
2. Merge: child fields override base (non-Inherit fields win)
3. `allowed_tools: Inherit` → default to `null` (inherit parent tools)
4. `exclude_tools: Inherit` → default to `[]`

**Tool name mapping**: Python YAML uses module paths (`kimi_cli.tools.shell:Shell`), TS uses class names (`Bash`). The loader includes a mapping table:
```typescript
const PYTHON_TO_TS_TOOL_NAME: Record<string, string> = {
  'kimi_cli.tools.shell:Shell': 'Bash',
  'kimi_cli.tools.file:ReadFile': 'Read',
  'kimi_cli.tools.file:WriteFile': 'Write',
  'kimi_cli.tools.file:StrReplaceFile': 'Edit',
  'kimi_cli.tools.file:Glob': 'Glob',
  'kimi_cli.tools.file:Grep': 'Grep',
  'kimi_cli.tools.agent:Agent': 'Agent',
  'kimi_cli.tools.ask_user:AskUserQuestion': 'AskUserQuestion',
  'kimi_cli.tools.web:SearchWeb': 'SearchWeb',
  'kimi_cli.tools.web:FetchURL': 'FetchURL',
  'kimi_cli.tools.todo:SetTodoList': 'SetTodoList',
  'kimi_cli.tools.background:TaskList': 'TaskList',
  'kimi_cli.tools.background:TaskOutput': 'TaskOutput',
  'kimi_cli.tools.background:TaskStop': 'TaskStop',
  'kimi_cli.tools.plan:ExitPlanMode': 'ExitPlanMode',
  'kimi_cli.tools.plan.enter:EnterPlanMode': 'EnterPlanMode',
  // ReadMediaFile → mapped to Read (TS uses same tool)
  'kimi_cli.tools.file:ReadMediaFile': 'Read',
};
```

**YAML file location**: Ship Python's `agents/default/*.yaml` files into `packages/kimi-core/agents/default/`. The loader resolves relative `extend` / subagent `path` references relative to the YAML file's directory (Python parity).

**Built-in types loaded from YAML**:
- `coder.yaml` — full read/write tools, no Agent/AskUserQuestion
- `explore.yaml` — read-only tools (no Write/Edit)
- `plan.yaml` — read-only, no Shell

### 3.3 `src/soul-plus/subagent-runner.ts` (~200 lines)

Core `runSubagentTurn` implementation wired into `SoulRegistry.runSubagentTurn` callback.

```typescript
interface SubagentRunnerDeps {
  store: SubagentStore;
  typeRegistry: AgentTypeRegistry;
  parentTools: readonly Tool[];
  parentRuntime: Runtime;
  parentSink: EventSink;
  parentJournal: SessionJournal;
  sessionDir: string;
}

async function runSubagentTurn(
  deps: SubagentRunnerDeps,
  request: SpawnRequest,
  signal: AbortSignal,
): Promise<AgentResult>;
```

**Turn execution flow**:
1. `typeRegistry.resolve(request.agentName)` → get type definition
2. `store.createInstance(...)` → persist initial meta.json with status='created'
3. Create child infrastructure:
   - Child `SessionJournal` writing to `subagents/<id>/wire.jsonl`
   - Child `FullContextState` (fresh, with subagent system prompt suffix)
   - Filtered tool set via `typeRegistry.resolveToolSet(name, parentTools)` — **excludes AgentTool** from child (no recursive spawn)
   - Child `Runtime` (reuses parent's kosong + compactionProvider)
4. `store.updateInstance(agentId, { status: 'running' })`
5. `runSoulTurn(input, soulConfig, runtime, childSink, signal)`
   - `childSink` wraps events as `SubagentEventRecord` and forwards to `parentSink`
6. Extract final assistant message text as result
7. `store.updateInstance(agentId, { status: 'completed' })` (or 'failed' on error, 'killed' on abort)
8. Return `{ result, usage }`

**Event bubbling** (Python parity from `runner.py:400-423`):
- Child events are wrapped in `SubagentEventRecord` with `parent_tool_call_id` + `agent_id`
- Written to **both** child wire.jsonl (raw) and parent wire (wrapped)
- Approval requests are NOT forwarded in 5.3 (subagents auto-approve or deny; full approval forwarding is 5.x)

**Summary continuation**: NOT implemented in 5.3. Python's `run_with_summary_continuation` re-runs the soul if output < 200 chars. This is an optimization that can come later — the core loop works without it.

### 3.4 Modified Files

#### `src/soul-plus/soul-registry.ts`
- `SoulRegistryDeps.runSubagentTurn` already exists as an optional callback slot
- No structural changes — just needs a real implementation wired in

#### `src/soul-plus/soul-plus.ts`
- Construct `SubagentStore`, `AgentTypeRegistry`, `SubagentRunner`
- Wire `runSubagentTurn` callback into `SoulRegistry`
- Wire `AgentTool` into the tool set with `SoulRegistry` as `SubagentHost`
- Add `cleanupStaleSubagents()` method (T4.4)

#### `src/tools/agent.ts`
- **Background dispatch** (D1=B): when `runInBackground`, register as `BackgroundProcessManager` task instead of fire-and-forget
- **Output format**: match Python's structured output:
  ```
  agent_id: <id>
  resumed: false
  actual_subagent_type: <type>
  status: completed

  [summary]
  <response text>
  ```
- **Background output**:
  ```
  task_id: <bg_xxx>
  status: running
  agent_id: <id>
  automatic_notification: true
  ```

#### `src/tools/index.ts`
- Export `AgentTypeRegistry` + `SubagentStore`

---

## 4. Background Subagent (D1=B)

Python dispatches background subagents as `asyncio.Task` via `BackgroundTaskManager`.
TS parity: use existing `BackgroundProcessManager` from Slice 5.2.

**Flow**:
1. `AgentTool.execute()` with `runInBackground=true`
2. `SubagentHost.spawn()` creates the handle
3. Instead of `await handle.completion`, register the completion promise as a background task:
   ```typescript
   bgManager.register({
     description: args.description,
     process: handle.completion,  // Promise<AgentResult>
     agentId: handle.agentId,
   });
   ```
4. Return immediately with task_id + agent_id
5. On completion, `BackgroundProcessManager` emits notification (existing infrastructure from Slice 5.2)

**Key constraint**: Background subagent must NOT be linked to parent's AbortSignal (Python parity: child outlives parent abort). SoulRegistry already handles this — `parentSignal` is only wired for foreground.

---

## 5. Recovery (T4.4)

### 5.1 `cleanupStaleSubagents(sessionDir: string)`

Called during session resume (bootstrap path in `apps/kimi-cli/src/index.ts`).

```typescript
async function cleanupStaleSubagents(store: SubagentStore): Promise<string[]> {
  const instances = await store.listInstances();
  const stale = instances.filter(r => r.status === 'running');
  for (const record of stale) {
    await store.updateInstance(record.agent_id, { status: 'failed' });
  }
  return stale.map(r => r.agent_id);
}
```

Python parity: `_cleanup_stale_foreground_subagents()` marks `running_foreground` → `failed`. TS simplification: our `SubagentStatus` uses `'running'` (no foreground/background split in status), so we mark all `'running'` as `'failed'`.

Background reconcile: already handled by `BackgroundProcessManager.reconcile()` from Slice 5.2. Subagent background tasks registered there will be reconciled by the existing mechanism.

---

## 6. What's NOT in Scope

| Item | Reason |
|------|--------|
| Summary continuation | Optimization; core loop works without |
| Context.jsonl resume | Requires ContextState serialization changes; child gets fresh context each run |
| Approval forwarding to parent | Subagents auto-approve in 5.3; full forwarding is 5.x |
| Recursive spawn (subagent spawning subagent) | AgentTool excluded from child tool set |
| Hook engine propagation to subagent | Hooks not yet implemented (Slice 5.5) |
| Git context injection for explore | Python-specific; can add in 5.x |

---

## 7. Test Plan

### Unit tests (~300 lines)

1. **SubagentStore** (`test/soul-plus/subagent-store.test.ts`):
   - createInstance → writes meta.json + creates directory structure
   - getInstance → reads back correctly
   - updateInstance → patches status/description, bumps updated_at
   - listInstances → returns all, sorted by updated_at desc
   - listInstances → returns empty for nonexistent subagents dir
   - atomic write (no partial meta.json on crash)

2. **AgentTypeRegistry** (`test/soul-plus/agent-type-registry.test.ts`):
   - register + resolve round-trip
   - resolve unknown name → throws
   - resolveToolSet with allowedTools → filters to whitelist
   - resolveToolSet with excludeTools → removes blacklisted
   - resolveToolSet with both → whitelist then blacklist
   - list() returns all registered types

2b. **AgentYamlLoader** (`test/soul-plus/agent-yaml-loader.test.ts`):
   - Load parent agent.yaml → resolves tools, subagents
   - Load child with `extend:` → inherits base, overrides fields
   - allowed_tools/exclude_tools parsing
   - Python→TS tool name mapping
   - loadSubagentTypes → returns 3 built-in types (coder/explore/plan)
   - Invalid YAML → throws meaningful error

3. **SubagentRunner** (`test/soul-plus/subagent-runner.test.ts`):
   - Foreground happy path: creates instance, runs turn, returns result, updates status to completed
   - Foreground error: soul turn throws → status updated to failed, AgentResult is error
   - Foreground abort: signal aborted → status updated to killed
   - Event bubbling: child events wrapped as SubagentEventRecord on parent sink
   - Tool filtering: child does not receive AgentTool

4. **AgentTool background** (`test/tools/agent-background.test.ts`):
   - Background happy path: returns task_id immediately, completion notifies
   - Background without BackgroundProcessManager: returns error

5. **Recovery** (`test/soul-plus/subagent-recovery.test.ts`):
   - cleanupStaleSubagents marks running→failed
   - Already-completed instances untouched

### Integration test (~100 lines)

6. **Full foreground flow** (`test/e2e/subagent-foreground.test.ts`):
   - Wire up AgentTool → SoulRegistry → SubagentRunner with echo provider
   - Parent turn invokes Agent tool → child runs → parent receives result
   - Verify both parent and child wire.jsonl contain expected records

---

## 8. Implementation Order

```
Phase A: Foundation
  1. Add js-yaml dependency
  2. SubagentStore (persistence)
  3. AgentYamlLoader (YAML parsing + inheritance + tool name mapping)
  4. AgentTypeRegistry (type definitions + tool resolution, uses loader)
  5. Copy Python YAML files to packages/kimi-core/agents/default/

Phase B: Core runtime
  6. SubagentRunner (runSubagentTurn callback)
  7. Wire into SoulPlus constructor (registry, loader, tools)

Phase C: Integration
  8. AgentTool background dispatch (D1=B)
  9. AgentTool output format (Python parity)
  10. Recovery (cleanupStaleSubagents)
  11. Bootstrap wiring in kimi-cli/src/index.ts

Phase D: Tests
  12. Unit tests (Phases A-C)
  13. Integration test
```

---

## 9. Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Child Soul needs Runtime but we don't want full Runtime cloning | Reuse parent's `kosong` + `compactionProvider`; child gets its own journal + context |
| Tool name mismatch between YAML (Python module path) and TS (class name) | YAML loader includes `PYTHON_TO_TS_TOOL_NAME` mapping table; unmapped names logged as warning and skipped |
| Child EventSink type may not match parent | Child sink is a thin adapter that wraps events and forwards |
| Background task registration API mismatch | BackgroundProcessManager already accepts Promise-based tasks (Slice 5.2) |
