# Tech Spec: `/loop` Recurring Prompt Scheduler

## 1. Overview

`/loop` is a user-facing slash command that schedules an arbitrary prompt (or another slash command) to execute on a recurring interval within a coding agent.

**Key properties:**
- Default interval: `10m`
- Minimum granularity: 1 minute (cron-based)
- Max concurrent jobs: 50
- Auto-expiry: 7 days for recurring tasks
- Supports both session-only (in-memory) and durable (disk-persisted) tasks

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        USER LAYER                                │
│  /loop 5m check the deploy                                      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     SKILL LAYER (Prompt)                         │
│  Parses [interval] <prompt> from raw args                       │
│  Generates system prompt instructing LLM to call CronCreate     │
│  Tells LLM to execute the prompt immediately after scheduling   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      TOOL LAYER                                  │
│  Schema: { cron, prompt, recurring?, durable? }                 │
│  Validates cron expression                                      │
│  Enforces MAX_JOBS limit                                        │
│  Writes to session store OR disk (e.g. .agent/scheduled.json)   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     STORAGE LAYER                                │
│  In-memory session tasks (durable: false)                       │
│  File-backed tasks (durable: true)                              │
│  Jittered next-fire computation (herd avoidance)                │
│  Task aging / expiry logic                                      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    SCHEDULER LAYER                               │
│  1-second polling loop                                          │
│  Per-project file lock (prevents double-fire across sessions)   │
│  Fires prompts into agent when due                              │
│  Handles missed one-shot tasks at startup                       │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Data Structures

### 3.1 Task

```
Task {
  id: string           // 8-char hex, e.g. "a3f7b2d1"
  cron: string         // 5-field cron expression in local time
  prompt: string       // The prompt to enqueue on fire
  createdAt: number    // Epoch ms
  lastFiredAt?: number // Epoch ms, persisted for recurring tasks
  recurring?: boolean  // True = reschedule after fire
  permanent?: boolean  // True = exempt from auto-expiry (system use only)
  durable?: boolean    // Runtime flag: false = session-only
  agentId?: string     // Runtime flag: route to specific subagent
}
```

### 3.2 Cron Jitter Config

Tunable parameters for load spreading:

```
CronJitterConfig {
  recurringFrac: number      // Forward delay as fraction of interval (default: 0.1)
  recurringCapMs: number     // Max forward delay (default: 15 min)
  oneShotMaxMs: number       // Max early lead for one-shots (default: 90s)
  oneShotFloorMs: number     // Min early lead (default: 0)
  oneShotMinuteMod: number   // Which minute boundaries get jitter (default: 30)
  recurringMaxAgeMs: number  // Auto-expiry for recurring tasks (default: 7 days)
}
```

### 3.3 Tool Input / Output

**Create Input:**
```
{ cron: string, prompt: string, recurring?: boolean, durable?: boolean }
```

**Create Output:**
```
{ id: string, humanSchedule: string, recurring: boolean, durable?: boolean }
```

---

## 4. Data Flow

### 4.1 Command Parsing (Skill Layer)

The skill receives raw args as a string and must parse `[interval] <prompt>`.

**Priority order:**
1. **Leading token**: `^\d+[smhd]$` → interval, rest is prompt
2. **Trailing "every" clause**: `... every 5 minutes` → extract interval
3. **Default**: interval = `10m`, entire input = prompt

**Interval → Cron mapping:**
| Input | Cron | Notes |
|-------|------|-------|
| `Nm` (N ≤ 59) | `*/N * * * *` | Every N minutes |
| `Nm` (N ≥ 60) | `0 */H * * *` | Round to hours, must divide 24 |
| `Nh` (N ≤ 23) | `0 */N * * *` | Every N hours |
| `Nd` | `0 0 */N * *` | Every N days at midnight local |
| `Ns` | `ceil(N/60)m` | Seconds rounded up to minutes |

If interval doesn't divide evenly (e.g. `7m`), round to nearest clean interval and **tell the user** before scheduling.

