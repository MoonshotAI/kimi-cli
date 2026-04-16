# Python 参考调研 — Slice 6.1 Notification Task Integration

## 1. 范围和目标

本切片涉及背景任务（background task）完成后的三个核心用例：

1. **Background task reconcile 后自动发通知** — 当后台任务进入终止状态（completed/failed/killed/lost/timed_out）时，BackgroundTaskManager 发出结构化 NotificationEvent
2. **LLM 通知消息中附加 task output tail** — 构建发送给 LLM 的通知消息时，附加该任务的输出尾部（最后 N 行/M 字符）
3. **hasPendingForLlm() + auto-follow-up 触发** — Shell UI 通过检查是否存在未被 LLM 消费的待处理通知，在 resume 后自动触发 follow-up 转轮（with graceful deferral）

---

## 2. Python 侧组件地图（file:line 锚）

### A. 核心通知发送流程

**File: `/Users/moonshot/Developer/kimi-cli/src/kimi_cli/background/manager.py`**

| 位置 | 组件 | 职责 |
|------|------|------|
| 460–532 行 | `BackgroundTaskManager.reconcile()` + `publish_terminal_notifications()` | 遍历所有 terminal status 任务，为每一个生成并发布 NotificationEvent |
| 504–526 行 | NotificationEvent 构造 | 关键字段：`id`、`category="task"`、`type=f"task.{terminal_reason}"`、`source_kind="background_task"`、`source_id=view.spec.id`、`dedupe_key=f"background_task:{view.spec.id}:{terminal_reason}"` |
| 471–490 行 | 状态→severity 映射 | completed→success, timed_out/failed→error, killed/lost→warning |
| 492–522 行 | body 构造 | Task ID、Status、Description、Exit Code、Failure Reason |
| 524 行 | 去重 | 同一任务的同一终止原因最多发一个通知 |

**File: `/Users/moonshot/Developer/kimi-cli/src/kimi_cli/notifications/manager.py`**

| 位置 | 组件 | 职责 |
|------|------|------|
| 41–48 行 | `NotificationManager.publish()` + dedupe | 如果 `dedupe_key` 匹配已存在通知，返回既有 id；否则创建新的 |
| 32–33 行 | `_initial_delivery()` | 为 NotificationEvent 的每个 target sink（llm/wire/shell）初始化 DeliveryState |
| 67–73 行 | `has_pending_for_sink()` | 检查某个 sink（如 "llm"）是否有 pending 通知 |

**File: `/Users/moonshot/Developer/kimi-cli/src/kimi_cli/notifications/models.py`**

| 位置 | 组件 | 定义 |
|------|------|------|
| 14–29 行 | `NotificationEvent` | category, type, source_kind, source_id, title, body, severity, created_at, payload, targets, dedupe_key |
| 32–37 行 | `NotificationSinkState` | status, claimed_at, acked_at |
| 40–43 行 | `NotificationDelivery` | 维护每个 sink 的 delivery state |

---

### B. LLM 通知消息渲染与 Output Tail

**File: `/Users/moonshot/Developer/kimi-cli/src/kimi_cli/notifications/llm.py`**

| 位置 | 组件 | 职责 |
|------|------|------|
| 19–57 行 | `build_notification_message(view, runtime)` | 构建发送给 LLM 的合成 user 消息，包含 XML 包装 + output tail |
| 31–54 行 | task-specific tail 逻辑 | 仅当 `category == "task"` 且 `source_kind == "background_task"` 时，调用 `runtime.background_tasks.tail_output()` 获取 tail，附加到 body 中 |
| 34–38 行 | tail 参数 | `max_bytes=runtime.config.background.notification_tail_chars`（default 3000）、`max_lines=runtime.config.background.notification_tail_lines`（default 20） |
| 40–54 行 | XML 包装结构 | `<notification id="..." ...>` + Title/Severity + body + `<task-notification>` block（包含 Task ID、Type、Description、Status、Exit Code、Failure Reason、Output Tail） + `</notification>` |
| 60–70 行 | `extract_notification_ids()` | 从历史消息中抽取所有 `<notification id="...">` 标签，用于识别哪些通知已被 LLM 消费 |
| 73–77 行 | `is_notification_message()` | 判断消息是否为注入的通知（通过 `lstrip().startswith("<notification ")` 检测） |

