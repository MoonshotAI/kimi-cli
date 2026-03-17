# 后台任务实现说明

这份文档是给后续开发者快速理解当前 background task / notification 实现用的内部说明，不是用户文档。

## 一句话结论

当前实现已经把“后台执行”和“通知投递”拆成两层独立能力：

- `Shell(run_in_background=true)` 只负责发起后台 bash 任务
- `TaskList` / `TaskOutput` / `TaskStop` 提供最小 task 控制面
- `BackgroundTaskManager` 负责 task 生命周期、恢复和终态通知生产
- `NotificationManager` 负责持久化、claim / ack、去重和多 sink 投递
- task completion 只是 notification 基建里的一个 producer，不再是 `dynamic injection` 的特例

另外，当前 V1 有几个硬边界：

- 只有 `root agent` 可以创建和管理后台任务
- 只有本地 session (`local kaos`) 支持后台任务
- CLI 退出时默认会杀掉仍在运行的后台任务，除非 `background.keep_alive_on_exit=true`
- human shell 的任务管理入口只有 `/task`，不是 `/task list` / `/task output` / `/task stop`

## 运行时总览

### Runtime 装配

`Runtime.create()` 会同时构造：

- `NotificationManager(session_dir/notifications, config.notifications)`
- `BackgroundTaskManager(session, config.background, notifications=...)`

`KimiCLI.create()` 在 runtime 建好之后会立刻做两件事：

1. `runtime.notifications.recover()`
2. `runtime.background_tasks.reconcile()`

也就是说，启动时就会先把 stale notification claim 复原，并把 stale task 修正为终态后补发通知。

### subagent 边界

fixed / dynamic subagent 会共享同一套 notification store 和 task store，但拿到的是 `copy_for_role(...)` 后的 manager：

- `BackgroundTaskManager.create_bash_task()` / `kill()` 会强制 `owner_role == "root"`
- `TaskList` / `TaskOutput` / `TaskStop` tool 也会在运行时拒绝非 root agent

因此“共享 store”不等于“subagent 可操作后台任务”。

## 当前 task 模型与生命周期

### Task 数据模型

核心模型在 `src/kimi_cli/background/models.py`：

- `TaskSpec`
  - `id`, `kind`, `session_id`, `description`, `tool_call_id`, `owner_role`
  - bash V1 额外记录 `command`, `shell_name`, `shell_path`, `cwd`, `timeout_s`
- `TaskRuntime`
  - `status`
  - `worker_pid`, `child_pid`, `child_pgid`
  - `started_at`, `heartbeat_at`, `updated_at`, `finished_at`
  - `exit_code`, `interrupted`, `timed_out`, `failure_reason`
- `TaskControl`
  - `kill_requested_at`, `kill_reason`, `force`
- `TaskConsumerState`
  - `last_seen_output_size`, `last_viewed_at`

终态集合是：

- `completed`
- `failed`
- `killed`
- `lost`

注意：

- “超时”不会变成独立 `TaskStatus`
- 当前 runtime 里仍然是 `status="failed" + timed_out=true`
- 真正的“终态原因”要看 `timed_out` 和 `status` 组合

### task 目录

task 持久化目录仍然是：

```text
<session_dir>/tasks/<task_id>/
  spec.json
  runtime.json
  control.json
  consumer.json
  output.log
```

其中：

- `consumer.json` 现在只服务 `TaskOutput`
- notification 的投递状态已经完全搬出 task 目录

### Shell 后台启动

`Shell` 新增两个参数：

- `run_in_background: bool = false`
- `description: str = ""`

并且：

- `run_in_background=true` 时必须提供非空 `description`
- `timeout` 上限已经从 `300` 提升到 `86400`

当模型调用 `Shell(run_in_background=true)` 时，实际流程是：

