---
Author: "@codex"
Updated: 2026-01-22
Status: Draft
---

# KLIP-13: Compaction 策略化与 Tool Result Hiding

## 背景

不同模型、不同 agent、不同项目对上下文裁剪的最佳策略可能完全不同。我们希望用**最少的代码与抽象**
把 compaction 从单一固定策略升级为可配置、可替换、可扩展（外部策略）的机制，从而支持快速试错。

作为验证，本 KLIP 新增一个策略 **Tool Result Hiding**：在不依赖 token count API 的前提下，用
“结构化规则”隐藏历史 tool result，并在必要时用 summary 兜底。

## 目标

- 提供轻量的 compaction 策略接口，支持配置、替换、外部扩展，并保持类型安全
- 保持当前触发时机不变（基于 token threshold；并且不包含当前 step 的 tool_result token）
- 新增 Tool Result Hiding 策略（非 LLM 摘要型 rewrite）
- 在 tool hiding 不足以解决问题时，最终仍可通过 summary 收敛（兜底）
- 兼容现有行为：未配置时默认等同于当前 `SimpleCompaction`（LLM summary）

## 非目标

- 不引入“每个 step 都触发 rewrite”的运行时框架
- 不引入通用的策略组合/pipeline 机制
- 不改变 tool 协议与 wire 事件语义，不引入新的 UI 展示逻辑
- 不做 tool result 内容摘要（仅隐藏/替换）
- 不引入 registry 与参数化插件系统（例如“插件注册 + 自定义 step schema + 参数透传”）

## 现状澄清：触发时机与 token usage

当前 compaction 的触发逻辑在 `KimiSoul` 内部，触发条件是：

- `context_tokens + reserved >= max_context_size`

其中 `context_tokens` 来自 `Context.token_count`，其值来自最近一次 LLM step 返回的 usage。
需要强调：

- 触发依据的 token usage **不包含 tool messages**（包括当前 step 追加进 history 的 tool messages；
  项目里也有注释说明）
- 因此，本 KLIP 不尝试在策略内部“精确判断改写后是否仍超阈值”（因为缺少可靠的 token 反馈）

本 KLIP 仅策略化 “how to rewrite context”，触发时机保持现状不变。

## 设计

### 1) 策略接口：CompactionStrategy

输入显式上下文，返回改写后的消息序列；返回 `None` 表示 no-op。

```python
@dataclass(frozen=True, slots=True)
class CompactionContext:
    history: Sequence[Message]
    token_count: int
    max_context_size: int
    reserved_context_size: int
    llm: LLM

type CompactionOutput = Sequence[Message] | None

class CompactionStrategy(Protocol):
    async def compact(self, ctx: CompactionContext) -> CompactionOutput: ...
```

约定：

- Strategy 是消息序列到消息序列的 rewrite：允许 drop/replace/merge，但需保持因果顺序
- 对 tool 消息：必须保留 `tool_call_id` 以维持与 assistant.tool_calls 的对齐关系
- 返回 `None` 表示不做任何修改
- 触发时机由 `KimiSoul` 控制，Strategy 不负责“何时运行”

与现状对比：现有 `SimpleCompaction` 是单体实现（选区间、组织 prompt、调 LLM、拼装 history）。
本 KLIP 将其拆为策略接口 + 触发逻辑；同一触发点下可替换为不需要 LLM 的 rewrite，而无需改动
`KimiSoul` 主体逻辑。

### 2) 策略加载（对齐 tool 的加载风格）

新增配置 `Config.compaction.strategy`：一个 `module:ClassName` 的 import path。

```python
class CompactionConfig(BaseModel):
    strategy: str = "kimi_cli.soul.compaction:LLMSummaryCompaction"
```

加载约定（与 tool 类似）：

- `strategy` 必须是 `module:ClassName`，可 `importlib.import_module`
- 目标类必须实现 `CompactionStrategy`
- 构造函数依赖注入沿用 tool 的规则：
  若类覆盖 `__init__`，则其位置参数视为依赖项，通过注解匹配从 `dependencies: dict[type, obj]`
  注入；遇到 keyword-only 参数后停止注入

注意：如果策略类需要“可调参数”，本 KLIP 不提供从 TOML 透传参数的机制；推荐通过外部策略类
（不同 import path）表达不同参数，或将参数做成类常量/keyword-only 且有默认值。

TOML 示例：

```toml
[compaction]
strategy = "kimi_cli.soul.compaction:HidingThenSummaryCompaction"
```