**File: `/Users/moonshot/Developer/kimi-cli/src/kimi_cli/background/manager.py`**

| 位置 | 组件 | 职责 |
|------|------|------|
| 300–312 行 | `BackgroundTaskManager.tail_output()` | 从 task output file 读取最后 N 行/M 字符，返回纯文本（无 XML 包装） |

**File: `/Users/moonshot/Developer/kimi-cli/src/kimi_cli/config.py`**

| 位置 | 组件 | 配置 |
|------|------|------|
| 92–108 行 | `BackgroundConfig` | notification_tail_lines (default 20), notification_tail_chars (default 3000) |
| 111–114 行 | `NotificationConfig` | claim_stale_after_ms (recovery 相关，default 15000) |

---

### C. Has Pending + Auto-Follow-Up 触发逻辑

**File: `/Users/moonshot/Developer/kimi-cli/src/kimi_cli/ui/shell/__init__.py`**

| 位置 | 组件 | 职责 |
|------|------|------|
| 78–166 行 | `_BackgroundCompletionWatcher` | 监听后台任务完成 + pending llm notifications，判断是否应该触发 auto-follow-up |
| 113–166 行 | `wait_for_next()` | 等待用户输入或后台完成，优先级：user input > bg completion with pending llm notif |
| 156–165 行 | `_has_pending_llm_notifications()` | 调用 `self._notifications.has_pending_for_sink("llm")` |
| 120–130 行 | Resume 后预先存在通知的处理 | 如果会话启动时已有 pending，不立即自动触发，等待用户首次输入"armed"后再启用 auto-follow-up |
| 469–471 行 | `_can_auto_trigger_pending()` 回调 | 由 `background_autotrigger_armed` 标志控制，仅在用户送出一个 soul 命令后才为 true |
| 495–532 行 | background auto-trigger 主循环 | 检查 deferred_bg_trigger、是否应该 defer（pending user input + grace period）、timeout、最后发送 system-reminder |
| 949–967 行 | `_should_defer_background_auto_trigger()` + `_background_auto_trigger_timeout_s()` | 在 grace period 内有用户输入活动时 defer（默认 0.75s），或用户有 pending input 时 defer |

**File: `/Users/moonshot/Developer/kimi-cli/src/kimi_cli/notifications/manager.py`**

| 位置 | 组件 | 职责 |
|------|------|------|
| 67–73 行 | `has_pending_for_sink()` | **核心查询：遍历所有通知，检查目标 sink 是否有 status=="pending" 的投递** |

---

## 3. 关键设计决策

### 3.1 Dedupe 策略

- **Key**: `f"background_task:{task_id}:{terminal_reason}"`
- **含义**: 同一任务的同一终止原因（completed/failed/timed_out/killed/lost）产生的通知只发一次
- **实现**: `NotificationManager.publish()` 的 dedupe_key 查询 + 返回既有 id（Slice 2.4 Q8 决策）

### 3.2 Notification Targets（多 Sink 投递）

Python 默认配置：`targets = ["llm", "wire", "shell"]`

- **llm**: 合成 user 消息发给 LLM（通过 `TurnManager.pendingNotifications` 队列）
- **wire**: 实时广播到 web/vis UI（通过 SessionEventBus）
- **shell**: TUI toast（通过 NotificationWatcher）

Slice 2.4 在 TS 中改为 push-only；Python 为 pull-based（claim/ack 流程）。

### 3.3 LLM Tail Output 附加条件

仅在以下条件同时满足时附加：
1. `category == "task"` 且 `source_kind == "background_task"`
2. `task_view` 存在且可读
3. tail 非空

参数限制：
- `max_lines`: 20（可配置）
- `max_bytes`: 3000（可配置）

**原因**: LLM context 保护 + 输出过长时的内容截断

### 3.4 Auto-Follow-Up 的 Grace Period + Armed Flag

```
Timeline:
1. Session 启动 → background_autotrigger_armed = False
2. 用户送出第一个 soul 命令（或 slash 命令）→ armed = True
3. 此后 bg completion + pending llm notif → 自动触发（无 defer）
4. 在 grace period（0.75s）内用户有输入活动 → defer bg trigger
5. Timeout 或 grace period 过期 → 检查是否需要 defer，否则触发
```