1. 正常走审批
2. `BackgroundTaskManager.create_bash_task(...)` 创建 task 目录和初始状态
3. 启动 detached worker 进程
4. 立即返回 `task_id`
5. 返回结果里显式提示：
   - `automatic_notification: true`
   - 完成后会自动通知
   - 需要看进度或阻塞等待时用 `TaskOutput`
   - 需要取消时才用 `TaskStop`
   - human shell 只该被告知 `/task`

### detached worker

后台 worker 不是线程，也不是 in-process task，而是隐藏 CLI 子命令：

- `kimi_cli.cli:__background-task-worker`

worker 行为在 `src/kimi_cli/background/worker.py`：

1. 把 runtime 状态更新为 `starting`
2. 用干净环境启动真实 shell 子进程
3. `stdout` / `stderr` 直接追加写入 `output.log`
4. 并发跑 heartbeat loop 和 control loop
5. 根据退出结果写回终态

状态流转大致是：

- `created -> starting -> running -> completed`
- `created -> starting -> running -> failed`
- `created -> starting -> running -> killed`
- `created|starting|running -> lost`（恢复逻辑补写）

超时路径是：

- worker 先发终止信号
- 超过 grace period 再强杀
- 最终写成 `status="failed"`, `interrupted=true`, `timed_out=true`

### 管理器恢复与退出

`BackgroundTaskManager.recover()` 会扫描非终态 task：

- heartbeat 超时的 task 标记为 `lost`
- 如果 `control.kill_requested_at` 已存在，则优先修正成 `killed`

`BackgroundTaskManager.reconcile()` 只是：

1. `recover()`
2. `publish_terminal_notifications()`

CLI 退出时：

- 默认调用 `KimiCLI.shutdown_background_tasks()`
- `kill_all_active(reason="CLI session ended")`
- 但 `Reload` 和 `SwitchToWeb` 会保留后台任务
- 如果 `background.keep_alive_on_exit=true`，也不会自动 kill

## 工具契约

### 1. `TaskList`

参数：

- `active_only: bool = true`
- `limit: int = 20`

语义：

- 只做枚举，不改状态
- 默认只看非终态 task
- 在 plan mode 下可用
- 典型用途是 compaction 后重新获取外部真相源

底层实际走的是：

- `list_task_views(manager, active_only=..., limit=...)`

### 2. `TaskOutput`

参数：

- `task_id`
- `block: bool = true`
- `timeout: int = 30`

真实语义不是“流式读 offset”，而是“一次性返回结构化元数据 + 固定大小预览”：

- `block=true`
  - 等待终态或超时
  - `retrieval_status` 是 `success` 或 `timeout`
- `block=false`
  - 立即返回当前状态
  - 若 task 还没结束，`retrieval_status` 是 `not_ready`

返回内容至少包括：

- `retrieval_status`
- `task_id`, `kind`, `status`, `description`, `command`
- `interrupted`, `timed_out`, `terminal_reason`
- `exit_code`, `reason`
- `output_path`
- `output_size_bytes`
- `output_preview_bytes`
- `output_truncated`
- `full_output_available`
- `full_output_tool: ReadFile`
- `full_output_hint`
- `[output]` 预览正文

几个关键细节：

- 预览最多读最近 `32 KiB`
- 预览是 tail，不是从头开始
- 被截断时会明确给 `ReadFile(path=..., line_offset=1, n_lines=300)` 的分页提示
- 每次调用会回写 `consumer.json` 的 `last_seen_output_size` / `last_viewed_at`

### 3. `TaskStop`

参数：

- `task_id`
- `reason`

语义：

- generic stop capability，不是 bash 私有 kill API
- 会走审批
- plan mode 下不可用
- 若 task 已经终态，只返回当前状态，不重复改写

## Notification 基建

### 设计边界

notification 现在被定义成：

- 持久化的系统事件
- producer 无关
- sink 无关
- 支持去重、claim / ack、恢复和多 sink 投递

对应模块：