### 4.2 LLM Tool Invocation

The generated prompt instructs the LLM to:
1. Call the scheduling tool with the parsed `cron`, `prompt`, and `recurring: true`
2. Confirm scheduling details to the user (interval, cron expression, 7-day expiry)
3. **Immediately execute the prompt now** — don't wait for first cron tick

### 4.3 Task Creation (Tool Layer)

```
addCronTask(cron, prompt, recurring, durable, agentId?)
```

- Generate short ID: `randomUUID().slice(0, 8)`
- `durable: false` → store in session memory (dies with process)
- `durable: true` → append to disk file (e.g. `.agent/scheduled.json`)
- Flip scheduler enable flag to start the poll loop

### 4.4 Scheduler Tick

Every 1 second:
1. Load file-backed tasks (if lock owner) + session tasks from memory
2. For each task, compute `nextFireAt` (with jitter)
3. If `now >= nextFireAt`:
   - Fire: enqueue prompt into agent's message queue
   - Recurring: reschedule from `now`, persist `lastFiredAt`
   - One-shot / aged-out: remove from store/file
4. Evict stale `nextFireAt` entries for deleted tasks

---

## 5. Algorithms

### 5.1 Jitter Computation

**Recurring tasks:**
```
t1 = nextCronRunMs(cron, fromMs)
t2 = nextCronRunMs(cron, t1)
if t2 is null: return t1
jitter = min(frac(taskId) * recurringFrac * (t2 - t1), recurringCapMs)
return t1 + jitter
```

Where `frac(taskId)` is a stable hash of the task ID into `[0, 1)`.

**One-shot tasks:**
```
t1 = nextCronRunMs(cron, fromMs)
if minute(t1) % oneShotMinuteMod != 0: return t1
lead = oneShotFloorMs + frac(taskId) * (oneShotMaxMs - oneShotFloorMs)
return max(t1 - lead, fromMs)
```

### 5.2 Scheduler Lock

To prevent double-firing when multiple agent sessions share a workspace:

1. On scheduler start, attempt to acquire a per-directory lock file
2. If acquired, process file-backed tasks
3. If not acquired, start a probe timer (e.g. every 5s) to take over if owner dies
4. Session-only tasks skip locking — they're process-private

### 5.3 Missed Task Detection

On initial load (startup), check for tasks whose next scheduled run from `createdAt` is in the past:

```
missed = tasks.filter(t => nextCronRunMs(t.cron, t.createdAt) < now)
```

For one-shot missed tasks: surface to user with confirmation before running, then delete. Recurring missed tasks are handled normally by the scheduler (fires on first tick, reschedules forward).

### 5.4 Task Aging

```
isAged = recurring && !permanent && (now - createdAt >= recurringMaxAgeMs)
```

Aged recurring tasks fire one final time, then are deleted.

---

## 6. Key Design Decisions

### 6.1 Skill-as-Prompt Pattern
`/loop` is **not** imperative code that calls the scheduler directly. It is a declarative prompt skill that tells the LLM how to parse input and which tool to invoke. This keeps the command layer thin and lets the model handle edge cases (e.g. "every 5 minutes" natural language).

### 6.2 Two-Tier Storage
- **Session-only**: Fast, no disk I/O, dies with process. Good for "check this every 5 min while I'm here."
- **Durable**: Survives restarts via disk file. Good for "remind me every morning."

The tool decides durability; the scheduler transparently merges both sources.

### 6.3 Jitter for Load Spreading
Deterministic per-task jitter prevents thundering herds when many users schedule the same round time (e.g. `0 9 * * *`):
- **Recurring**: forward delay proportional to interval, capped
- **One-shot**: backward lead (fire early) only on round-minute boundaries

Jitter config should be tunable at runtime so ops can adjust fleet-wide without restarting clients.

### 6.4 Immediate Execution
The skill explicitly tells the LLM to run the prompt **now** after scheduling. This gives the user immediate feedback and validates the command works before it recurs.