**设计目标**: 避免"resume 后立即冲出一个 bg auto-trigger"（confusing UX），但仍允许真正的 task completion 驱动 follow-up。

### 3.5 Resume 的特殊处理

Python 在 reconcile 时检查磁盘中的任务状态：
- `running` → `lost`（主进程死亡）
- 同时发送通知给 llm/wire/shell

TS 的 loadFromDisk() + reconcile() 流程完全对应。

---

## 4. 已知陷阱和历史 Bug

1. **M1 race fix (in-flight dedupe)**: TS 在 NotificationManager 中实现了 in-flight 去重（Python 没有此需求因为 publish 是同步的），防止并发 emit 同一 dedupe_key 时多次 WAL append。

2. **resume 时 pending notifications 不应立即触发 auto-follow-up**: Python Shell._BackgroundCompletionWatcher 有复杂的 grace period + armed flag 逻辑来避免这一点。

3. **Tail output 长度限制必须严格**: `notification_tail_chars=3000` 默认值是在不超过 context 的情况下给足信息的折衷。

4. **Terminal status 的正确判定**: 必须检查 `is_terminal_status(view.runtime.status)` 而非直接查看 status 值，因为 timed_out 实际上是 failed + timed_out flag 的组合。

---

## 5. Python vs TS 当前实现分歧

| 特性 | Python | TS | 分歧类型 |
|------|--------|----|---------| 
| **Task completion notification** | ✅ BackgroundTaskManager.publish_terminal_notifications() | ❌ 未实现 | **需实现** |
| **Dedupe strategy** | `dedupe_key` on publish | TS NotificationManager 有 dedupe，但 BackgroundProcessManager 无 | **需接入** |
| **Output tail in LLM message** | ✅ `build_notification_message()` 动态查询 + 附加 | ❌ 未实现 | **需实现** |
| **Tail params** | `notification_tail_lines/chars` from config | ✅ 配置框架存在 | **需配置获取** |
| **has_pending_for_sink("llm")** | ✅ NotificationManager.has_pending_for_sink() | ✅ NotificationManager.replayPendingForResume() 存在，但无 live query | **需补充** |
| **Auto-follow-up trigger** | ✅ Shell._BackgroundCompletionWatcher (with armed flag + grace period) | ❌ 未实现 | **需实现** |
| **Resume pending re-inject** | Python pull-based (claim/ack) | ✅ TS replayPendingForResume() + ephemeral injection | **架构不同但结果一致** |

---

## 6. TS 借鉴清单（直接搬 / 调整 / 废弃）

### 直接搬（语义等价）
- [ ] **BackgroundTaskManager.reconcile() → BackgroundProcessManager.reconcile()** 
  - Python: 遍历所有 terminal tasks，调用 publish_terminal_notifications()
  - TS: 已有 reconcile()，返回 lost tasks；需添加**通知发送逻辑**
  
- [ ] **Dedupe key 格式**: `background_task:{task_id}:{terminal_reason}`
  - TS 在 BackgroundProcessManager._publishTerminalNotification() 中使用
  
- [ ] **Severity 映射**:
  ```python
  completed → "success"
  timed_out → "error"
  failed → "error"
  killed → "warning"
  lost → "warning"
  ```

- [ ] **Notification body 结构**: 包含 Task ID, Status, Description, Exit Code, Failure Reason

### 调整（架构或语言差异）
- [ ] **Output tail 读取**: TS 无文件 I/O，改为调用 `BackgroundProcessManager.getOutput()`
  
- [ ] **Notification.targets 默认**: TS Slice 2.4 改为 push-only，不使用 Python 的 claim/ack 机制；但仍保持 ["llm", "wire", "shell"] 数组概念

- [ ] **tail 配置获取**: TS 需通过配置框架获取 `notification_tail_lines` / `notification_tail_chars`（可能需添加到 SessionConfig）

- [ ] **Resume pending inject**: TS 已有 replayPendingForResume() + ephemeral 框架，无需 claim/ack pull 模型

### 废弃
- [ ] **NotificationManager.claim_for_sink() / ack() 流程**: TS push-only，无此概念
- [ ] **NotificationWatcher polling loop**: TS 由 SessionManager / TurnManager 主动 drain

---

## 7. 给 test-migrator 的测试用例启发

### Unit Tests