- `src/kimi_cli/notifications/models.py`
- `src/kimi_cli/notifications/store.py`
- `src/kimi_cli/notifications/manager.py`
- `src/kimi_cli/notifications/llm.py`
- `src/kimi_cli/notifications/wire.py`
- `src/kimi_cli/notifications/notifier.py`

### Notification 数据模型

核心 envelope：

- `id`
- `category`
- `type`
- `source_kind`
- `source_id`
- `title`
- `body`
- `severity`
- `created_at`
- `payload`
- `targets`
- `dedupe_key`

当前默认 sink：

- `llm`
- `wire`
- `shell`

每个 sink 单独跟踪 delivery 状态：

- `pending`
- `claimed`
- `acked`

### notification 目录

notification 单独落盘：

```text
<session_dir>/notifications/<notification_id>/
  event.json
  delivery.json
```

这样 background task 之外的 producer 以后也能直接复用。

### claim / ack / recover 语义

`NotificationManager` 的关键行为是：

- `publish(event)`
  - 如果 `dedupe_key` 已存在，直接返回已有 notification
- `claim_for_sink(sink, limit)`
  - 按创建时间 FIFO claim
- `ack(sink, notification_id)`
  - 只 ack 当前 sink，不影响其它 sink
- `recover()`
  - stale 的 `claimed` sink 会回退成 `pending`
- `deliver_pending(...)`
  - 共用 `before_claim -> claim -> handler -> ack` 这条流水线
  - 如果 handler 抛错，notification 会停留在 `claimed`，等待后续 `recover()`

## background task 作为 notification producer

### 终态通知类型

`BackgroundTaskManager.publish_terminal_notifications()` 负责扫描终态 task，并发布：

- `task.completed`
- `task.failed`
- `task.timed_out`
- `task.killed`
- `task.lost`

注意这里和 runtime status 的关系：

- `task.timed_out` 对应的 task runtime 仍然是 `status="failed"`
- notification 层额外把 `terminal_reason` 抽成了 `timed_out`

### source / payload / dedupe

task notification 的固定元信息：

- `category = "task"`
- `source_kind = "background_task"`
- `source_id = <task_id>`

payload 至少包含：

- `task_id`
- `task_kind`
- `status`
- `description`
- `exit_code`
- `interrupted`
- `timed_out`
- `terminal_reason`
- `failure_reason`

去重键不是 `<status>`，而是 `<terminal_reason>`：

```text
background_task:<task_id>:<terminal_reason>
```

这保证了：

- 同一个完成态不会重复发
- `failed` 和 `timed_out` 可以区分
- `recover()` 补发的 `task.lost` 不会和其他终态冲突

## 各 sink 的真实行为

### LLM sink

background notification 已经不再走 `DynamicInjectionProvider`。

`KimiSoul._step()` 在 root agent 下会：

1. `deliver_pending("llm", before_claim=background_tasks.reconcile, limit=4)`
2. 把每个 notification 转成独立 `<notification ...>` message
3. append 到 context
4. append 成功后 ack `llm`

task 类 notification 在 `build_notification_message()` 中还会额外补一段 `<task-notification>`：

- `Task ID`
- `Task Type`
- `Description`
- `Status`
- `Exit code`
- `Failure reason`
- `Output tail`

tail 长度同时受两组配置约束：

- `background.notification_tail_lines`
- `background.notification_tail_chars`

另外还有两个实现细节很重要：

- `KimiSoul.__init__()` 会从已有 history 里提取 `<notification id="...">`，并对这些 ID 执行 `ack_ids("llm", ...)`，避免重启后重复注入
- `normalize_history()` 明确不会把 notification message 和普通 user message 合并

所以 notification 现在的 LLM 语义是：

- 独立消息
- 独立 ack
- 独立恢复

而不是“step 前临时塞一段 reminder 文本”。

### wire sink

notification 已经进入通用 wire 协议层：

