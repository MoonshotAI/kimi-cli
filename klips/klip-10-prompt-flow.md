---
Author: "@stdrc"
Updated: 2026-01-15
Status: Implemented
---

# KLIP-10: Mermaid Prompt Flow (--prompt-flow)

## 背景

当前 Gitrekt CLI 只能通过交互式输入或 `--command` 单次输入驱动对话。希望支持一种
"prompt flow"，让用户用 Mermaid flowchart 描述流程，每个节点对应一次对话轮次，
并能根据分支节点的选择继续走向不同的下一节点。

示例见 `flowchart.mmd`：用 `BEGIN`/`END` 包住流程，中间节点为 prompt，分支节点用
出边 label 表示分支值。

## 目标

- 新增 `--prompt-flow <file.mmd>`，从 Mermaid flowchart 解析为内存图结构。
- 从 `BEGIN` 开始顺着图走，依次执行节点（除 BEGIN/END）。
- 在 `GitrektSoul` 中支持可选的 `PromptFlow`，通过 `/begin` 命令触发执行。
- 分支节点会在 user input 中补充可选分支值，要求 LLM 在回复末尾输出
  `<choice>{值}</choice>`，并据此选择下一节点。
- 在同一 session/context 中持续推进，直到抵达 `END`。

## 非目标

- 不支持完整 Mermaid 语法，仅支持 flowchart 的最小子集。
- 不引入新的 UI（依旧使用 shell UI 输出）。
- 不处理子图、样式、链接、点击事件等 Mermaid 特性。

## 设计概览

### 1) Mermaid flowchart 最小子集

仅支持以下语法（足够覆盖示例）：

- Header：`flowchart TD` / `flowchart LR` / `graph TD`（其余方向忽略）。
- 注释行：`%% ...`。
- 节点：`ID[文本]`（普通）、`ID([文本])`（开始/结束）、`ID{文本}`（分支）。
- 节点内容支持引号包裹：`ID["含特殊字符的文本"]`，引号内可包含 `]`、`}`、`|` 等。
- 边：`A --> B`、`A -->|label| B`、`A -- label --> B`。
- 允许边上内联节点定义：`A([BEGIN]) --> B[...]`。

不支持：子图、链式多节点（`A --> B --> C`）、复杂连线形态、label 中包含 `|`。

### 2) 图结构与校验

数据结构（位于 `src/gitrekt_cli/flow.py`）：

```python
FlowNodeKind = Literal["begin", "end", "task", "decision"]

@dataclass(frozen=True, slots=True)
class FlowNode:
    id: str
    label: str | list[ContentPart]  # 支持富文本内容
    kind: FlowNodeKind

@dataclass(frozen=True, slots=True)
class FlowEdge:
    src: str
    dst: str
    label: str | None

@dataclass(slots=True)
class PromptFlow:
    nodes: dict[str, FlowNode]
    outgoing: dict[str, list[FlowEdge]]
    begin_id: str
    end_id: str
```

异常层次结构：

```python
class PromptFlowError(ValueError):
    """Base error for prompt flow parsing/validation."""

class PromptFlowParseError(PromptFlowError):
    """Raised when Mermaid flowchart parsing fails."""

class PromptFlowValidationError(PromptFlowError):
    """Raised when a flowchart fails validation."""
```

校验规则：

- `BEGIN`/`END` 通过节点文本（label）匹配，大小写不敏感。
- 必须且只能有一个 `BEGIN`、一个 `END`。
- `BEGIN` 只允许 1 条出边；`END` 不允许出边。
- 非分支节点（task）要求恰好 1 条出边（除非它就是 `END`）。
- 分支节点（decision）要求出边 label 全部非空且唯一。
- 未显式声明的节点允许隐式创建（label 默认使用节点 ID），以保持 Mermaid 的常见用法。

### 3) FlowRunner 与 GitrektSoul 扩展

提取独立的 `FlowRunner` 类处理 flow 执行逻辑，`GitrektSoul` 通过持有 `_flow_runner`
实例来支持 prompt flow。同时重构 slash command 机制，将 skill commands 也改为
实例级别（不再全局注册）。