```python
# 1. Reconcile + publish_terminal_notifications()
def test_background_task_complete_notification():
    # Create task → mark complete → reconcile → check published notifications
    # Assert: NotificationEvent.type == "task.completed", severity == "success"

def test_dedupe_same_terminal_reason():
    # Publish notification, call reconcile again → should return same id (dedupe)
    # Assert: notification.event.id unchanged, deduped == True

def test_lost_task_on_resume():
    # Save running task to disk → load → reconcile
    # Assert: status changed to "lost", notification published

# 2. Output tail in LLM message
def test_build_notification_message_with_output():
    # Create task with output → build_notification_message()
    # Assert: XML body contains "<task-notification>" + output tail

def test_tail_respects_line_limit():
    # Create task with 100 lines of output, max_lines=20
    # Assert: tail is exactly last 20 lines

def test_tail_respects_byte_limit():
    # Create task with 10000-byte output, max_bytes=3000
    # Assert: tail is truncated to ≤ 3000 bytes

# 3. has_pending_for_sink()
def test_has_pending_for_llm():
    # Publish notification with targets=["llm"] → has_pending_for_sink("llm") == True
    # ack() → has_pending_for_sink("llm") == False

# 4. Auto-follow-up
def test_auto_trigger_after_armed():
    # Shell not armed initially
    # User sends command → armed = True
    # bg task completes → auto-trigger should fire

def test_auto_trigger_deferred_during_grace():
    # bg task completes while user typing (within 0.75s)
    # Assert: trigger deferred until grace period expires

def test_no_auto_trigger_on_resume_without_user_input():
    # Resume with pending notifications
    # Assert: no auto-trigger until user sends first command
```

### Integration Tests

```python
# 1. Full reconcile → notification flow
def test_reconcile_publishes_all_terminal_notifications():
    # Create 5 tasks in various terminal states
    # reconcile() → should publish 5 notifications with correct severity/type

# 2. Resume + replay + auto-trigger
def test_resume_injects_pending_notifications():
    # Save session with pending llm notification
    # Resume → check that notification injected as pending_notification
    # User sends command → armed = True → auto-trigger fires
```

---

## 8. 给 implementer 的坑位清单（bullet + 优先级）

### P0 （Must Have）

- [ ] **BackgroundProcessManager 与 NotificationManager 的耦合**
  - 坑：reconcile() 返回 lost tasks，但不发通知
  - 解决：在 reconcile() 完成后，调用 `_publishTerminalNotifications()` 方法
  - 位置：`packages/kimi-core/src/tools/background/manager.ts` 的 reconcile() 之后

- [ ] **Terminal notification 事件结构**
  - 坑：source_kind 必须是 "background_task"，否则 build_notification_message() 不会附加 tail
  - 解决：hardcode `source_kind = "background_task"`；type 为 `task.${terminal_reason}`
  - 参考：Python manager.py:507

- [ ] **Output tail 的同步获取**
  - 坑：Python tail_output() 从文件读；TS 无文件，需从内存 ring buffer 获取
  - 解决：调用 BackgroundProcessManager.getOutput(taskId, tail_lines)
  - 参考：Python manager.py:300–312

- [ ] **Notification targets 数组处理**
  - 坑：TS NotificationManager.emit() 需要 targets 数组；BackgroundProcessManager 需提供
  - 解决：hardcode `targets = ['llm', 'wire', 'shell']` 或从配置读取
  - 参考：TS notification-manager.ts:231

### P1 （Should Have）

- [ ] **Tail 配置的获取**
  - 坑：`notification_tail_lines` / `notification_tail_chars` 不在当前 config schema
  - 解决：添加到 SessionConfig 或 BackgroundConfig（需与 Python 同步）
  - 参考：Python config.py:97–98

- [ ] **hasHasPendingForLlm() 查询方法**
  - 坑：Shell 需检查是否有 pending llm notification
  - 解决：在 NotificationManager 中添加 `hasPendingForLlm(): boolean` 方法
  - 原型：
    ```typescript
    hasPendingForLlm(): boolean {
      for (const [_, injection] of this.injections) {
        if (injection.kind === 'pending_notification' && !injection.delivered) {
          return true;
        }
      }
      return false;
    }
    ```
  - 参考：Python manager.py:67–73