### 6.5 Auto-Expiry
Recurring tasks auto-delete after 7 days. This caps session lifetime and prevents unbounded resource leaks. The task fires one final time, then is removed. System tasks can be marked `permanent` to exempt them.

### 6.6 Empty Prompt Guard
If parsing yields an empty prompt (e.g. user typed `/loop 5m` with no command), show usage help and **do not call the scheduling tool**.

---

## 7. Interfaces

### 7.1 Skill Definition

```
Skill {
  name: "loop"
  description: "Run a prompt on a recurring interval"
  userInvocable: true
  isEnabled: () => boolean       // Feature gate
  getPromptForCommand: (args: string) => PromptBlock[]
}
```

### 7.2 Scheduling Tool

```
Tool {
  name: "CronCreate"
  inputSchema: { cron: string, prompt: string, recurring?: boolean, durable?: boolean }
  outputSchema: { id: string, humanSchedule: string, recurring: boolean, durable?: boolean }

  validateInput(input):
    - cron must be valid 5-field expression
    - cron must match at least one date in next year
    - total jobs must be < MAX_JOBS
    - durable tasks not allowed for subagent contexts

  call(input):
    - compute effectiveDurable = durable && isDurableEnabled()
    - id = addCronTask(cron, prompt, recurring, effectiveDurable)
    - setSchedulerEnabled(true)
    - return { id, humanSchedule, recurring, durable: effectiveDurable }
}
```

### 7.3 Scheduler

```
Scheduler {
  start(): void
  stop(): void
  getNextFireTime(): number | null   // Epoch ms of soonest pending task
}

createScheduler(options: {
  onFire: (prompt: string) => void
  isLoading: () => boolean
  assistantMode?: boolean
  onFireTask?: (task: Task) => void
  onMissed?: (tasks: Task[]) => void
  dir?: string                      // Explicit task dir for daemon/SDK mode
  lockIdentity?: string             // Stable per-process UUID
  getJitterConfig?: () => CronJitterConfig
  isKilled?: () => boolean          // Runtime kill-switch
  filter?: (task: Task) => boolean  // Per-task visibility gate
}): Scheduler
```

---

## 8. Critical Edge Cases

| Scenario | Behavior |
|----------|----------|
| Empty prompt | Show usage, do not schedule |
| Invalid cron | Reject with clear error message |
| Max jobs exceeded | Reject, tell user to cancel one first |
| Task created inside jitter window | Clamp fire time to `>= createdAt` |
| Process restart | Reconstruct `nextFireAt` from `lastFiredAt ?? createdAt`, not `now` |
| Missed one-shots at startup | Surface to user with confirmation, then delete |
| Double-fire during async delete | Track `inFlight` task IDs, skip if already firing |
| Aged recurring task | Fire one last time, then delete (don't silently drop) |
| Multiple sessions same workspace | Per-directory lock prevents double-firing file tasks |
| Non-owner session | Probe lock periodically (e.g. 5s) to take over if owner dies |
| Durable + teammate context | Reject — teammates don't persist across sessions |

---

## 9. Feature Flags

| Flag | Scope | Purpose |
|------|-------|---------|
| `AGENT_TRIGGERS` | Build | Compile the loop skill and cron tooling |
| `tengu_kairos_cron` | Runtime | Fleet-wide kill-switch for scheduling |
| `tengu_kairos_cron_durable` | Runtime | Force session-only even if user requests durable |
| `DISABLE_CRON` | Env | Local user override to disable cron entirely |

---

## 10. Extension Points

- **Custom intervals**: Add `w` (weeks), `M` (months) to the parser → map to cron
- **Max jobs**: Single constant, easy to tune
- **Expiry**: `recurringMaxAgeMs` in jitter config
- **Subagent routing**: The `agentId` field routes fires to a specific subagent's queue
- **Daemon/SDK mode**: Pass explicit `dir` and `lockIdentity` to scheduler for headless operation