**FlowRunner 类**（位于 `src/gitrekt_cli/soul/Gitrektsoul.py`）：

```python
class FlowRunner:
    def __init__(self, flow: PromptFlow, *, max_moves: int = DEFAULT_MAX_FLOW_MOVES) -> None:
        self._flow = flow
        self._max_moves = max_moves

    async def run(self, soul: GitrektSoul, args: str) -> None:
        """执行 flow 遍历，通过 /begin 触发。"""
        ...

    async def _execute_flow_node(
        self,
        soul: GitrektSoul,
        node: FlowNode,
        edges: list[FlowEdge],
    ) -> tuple[str | None, int]:
        """执行单个节点，返回 (下一节点 ID, 使用的步数)。"""
        ...

    @staticmethod
    def _build_flow_prompt(node: FlowNode, edges: list[FlowEdge]) -> str | list[ContentPart]:
        """构建节点 prompt，分支节点会附加选择指引。"""
        ...

    @staticmethod
    def _match_flow_edge(edges: list[FlowEdge], choice: str | None) -> str | None:
        """根据 choice 匹配出边。"""
        ...

    @staticmethod
    def ralph_loop(
        user_message: Message,
        max_ralph_iterations: int,
    ) -> tuple[PromptFlow, int]:
        """创建 Ralph 模式的循环流程。"""
        ...
```

**修改 GitrektSoul**：

```python
class GitrektSoul:
    def __init__(
        self,
        agent: Agent,
        *,
        context: Context,
        flow: PromptFlow | None = None,  # 可选参数
    ):
        # ... 现有初始化 ...
        self._flow_runner = FlowRunner(flow) if flow is not None else None
        # 在 init 时构造 slash commands，避免每次 run 重复构造
        self._slash_commands = self._build_slash_commands()
        self._slash_command_map = self._index_slash_commands(self._slash_commands)

    def _build_slash_commands(self) -> list[SlashCommand[Any]]:
        commands: list[SlashCommand[Any]] = list(soul_slash_registry.list_commands())
        # 实例级别：skill commands
        for skill in self._runtime.skills.values():
            commands.append(SlashCommand(
                name=f"skill:{skill.name}",
                func=self._make_skill_runner(skill),
                description=skill.description or "",
                aliases=[],
            ))
        # 实例级别：/begin（如果有 flow）
        if self._flow_runner is not None:
            commands.append(SlashCommand(
                name="begin",
                func=self._flow_runner.run,
                description="Start the prompt flow",
                aliases=[],
            ))
        return commands

    def _find_slash_command(self, name: str) -> SlashCommand[Any] | None:
        return self._slash_command_map.get(name)

    @property
    def available_slash_commands(self) -> list[SlashCommand[Any]]:
        return self._slash_commands
```

运行规则：

- `GitrektSoul` 构造时可选传入 `PromptFlow`，内部创建 `FlowRunner`。
- `available_slash_commands` 统一返回：静态命令 + skill commands + `/begin`。
- `run` 方法查找实例命令（而非静态 registry），支持动态命令。
- `/begin` 触发 `FlowRunner.run` 执行 flow 遍历。

分支节点的 prompt 组装（示意）：

```
{node.label}

Available branches:
- 是
- 否

Reply with a choice using <choice>...</choice>.
```

选择解析：

- 从本次 run 后新增的最后一条 assistant message 读取文本。
- 使用正则 `r"<choice>([^<]*)</choice>"` 抽取**最后一个** choice 标签的值，trim 后精确匹配出边 label。
  - 不强制 choice 在末尾，因为 LLM 可能在 choice 后追加解释文字。
  - 使用 `[^<]*` 而非 `.*?` 避免跨标签匹配。
- 若缺失或无匹配：自动重试（追加"必须按格式输出"的提示）。

为防止死循环，内置 `max_moves`（默认 1000）作为硬上限；到达上限则抛出 `MaxStepsReached`。

### 4) Ralph 模式

