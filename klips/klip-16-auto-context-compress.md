---
Author: "@codex"
Updated: 2026-03-03
Status: Proposed
---

# KLIP-16: Auto Context Compress (ACC) 模式

## Summary

本提案为 Kimi CLI 增加 `ACC`（Auto Context Compress）模式：

1. 通过 `/acc` 开启/关闭全局模式开关。
2. 在 Shell 输入框底部状态栏显示 `ACC` 标记（带颜色）。
3. 在每次向 LLM 发起 step 请求时，额外追加一段 ACC 提示（包含当前上下文容量信息 + 可主动压缩提醒），并在 ACC 开启时向模型暴露一个“压缩上下文”工具。
4. 压缩工具调用时要求传入“当前任务摘要”，压缩完成后把该摘要追加到压缩后的上下文末尾，帮助模型在新上下文中继续执行。

结论：该需求可实现，且与现有 `KimiSoul`、`SimpleCompaction`、`SlashCommand`、Shell 状态栏机制高度兼容，预计改造风险中等偏低。

## 当前实现调研（已存在能力）

### 1) 上下文容量数据

当前代码已经具备“已用容量 + 上限”：

- `src/kimi_cli/soul/context.py`
  - `Context.token_count`：当前上下文 token 计数（由每次 step usage 更新）。
- `src/kimi_cli/soul/kimisoul.py`
  - `self._runtime.llm.max_context_size`：模型最大上下文容量。
  - `status` 属性已经暴露 `context_tokens` 与 `max_context_tokens`。

可直接得到剩余容量：

```python
used = soul.context.token_count
max_size = soul.runtime.llm.max_context_size
remaining = max(0, max_size - used)
```

同时可计算“安全剩余”（扣除 `reserved_context_size`）：

```python
safe_remaining = max(0, max_size - used - soul.runtime.config.loop_control.reserved_context_size)
```

### 2) 压缩能力

当前压缩链路已经完整：

- 入口：`src/kimi_cli/soul/kimisoul.py::KimiSoul.compact_context(custom_instruction="")`
- 实现：`src/kimi_cli/soul/compaction.py::SimpleCompaction.compact(...)`
- 手动命令：`src/kimi_cli/soul/slash.py::/compact`

现有调用方式（可复用）：

```python
await soul.compact_context(custom_instruction="压缩时重点保留 XXX")
```

## 需求可行性评估

### 需求 1: `/acc` 全局开关

可行。现有 slash 架构支持直接新增 soul-level 命令。

- 文件：`src/kimi_cli/soul/slash.py`
- 推荐行为：
  - `/acc`：toggle
  - `/acc on|off|status`：显式控制/查看状态

“全局”建议定义为“当前 session 全局”（与 yolo 一致，可持久化到 `session.state`）。

### 需求 2: 输入框下方显示 ACC 标记

可行。Shell 底栏已支持 `yolo` 标记，ACC 可复用同一渲染位。

- 文件：`src/kimi_cli/ui/shell/prompt.py::_render_bottom_toolbar`
- 方式：在 `StatusSnapshot` 增加 `acc_enabled`，底栏渲染时插入 colored tag（如 `bold fg:#00d7af`）。

### 需求 3: 每次请求追加 ACC 提示 + 动态工具

可行。

- 请求追加提示位置：`src/kimi_cli/soul/kimisoul.py::_step` 调用 `kosong.step(...)` 之前。
- 工具附加方式：
  - 在 ACC 开启时把压缩工具暴露给模型（可通过 `KimiToolset.hide/unhide` 控制可见性）。
  - 或按 step 构造临时 toolset（实现更复杂，不推荐第一版）。

### 需求 4: 压缩工具参数 `当前任务摘要` 并在压缩后追加

可行，且与现有 compaction 逻辑兼容。

- 改造点：`KimiSoul.compact_context(...)` 增加 `task_summary` 参数。
- 行为：压缩完成并写入新上下文后，再 append 一条系统化摘要消息。

## 推荐设计

### 1) 状态模型

新增 session 级 ACC 状态（建议持久化）：

- `src/kimi_cli/session_state.py`
  - 新增 `acc_enabled: bool = False`（可放在新字段 `agent` 下，或直接顶层字段）。