### 3) 新增策略：Tool Result Hiding（结构化 rewrite）

目标：隐藏历史 tool result，尽量不破坏当前链路；保留最近 N 次“工具调用组”的 tool responses。

核心点：不依赖 `lastUserIdx`（history 里可能存在非用户输入的 `role="user"` 注入），而是把
`assistant.tool_calls` 作为分组边界。

#### 3.1 工具调用组（tool_call group）定义

- 一条 `assistant` 消息若包含 `tool_calls`，视为一次 tool_call group
- 该 group 的 ID 集合为：`group_ids = {tc.id for tc in assistant.tool_calls}`
- 该 group 的 tool responses 为：后续出现的 `role="tool"` 消息中，`tool_call_id in group_ids`
  的那些消息
- parallel tool calls（同一条 assistant 里多个 tool_calls）算作一次 group，要么整体保留，要么整体隐藏

#### 3.2 Hiding 规则

设 `preserve_recent_n = 5`：

- 保留最近 `preserve_recent_n` 个 tool_call group 的所有 tool messages
- 对更早的 tool messages：将其内容替换为占位文本，但保留 `tool_call_id`
- 只改 tool message 内容，不删除 assistant/user 消息
- 若最终没有任何 tool message 被替换，则返回 `None`（no-op）

占位消息格式（稳定、可预测）：

```python
Message(
    role="tool",
    tool_call_id=msg.tool_call_id,
    content=[system("历史 tool_call已隐藏")],
)
```

### 4) 兜底：Tool Hiding 进入 Summary 的判断（不依赖 token）

由于触发判断的 token usage 不包含 tool messages，且本 KLIP 不引入 token count API，
因此不采用“hiding 后再判断是否仍超阈值”的逻辑。

最小且可实现的兜底规则：

1. compaction 触发时先尝试 Tool Result Hiding
2. 若 Tool Result Hiding 为 no-op（未替换任何 tool message），则执行 LLM summary 兜底

直觉解释：
- hiding 无效通常意味着“上下文膨胀不是由 tool result 造成”（或 tool 结果已被隐藏过）
- 这时 summary 能保证最终收敛
- 若 hiding 生效但仍然过长（例如 user/assistant 文本过长），下一次触发 compaction 时 hiding
  将变为 no-op，从而自然进入 summary 兜底（最多多触发一轮）

实现形态：新增一个内置策略类 `HidingThenSummaryCompaction`，其 `compact()` 内部显式按上述顺序
执行（这不是通用 pipeline，仅是一个具体策略的内部逻辑）。

### 5) 现有策略迁移：LLM Summary

将 `SimpleCompaction` 迁移为 `LLMSummaryCompaction`，实现 `CompactionStrategy` 接口。

默认参数沿用当前行为：`max_preserved_messages = 2`。

### 6) Python API 扩展

面向把 Kimi CLI 当库使用的用户，在 `KimiCLI.create(...)` 或 `KimiSoul(...)` 构造链路中
增加可选参数：

```python
kimi = await KimiCLI.create(..., compaction=HidingThenSummaryCompaction())
```

签名：`compaction: CompactionStrategy | None = None`，为空时走默认行为。

具体注入点与参数名由实现 PR 落地，本 KLIP 只约束语义与类型。

## 兼容性

- 未配置 compaction 时：默认行为等同于当前 `SimpleCompaction`
- Tool Result Hiding 只替换 tool 消息内容，不改变消息顺序与 role

## 实现计划

1. 定义 `CompactionContext` / `CompactionStrategy`
2. `SimpleCompaction` 迁移为 `LLMSummaryCompaction` 并实现新接口
3. 实现 `ToolResultHidingCompaction`（按 tool_call group 规则）
4. 实现 `HidingThenSummaryCompaction`（hiding no-op 时进入 summary）
5. 增加 `Config.compaction`，从配置加载 strategy，在 `KimiSoul` 中注入使用
6. 可选：增加 Python API 注入点，用于库调用方扩展

## 风险与权衡

- **信息丢失**：隐藏 tool result 可能影响后续推理；通过保留最近 N 组缓解，但仍需观察
- **提示注入**：占位文本应稳定、简短、明确是“隐藏”，避免被模型当作事实
- **可配置性取舍**：为保持实现简洁，不提供从 TOML 传入策略参数的通用机制；如需不同参数，
  推荐用不同 import path 的外部策略类表达；后续如有强需求可另起 KLIP
