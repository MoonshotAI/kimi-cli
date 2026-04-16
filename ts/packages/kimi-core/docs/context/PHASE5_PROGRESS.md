# Phase 5 Progress

**Last updated**: 2026-04-16
**Branch**: `make-it-ts`
**Remote**: gitlab (`ssh://git@dev.msh.team:30022/zhangkaiyi/kimi-cli-ts.git`)

---

## Slice 状态总览

| Slice | 名称 | 状态 | Commits | Tests added |
|-------|------|------|---------|-------------|
| **5.0** | OAuth + env_overrides | ✅ done | `f47c42e9` + `b534e1a2` (Codex fix) | +79 |
| **5.1** | Session 管理核心 | ✅ done | `dc91edf2` | +52 |
| **5.2** | Resume/Continue | ✅ done | `9d5d0abd` | +28 |
| **5.3** | Subagent runtime | ✅ done | `00cf913b` | +52 |
| **5.4** | Runtime switches + EnterPlanMode | ✅ done | `94f81ad3` | +17 |
| **5.5** | Hook + /init | 🟡 Stage 1 starting | — | — |
| 5.6 | Compaction 完成 | pending | — | — |
| 5.7 | 清理 + Full E2E | pending | — | — |

**全套测试**: 1555 passed（kimi-core 单包）
**Typecheck**: kimi-core + kimi-cli 都 clean（kimi-core 有 3 个 pre-existing test errors in migrate/python + background/manager/task-tools）

---

## Slice 5.0 — OAuth + env_overrides ✅

### 交付
- Device Code Flow (RFC 8628) against auth.kimi.com
- FileTokenStorage (`~/.kimi/credentials/<name>.json`, 0600)
- OAuthManager: lazy refresh, in-flight coalesce, 401 race protection
- 15min device-code timeout; slow_down interval accumulation (RFC 8628 §3.5)
- `/logout` slash command; `/login` is guidance stub
- DeviceCodeDialog standalone Ink render
- env_overrides: 7 env vars (KIMI_BASE_URL etc.) applied to **requested** model (not default)
- createProviderFromConfig now async (returns Promise<ChatProvider>)
- bootstrapCoreShell: ensureOAuthIfNeeded pre-flight

### Codex Round 2 findings (applied)
- M5: 401 race → re-read rotated token before delete
- M7: strict response validation (access_token/refresh_token/expires_in required)
- M6: HTTP 30s timeout via AbortSignal.timeout
- M2: env_overrides target = requestedModel
- M3: KIMI_YOLO/defaultYolo → shell initial state

### Known deferred (Phase 5.x backlog)
- M1: per-turn token refresh + 401 retry (long-session)
- M4: moonshot_search/moonshot_fetch real provider
- m1: DeviceAuthorization.expires_in not honored
- m2: KIMI_MODEL_TEMPERATURE/TOP_P/MAX_TOKENS env
- m3: Kimi default headers (User-Agent + X-Msh-*)

---

## Slice 5.1 — Session management core ✅

### 交付
- `renameSession(id, title)` with read-merge-write + per-session write mutex
- `getSessionStatus(id)` from live SessionLifecycleStateMachine or state.json
- `getSessionUsage(id)` streaming wire.jsonl replay + 5s LRU cache + in-flight dedup
- `listSessions` real title + last_activity + sorted by last_activity desc
- SessionState.custom_title field; StateCache atomic write (tmp+rename)
- SessionStatus: idle|active|completing|compacting|destroying|closed
- usage-aggregator: fallback to assistant_message.usage for Python-migrated sessions
- Wire layer: title forwarded (not null), timestamps normalized to unix seconds

### Codex findings (applied)
- C1: usage-aggregator fallback for migrated sessions
- B1: listSessions title/updated_at forwarding
- M1: sort by last_activity desc
- M2: atomic write + per-session mutex
- M6: timestamp unit normalization (1e12 heuristic)

### Deferred
- M3: auto title from first turn
- M4: destroy semantic (keep close-and-detach)
- M5: skip partial state.json

---

## Slice 5.2 — Resume/Continue complete ✅

### 交付
- ReplayProjectedState.planMode from plan_mode_changed wire records
- SessionManager.resumeSession restores planMode to TurnManager
- closeSession persists plan_mode to state.json
- NotificationManager.replayPendingForResume: push-only re-inject
- NotificationManager.extractDeliveredIds (user-role only, Codex M1)
- BackgroundProcessManager: persist (tasks/<id>.json), ghosts, reconcile (mark lost)
- Random hex task IDs (prevent ghost collision)
- Bootstrap: attach/load/reconcile + stderr summary for lost tasks
- schedulePlanModeReminder on resume (D4)
- Fresh --plan activates core TurnManager (Codex C4)
- --continue uses listSessions sort (last_activity, Codex M4)

### Codex findings (applied)
- C2: attach/load/reconcile in production bootstrap
- C4: fresh --plan → wireClient.setPlanMode
- M1: extractDeliveredIds role filter
- M4: --continue sort
- M5: random task ID
- N1: setPlanMode before addSystemReminder

### Deferred
- C1: notification re-injection on consecutive resumes (D1=A limitation)
- C3: reconcile terminal notifications
- M2: /plan immediate state.json write
- M3: DynamicInjectionManager in production

---

## Slice 5.3 — Subagent runtime 🟡 IN PROGRESS