- `src/kimi_cli/wire/types.py` 新增 `Notification` event

字段包括：

- `id`
- `category`
- `type`
- `source_kind`
- `source_id`
- `title`
- `body`
- `severity`
- `created_at`
- `payload`

`run_soul()` 会额外启动一个后台 pump：

1. 每秒执行一次 `_deliver_notifications_to_wire_once()`
2. `deliver_pending("wire", before_claim=background_tasks.reconcile, limit=8)`
3. 转成 wire `Notification`
4. 发给当前 wire
5. ack `wire`

并且 turn 结束前还会再 flush 一次，确保“刚好在 turn 结束前发布”的 notification 不丢。

当前几个主要 consumer 的行为是：

- shell live view
  - 把它当成独立 notification block 渲染
  - live 区最多只显示最近 4 条
  - step cleanup 时会把所有积压 notification 全部刷到终端历史
- print `stream-json`
  - 输出为独立 JSON event
  - 不会和 assistant message / tool result 混在一起
- ACP
  - 目前会降级成文本块
  - 形态是 `[Notification] <title>\n<body>`

### shell sink

interactive shell 在 idle 状态没有活跃的 `run_soul()` turn，所以仍然需要本地 watcher：

- `NotificationWatcher(sink="shell")`

它每秒做一次：

1. `before_poll = background_tasks.reconcile`
2. claim `shell`
3. 调用 toast handler
4. ack `shell`

当前 shell toast 文案是：

```text
[<notification.event.type>] <notification.event.title>
```

持续 10 秒。

## compaction 与活跃 task 恢复

仅靠 conversation history 不能保证 compaction 后模型还知道哪些 task 仍在跑。

因此 `compact_context()` 完成后，root agent 会：

1. 重新读取当前非终态 task
2. 生成 `<active-background-tasks>` 快照
3. 以独立 user message 追加到 compacted history 后面

这个快照来自：

- `build_active_task_snapshot()`

内容只保留高价值摘要：

- `task_id`
- `kind`
- `status`
- `description`

不再把完整 command 也塞回去，避免 compaction 后无谓涨 token。

## shell `/task` 浏览器

当前 human shell 的任务管理 UI 不是一组 slash 子命令，而是一个交互式 browser：

- 唯一入口：`/task`
- 传参数会直接报 usage
- 非 root agent 会被拒绝

`TaskBrowserApp` 的真实行为：

- 全屏 TUI
- 默认展示当前 session 的全部 task
- `Tab` 在 `all` / `active` 之间切换
- `R` 手动刷新
- 也会每秒自动刷新
- `Enter` 或 `O` 打开当前 task 的完整输出 pager
- `S` 发起 stop 请求
- `Y` / `N` 确认或取消 stop
- `Q` / `Esc` / `Ctrl-C` 退出

浏览器内部还有几个实现细节值得知道：

- 左侧列表排序
  - 活跃 task 按创建顺序稳定展示
  - 终态 task 按完成时间倒序
- 右上 detail 面板显示 task 元数据
- 右下 preview 只展示最近 6 行 / 4 KiB
- pager 里的 full output 会展示最近一大段 tail
  - 上限约为 `max(background.read_max_bytes * 10, 200000 bytes)`
  - 行数上限 `4000`

所以 `/task` 的定位是“给人类 shell 用户看的本地浏览器”，不是给模型调用的控制协议。

## 当前关键配置项

默认配置定义在 `src/kimi_cli/config.py`：

- `background.max_running_tasks = 4`
- `background.read_max_bytes = 30000`
- `background.notification_tail_lines = 20`
- `background.notification_tail_chars = 3000`
- `background.wait_poll_interval_ms = 500`
- `background.worker_heartbeat_interval_ms = 5000`
- `background.worker_stale_after_ms = 15000`
- `background.kill_grace_period_ms = 2000`
- `background.keep_alive_on_exit = false`
- `notifications.claim_stale_after_ms = 15000`