- `src/kimi_cli/soul/agent.py`
  - `Runtime.create` 读取 session 状态并构造共享 state（参考 `ApprovalState` 模式）。

### 2) `/acc` 命令

新增 soul-level slash 命令：

- `src/kimi_cli/soul/slash.py`
  - 更新开关状态
  - 回显当前状态
  - 发 `StatusUpdate`（如需要 UI 即时刷新）

### 3) Shell UI 标记

- `src/kimi_cli/soul/__init__.py::StatusSnapshot`
  - 增加 `acc_enabled: bool = False`
- `src/kimi_cli/soul/kimisoul.py::status`
  - 填充 `acc_enabled`
- `src/kimi_cli/ui/shell/prompt.py::_render_bottom_toolbar`
  - 显示 `ACC` tag

### 4) 每 step 附加 ACC 提示

在 `_step` 中，当 `acc_enabled` 时构造额外提示消息（不落盘到 context history，仅用于当前请求）：

```python
acc_hint = (
    "ACC mode is enabled.\n"
    f"Context used: {used}/{max_size} tokens.\n"
    f"Remaining: {remaining} tokens. Safe remaining: {safe_remaining} tokens.\n"
    "You may call `AccCompactContext` tool when you judge compaction is beneficial."
)
```

建议提示内容包括：

- `used / max / remaining / safe_remaining`
- 工具名与触发建议
- 明确“由模型自行决策”

### 5) ACC 压缩工具

新增工具（建议名：`AccCompactContext`）：

- 参数：
  - `task_summary: str`（必填）
- 行为：
  - 调用 `await soul.compact_context(custom_instruction=task_summary, task_summary=task_summary)`
  - 返回 `ToolOk(message="Context compacted.")`

该工具建议默认隐藏，ACC 开启时 `unhide`，关闭时 `hide`。

### 6) 压缩后追加“当前任务摘要”

扩展 `compact_context`：

```python
async def compact_context(
    self,
    custom_instruction: str = "",
    task_summary: str = "",
) -> None:
    ...
    await self._context.append_message(compaction_result.messages)
    if task_summary.strip():
        await self._context.append_message(
            Message(role="user", content=[system(
                "Current task summary after compaction:\n" + task_summary.strip()
            )])
        )
```

这样可保证压缩后的第一轮继续推理时，模型拿到明确的“任务 + 进度 + 已做/未做 + next step”锚点。

## 与现有自动压缩策略的关系

当前 `_agent_loop` 中每 step 会执行 `should_auto_compact(...)` 阈值判定。

建议：

- ACC 开启后，以“模型主动压缩”为主。
- 但保留“硬保护阈值”（例如 `token_count + reserved_context_size >= max_context_size`）防止溢出报错。

这样既满足“模型自主决策”，又避免上下文耗尽导致 step 失败。

## 风险与注意事项

1. token 统计并非严格“仅历史消息”，还会受 system prompt / tools schema 影响。
2. 若每 step 附加提示文本过长，会增加输入 token 消耗，应保持短小模板化。
3. 压缩工具属于“会改变上下文”的动作，工具描述中应强调调用时机与参数质量要求。
4. 若 ACC 状态持久化，需要补充状态兼容测试（旧 session 状态文件读取）。

## 测试建议

1. `tests/core/test_kimisoul_slash_commands.py`
   - `/acc` toggle/on/off/status 行为
2. `tests/core/test_session_state.py`
   - ACC 状态序列化/反序列化
3. `tests/ui_and_conv/test_prompt_tips.py`
   - 底栏 ACC tag 渲染
4. `tests/core/test_simple_compaction.py`
   - 压缩后追加 `task_summary` 的上下文结构
5. `tests/core/test_wire_message.py`（如扩展了 `StatusUpdate`）
   - 新字段序列化兼容性

## 实施顺序（建议）

1. 数据结构与状态持久化（SessionState/Runtime/StatusSnapshot）。
2. `/acc` 命令与状态更新。
3. Shell 底栏 ACC 标记。
4. `KimiSoul._step` 注入 ACC 提示。
5. 新增 `AccCompactContext` 工具并实现 hide/unhide。
6. `compact_context` 支持 `task_summary` 追加。
7. 补齐测试与文档（slash command reference）。