### Stage 1 完成
- Python reference: `docs/context/research/PYTHON_REFERENCE_slice_5_3.md` (432 lines)
- Gate 1 decisions locked:

### Gate 1 Decisions

| # | 决策 | 值 |
|---|------|-----|
| **D1** | 并发模式 | **B: foreground + background** — Python parity |
| **D2** | 工具集 | **B: YAML 定义 `allowed_tools` + `exclude_tools`** — 子 agent 自有工具子集 |
| **D3** | Scope | **A: 全 scope** — T4.1 + T4.2 + T4.3 + T4.4 + T3.3 |

### Python agent YAML 结构（D2 调研结果）

```yaml
# Parent (default/agent.yaml):
agent:
  tools:
    - "kimi_cli.tools.agent:Agent"
    - "kimi_cli.tools.file:ReadFile"
    # ... full list
  subagents:
    coder:
      path: ./coder.yaml
      description: "Good at general software engineering tasks."

# Child (default/coder.yaml):
agent:
  extend: ./agent.yaml
  system_prompt_args:
    ROLE_ADDITIONAL: "You are now running as a subagent..."
  when_to_use: |
    Use this agent for non-trivial software engineering work...
  allowed_tools:
    - "kimi_cli.tools.shell:Shell"
    - "kimi_cli.tools.file:ReadFile"
    # ... subset
  exclude_tools:
    - "kimi_cli.tools.agent:Agent"
    - "kimi_cli.tools.ask_user:AskUserQuestion"
```

### TS 已有基础设施
- `soul-plus/subagent-types.ts` — SpawnRequest, SubagentHandle, SubagentHost interfaces
- `soul-plus/soul-registry.ts` — SoulRegistry with `runSubagentTurn` callback slot
- `tools/agent.ts` — AgentTool (138 lines, spawn logic exists)
- `storage/wire-record.ts` — SubagentEventRecord type exists

### 需要构建（~900 行估计）
1. **`runSubagentTurn` callback** — 核心：创建子 Soul + 子 tool set + 跑 turn + 收集结果 (~200)
2. **Subagent 持久化** — `subagents/<aid>/meta.json` + wire.jsonl (~150)
3. **Event 冒泡** — wrap child SoulEvents with parent_tool_call_id (~80)
4. **Agent tool 进 buildTools** — 注入 SubagentHost (~5)
5. **_cleanup_stale_foreground_subagents** — resume 时 mark running→failed (~40)
6. **Recovery** — replay subagent records on resume (~60)
7. **Background subagent** — async task spawning (D1=B) (~100)
8. **Agent YAML 工具子集解析** — allowed_tools/exclude_tools (D2=B) (~60)
9. **Tests** (~400)

### 下一步
- Stage 2: Design brief（写 SLICE_5_3_BRIEF.md）
- Stage 3: 实现（6-8 子阶段）
- Stage 4-9: review/codex/commit

---

## 工作流规则（Phase 5）

### 9 阶段
1. Python 调研 → `research/PYTHON_REFERENCE_slice_5_X.md`
2. Design brief → `SLICE_5_X_BRIEF.md` → Gate 2 用户 approve "开始写代码"
3. 实现（failing test first）
4. Self-review
5. Claude reviewer agent
6. Fix reviewer findings
7. Codex Round 2 (codex:codex-rescue)
8. Fix Codex findings
9. Commit (用户 approve → 执行)

### Gate 汇报
- Gate 1 (Stage 1): Python 调研 + 语义分歧 → 用户拍板
- Gate 2 (Stage 2): brief → 等 "开始写代码"
- Gate 3-4 (Stage 5/7): **自决不问用户**（reviewer/codex comment 我自行判断修/不修）
- Gate 5 (Stage 9): commit 命令 → 用户 approve

### Commit 流程
- 我写命令 + message → 用户 approve → 我执行
- 绝不 co-author Claude，绝不提 Claude

### Reviewer finding 自决标准
- Blocker/Critical: 必修
- Major: 默认修（成本远超收益除外 → 归档 followup）
- Nit/Minor: 默认不修（顺手 1-2 行除外）

---

## Git 状态

```
latest commits (make-it-ts):
9d5d0abd  feat(slice-5.2): resume/continue complete semantics
1153b495  Merge remote-tracking branch 'gitlab/make-it-ts'
dc91edf2  feat(slice-5.1): session management core
b534e1a2  fix(slice-5.0.1): Codex Round 2 follow-up
f47c42e9  feat(slice-5.0): OAuth device flow + env_overrides
a87e4f6b  fix(kimi-core): wire onThinkDelta through kosong-adapter
e624e2f5  resolve conflicts (merge origin/make-it-ts)
1edb2909  phase4
```

Remote sync: local = gitlab/make-it-ts = `9d5d0abd`

---

## Phase 5.x Backlog (deferred items across slices)

### From Slice 5.0
- Per-turn OAuth token refresh + 401 retry
- moonshot_search/moonshot_fetch real providers
- KIMI_MODEL_TEMPERATURE/TOP_P/MAX_TOKENS env
- Kimi default headers

### From Slice 5.1
- Auto title from first turn
- Destroy semantic naming

### From Slice 5.2
- Notification re-injection on consecutive resumes (D1=A limitation)
- reconcile terminal notifications emission
- /plan immediate state.json write
- DynamicInjectionManager in production SoulPlus

### From Phase 4 Codex reviews
- Full slash command coverage (Python has 20+)
- multi_select QuestionDialog
- Real E2E test (not smoke)