- [ ] **Resume 时的待处理通知重新注入**
  - 坑：replayPendingForResume() 已存在，但 Shell 需要在启动时调用并检查
  - 解决：SessionManager 在 replay 完毕后，调用 manager.replayPendingForResume(records, deliveredIds)
  - 参考：TS notification-manager.ts:363–381

### P2 （Nice to Have）

- [ ] **Auto-follow-up 触发逻辑**
  - 坑：Shell 尚无 _BackgroundCompletionWatcher 类似物
  - 解决：实现 background auto-trigger 事件循环（较复杂，跨多个文件）
  - 参考：Python shell/__init__.py:78–166

- [ ] **Grace period 去抖**
  - 坑：用户正在输入时不应触发 bg auto-trigger
  - 解决：监听 prompt 活动，记录最后输入时间，计算 defer 超时
  - 参考：Python shell/__init__.py:949–999

- [ ] **Dedupe 指标与监控**
  - 坑：多次 reconcile 应用 dedupe，避免重复通知爆炸
  - 解决：添加测试覆盖 dedupe 路径，确保返回既有 id
  - 参考：TS notification-manager.ts:189–221（in-flight dedupe 已实现）

### P3 （Future / Out of Scope）

- [ ] **Server-side shell hook execution**
  - 坑：Python 有 shell 目标投递；TS Slice 2.4 未实现
  - 决策：消费者（SDK/TUI）注入 onShellDeliver 回调，或默认 skip
  - 参考：TS notification-manager.ts:287–300

- [ ] **Per-sink 重试 / recovery**
  - 坑：Python 有 claim/ack 和 recover 流程；TS 改为 push-only
  - 决策：这是 Slice 2.4 vs Python pull 模型的架构差异，暂不调整
  - 参考：TS notification-manager.ts:JSDoc L20–30

---

## 9. 疑问和未决问题

### Q1: BackgroundProcessManager 中应该是否保留 task output？

**当前状态**: TS ring buffer 限制为 1 MiB；Python 从文件读取。

**问题**: 如果内存受限，tail output 是否应该持久化？

**建议决策**: 保持内存 ring buffer（与 Slice 3.5 一致），同时在 BackgroundProcessManager 中添加 `persisted` 字段标记，这样 reconcile-lost 时可知是否有完整 output。

### Q2: Notification tail 中是否应该包含 ANSI escape codes？

**当前状态**: Python 直接附加原始 stdout/stderr（可能含 ANSI codes）。

**问题**: LLM 通常不理解 ANSI codes；web UI 需要 HTML 转义。

**建议决策**: 在 getOutput() 时 strip ANSI codes，或在 build_notification_message 时做后处理（需小心避免误删用户数据）。

### Q3: Grace period 的精确时长？

**当前状态**: Python hardcodes `_BG_AUTO_TRIGGER_INPUT_GRACE_S = 0.75`。

**问题**: 0.75s 是否应该可配置？

**建议决策**: 暂不可配置（保留默认值），如果 UX 反馈需要调整再改。

### Q4: `has_pending_for_sink("llm")` 是否应该是 NotificationManager 还是 SessionManager 的方法？

**当前状态**: Python 在 NotificationManager 中；TS 尚无等价物。

**问题**: TS NotificationManager 是否应该了解 pending 队列的概念？

**建议决策**: 在 NotificationManager 中添加，因为它已经持有 journal records；或在 TurnManager 中添加（更高层）。

---

## 10. 配置文件示例（可参考）

```python
# kimi-core config (TS 应映射)
[background]
max_running_tasks = 4
notification_tail_lines = 20
notification_tail_chars = 3000
wait_poll_interval_ms = 500
worker_heartbeat_interval_ms = 5000
worker_stale_after_ms = 15000
kill_grace_period_ms = 2000
agent_task_timeout_s = 900

[notification]
claim_stale_after_ms = 15000
```

---

## 11. 参考文档

- Python manager.py: 背景任务生命周期 + 通知发布
- Python notifications/llm.py: XML 消息构造 + tail 附加
- Python shell/__init__.py: auto-trigger 控制流
- TS notification-manager.ts: Slice 2.4 架构决策
- TS turn-manager.ts: pending notifications 队列 + draining

---

**最后编辑**: 2026-04-16
**调研者**: Claude Code
**覆盖范围**: 完整（Slice 6.1 的三个核心用例均已深入）