这些值会同时影响：

- worker 心跳与 kill 行为
- `TaskOutput` / task browser 读取输出时的裁剪策略
- notification recover / 重投时机

## 与旧 dynamic injection 方案的关系

当前已经不再有“background task 专用 dynamic injection provider”。

保留下来的唯一耦合点只有：

- notification message 被写进 context 后
- `normalize_history()` 要把它们当成不可合并的特殊 user message

这说明现在的设计重点已经从“提醒模型有后台任务”转成了“持久化系统事件如何被多个 sink 正确消费”。

## 当前关键模块

| 模块 | 作用 |
|------|------|
| `src/kimi_cli/tools/shell/__init__.py` | `Shell` 前台/后台执行入口 |
| `src/kimi_cli/tools/background/__init__.py` | `TaskList` / `TaskOutput` / `TaskStop` |
| `src/kimi_cli/background/manager.py` | task 创建、恢复、停止、终态通知生产 |
| `src/kimi_cli/background/store.py` | task 持久化 |
| `src/kimi_cli/background/worker.py` | detached worker 实现 |
| `src/kimi_cli/background/summary.py` | task 列表格式化与 compaction 快照 |
| `src/kimi_cli/notifications/manager.py` | notification core：dedupe / claim / ack / recover |
| `src/kimi_cli/notifications/llm.py` | notification -> context message |
| `src/kimi_cli/notifications/wire.py` | notification -> wire event |
| `src/kimi_cli/notifications/notifier.py` | 通用 watcher |
| `src/kimi_cli/soul/kimisoul.py` | `llm` sink 投递与 compaction 后 task snapshot |
| `src/kimi_cli/soul/__init__.py` | `wire` sink pump 与 shutdown flush |
| `src/kimi_cli/ui/shell/__init__.py` | shell idle watcher |
| `src/kimi_cli/ui/shell/task_browser.py` | `/task` 交互式浏览器 |
| `src/kimi_cli/ui/shell/visualize.py` | shell live notification 渲染 |
| `src/kimi_cli/ui/print/visualize.py` | print 模式 notification 输出 |
| `src/kimi_cli/acp/session.py` | ACP notification 文本桥接 |
| `src/kimi_cli/app.py` | startup recover / reconcile 与 exit cleanup |

## 测试关注点

当前实现至少应该持续覆盖以下几类测试：

1. `NotificationManager` 的 dedupe / FIFO claim / ack / stale recover。
2. `BackgroundTaskManager.recover()` 能把 stale task 修成 `lost` 或 `killed`。
3. `publish_terminal_notifications()` 能正确区分 `task.failed` 和 `task.timed_out`。
4. `KimiSoul` 会把 `llm` sink notification 作为独立 `<notification>` message 写入 context。
5. `normalize_history()` 不会把 notification message 合并进普通 user message。
6. wire sink 会发出标准 `Notification` event，并在 turn 结束前做最终 flush。
7. shell idle watcher 会消费 `shell` sink，而不是直接扫 task consumer 状态。
8. `/task` 浏览器的筛选、输出查看、停止确认和自动刷新不回退。
9. CLI 退出时默认会 kill 活跃 task；reload / switch-to-web / keep-alive 配置例外。
10. `TaskList` / `TaskOutput` / `TaskStop` / `Shell(background)` 的 root-only 与 plan-mode 契约不回退。

## 后续最值得做的事

如果继续往前推，优先级最高的是：

1. 给 notification 增加更正式的 backlog / replay 机制，而不只是当前的 claim / ack 恢复。
2. 把 future background agent 直接接进同一套 task + notification 基建。
3. 评估 ACP / IDE 侧是否要消费结构化 notification，而不是继续降级成文本。
4. 评估是否需要“前台任务后台化”能力，而不只是 `Shell(run_in_background=true)` 这种启动时选择。