Ralph 模式是一种特殊的自动迭代模式，通过 `--max-ralph-iterations` 参数启用。
它会自动将用户输入包装成一个带 CONTINUE/STOP 分支的循环流程：

```python
@staticmethod
def ralph_loop(
    user_message: Message,
    max_ralph_iterations: int,
) -> tuple[PromptFlow, int]:
    """
    创建 Ralph 模式的循环流程：
    BEGIN → R1(执行用户 prompt) → R2(决策节点) → CONTINUE(回到 R2) / STOP → END
    """
    ...
```

在 `GitrektSoul.run` 中，如果启用了 Ralph 模式且没有显式的 prompt flow，会自动创建
Ralph 循环流程：

```python
if self._loop_control.max_ralph_iterations != 0 and self._flow_runner is None:
    flow, max_moves = FlowRunner.ralph_loop(
        user_message,
        self._loop_control.max_ralph_iterations,
    )
    runner = FlowRunner(flow, max_moves=max_moves)
    await runner.run(self, "")
    return
```

### 5) CLI 集成

在 `Gitrekt` 根命令新增参数：

```
--prompt-flow <file.mmd>
```

行为约束：

- 与 Ralph 模式（`--max-ralph-iterations != 0`）互斥。
- 与所有 UI 模式兼容（shell/print/wire/acp）。
- 与 `--continue/--session` 兼容：可在已有 session 上执行 prompt flow（共享上下文），
  但**不支持**从 prompt flow 中断处恢复——每次执行都从 `BEGIN` 开始。

实现路径：

- `src/gitrekt_cli/flow.py`：
  - `parse_flowchart(text) -> PromptFlow`（解析 Mermaid）
  - `parse_choice(text) -> str | None`（解析 choice 标签）
  - `PromptFlow`、`FlowNode`、`FlowEdge` 数据结构
  - `PromptFlowError`、`PromptFlowParseError`、`PromptFlowValidationError` 异常
- `src/gitrekt_cli/soul/Gitrektsoul.py`：
  - `FlowRunner` 类处理 flow 执行
  - `GitrektSoul.__init__` 新增 `flow: PromptFlow | None = None` 参数
  - `available_slash_commands` 改为动态组合：静态 + skills + `/begin`
  - `run` 方法查找命令改为 `_find_slash_command`（实例级别）
- `src/gitrekt_cli/cli/__init__.py`：
  - 解析 `--prompt-flow` 参数
  - 构造 `PromptFlow` 并传入 `GitrektCLI.create`
  - 检查与 Ralph 模式的互斥

### 6) 错误处理与用户反馈

- 解析错误：通过 `PromptFlowParseError` 明确指出 Mermaid 语法问题，包含行号。
- 校验错误：通过 `PromptFlowValidationError` 指出图结构问题。
- 运行时错误：日志记录当前节点、分支选择失败原因。
- choice 无效：自动重试，追加提示要求按格式输出。
- 输出日志：`logger.info`/`logger.warning` 记录节点推进与选择结果，便于调试。

## 兼容性与边界

- 仅支持 flowchart，且只解析上述最小子集。
- `BEGIN`/`END` 只通过 label 识别；如果用户用其它词，需要显式改名。
- 允许循环图；但会受到 `max_moves` 限制。
- 分支 label 要求短且稳定；建议避免多行或包含特殊字符。
- `FlowNode.label` 支持 `str | list[ContentPart]`，可用于 Ralph 模式等内部场景。

## 关键参考位置

- CLI 入口：`src/gitrekt_cli/cli/__init__.py`
- Flow 解析：`src/gitrekt_cli/flow.py`
- `GitrektSoul` 与 `FlowRunner`：`src/gitrekt_cli/soul/Gitrektsoul.py`
- `SlashCommand`：`src/gitrekt_cli/utils/slashcmd.py`
- 静态 soul commands：`src/gitrekt_cli/soul/slash.py`
- Shell UI：`src/gitrekt_cli/ui/shell/__init__.py`
- Mermaid 示例：`flowchart.mmd`
