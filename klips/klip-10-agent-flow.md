---
Author: "@stdrc"
Updated: 2026-01-20
Status: Implemented
---

# KLIP-10: Agent Flow (Agent Skill 扩展)

## 背景

当前 Kimi CLI 只能通过交互式输入或 `--command` 单次输入驱动对话。希望支持一种
"agent flow"，让用户用 Mermaid 或 D2 flowchart 描述流程，每个节点对应一次对话轮次，
并能根据分支节点的选择继续走向不同的下一节点。Agent Flow 作为 Agent Skill 的扩展，
通过 `SKILL.md` 中的元数据声明类型，并从流程图代码块解析得到。

示例见 `flowchart.mmd`：用 `BEGIN`/`END` 包住流程，中间节点为 prompt，分支节点用
出边 label 表示分支值。

## 目标

- Agent Skill 支持 `type: standard | flow` 元数据（默认 standard）。
- flow 类型 skill 从 `SKILL.md` 中的第一个 Mermaid/D2 代码块解析流程。
- Flow 作为 `Skill.flow` 存储，并在 `KimiSoul` 中通过 `/flow:<name>` 触发执行。
- standard 类型 skill 仍使用 `/skill:<name>`，system prompt 中继续列出 name/description/path。
- 分支节点会在 user input 中补充可选分支值，要求 LLM 在回复末尾输出
  `<choice>{值}</choice>`，并据此选择下一节点。
- 在同一 session/context 中持续推进，直到抵达 `END`。

## 非目标

- 不支持完整 Mermaid/D2 语法，仅支持各自的最小子集。
- 不引入新的 UI（依旧使用 shell UI 输出）。
- 不处理子图、样式、链接、点击事件等 Mermaid 特性。

## 设计概览

### 1) Mermaid flowchart 最小子集

仅支持以下语法（足够覆盖示例）：

- Header：`flowchart TD` / `flowchart LR` / `graph TD`（其余方向忽略）。
- 注释行：`%% ...`。
- 节点：`ID[文本]` / `ID([文本])` / `ID{文本}`（形状仅用于携带 label，语义上忽略）。
- 节点内容支持引号包裹：`ID["含特殊字符的文本"]`，引号内可包含 `]`、`}`、`|` 等。
- 边：`A --> B`、`A -->|label| B`、`A -- label --> B`。
- 允许边上内联节点定义：`A([BEGIN]) --> B[...]`。

其他样式与布局相关语法（如 `classDef`/`style`/`linkStyle`/`subgraph`）会被忽略，不报错。

### 2) D2 flowchart 最小子集

支持以下语法（足够覆盖示例）：

- 注释行：`# ...`。
- 节点：`ID: label`（label 省略时使用 ID）。
- 边：`A -> B`、`A -> B: label`，允许链式 `A -> B -> C`（label 仅作用于最后一段）。
- 节点 ID：字母数字或 `_` 开头，允许 `.` `/` `-`。

忽略：属性路径（如 `foo.bar`）与 `{ ... }` 块。

### 3) 图结构与校验

数据结构（位于 `src/kimi_cli/skill/flow/__init__.py`，`PromptFlow` 更名为 `Flow`）：

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
class Flow:
    nodes: dict[str, FlowNode]
    outgoing: dict[str, list[FlowEdge]]
    begin_id: str
    end_id: str
```

异常层次结构：

```python
class FlowError(ValueError):
    """Base error for flow parsing/validation."""

class FlowParseError(FlowError):
    """Raised when flowchart parsing fails."""

class FlowValidationError(FlowError):
    """Raised when a flowchart fails validation."""
```

校验规则：

- `BEGIN`/`END` 通过节点文本（label）匹配，大小写不敏感。
- 必须且只能有一个 `BEGIN`、一个 `END`。
- `BEGIN` 能连通到 `END`。
- 如果某节点有多个出边，则每条边必须有非空 label，且 label 不能重复。
- 单出边节点允许 label 缺失或为空（label 会被忽略）。
- 未显式声明的节点允许隐式创建（label 默认使用节点 ID），以保持常见用法。

### 4) Agent Flow 发现与加载

Agent Flow 与 Agent Skill 复用同一套 discovery 逻辑，目录来源保持不变：

- 内置技能：`src/kimi_cli/skills/`
- 用户技能：`~/.config/agents/skills`（含历史兼容路径）
- 项目技能：`<work_dir>/.agents/skills`（含历史兼容路径）

skill 元数据：

- `type: standard | flow`，默认 `standard`。
- flow skill 会在 `SKILL.md` 中查找第一个 `mermaid` 或 `d2` fenced codeblock，
  并解析为 `Flow` 存入 `Skill.flow`。
- 未找到有效流程图或解析失败时，记录日志并将其作为普通 skill 处理。

### 5) FlowRunner 与 KimiSoul 扩展

提取独立的 `FlowRunner` 类处理 flow 执行逻辑，`KimiSoul` 通过持有 `_flow_runners`
来支持 agent flow。同时重构 slash command 机制，将 skill commands 也改为实例级别
（不再全局注册）。

**FlowRunner 类**（位于 `src/kimi_cli/soul/kimisoul.py`）：

```python
class FlowRunner:
    def __init__(
        self,
        flow: Flow,
        *,
        name: str | None = None,
        max_moves: int = DEFAULT_MAX_FLOW_MOVES,
    ) -> None:
        self._flow = flow
        self._name = name
        self._max_moves = max_moves

    async def run(self, soul: KimiSoul, args: str) -> None:
        """执行 flow 遍历，通过 /flow:<name> 触发。"""
        ...

    async def _execute_flow_node(
        self,
        soul: KimiSoul,
        node: FlowNode,
        edges: list[FlowEdge],
    ) -> tuple[str | None, int]:
        """执行单个节点，返回 (下一节点 ID, 使用的步数)。"""
        ...

    @staticmethod
    def _build_flow_prompt(node: FlowNode, edges: list[FlowEdge]) -> str | list[ContentPart]:
        """构建节点 prompt，多出边节点会附加选择指引。"""
        ...

    @staticmethod
    def _match_flow_edge(edges: list[FlowEdge], choice: str | None) -> str | None:
        """根据 choice 匹配出边。"""
        ...

    @staticmethod
    def ralph_loop(
        user_message: Message,
        max_ralph_iterations: int,
    ) -> FlowRunner:
        """创建 Ralph 模式的循环流程。"""
        ...
```

**修改 KimiSoul**：

```python
class KimiSoul:
    def __init__(
        self,
        agent: Agent,
        *,
        context: Context,
    ):
        # ... 现有初始化 ...
        # 在 init 时构造 slash commands，避免每次 run 重复构造
        self._slash_commands = self._build_slash_commands()
        self._slash_command_map = self._index_slash_commands(self._slash_commands)

    def _build_slash_commands(self) -> list[SlashCommand[Any]]:
        commands: list[SlashCommand[Any]] = list(soul_slash_registry.list_commands())
        # 实例级别：skill commands（standard）
        for skill in self._runtime.skills.values():
            if skill.type != "standard":
                continue
            commands.append(SlashCommand(
                name=f"skill:{skill.name}",
                func=self._make_skill_runner(skill),
                description=skill.description or "",
                aliases=[],
            ))
        # 实例级别：/flow:<name>（flow skills）
        for skill in self._runtime.skills.values():
            if skill.type != "flow" or skill.flow is None:
                continue
            runner = FlowRunner(skill.flow, name=skill.name)
            commands.append(SlashCommand(
                name=f"flow:{skill.name}",
                func=runner.run,
                description=f"Start the agent flow '{skill.name}'",
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

- `KimiSoul` 根据 `Skill.type` 生成 `/skill:<name>` 或 `/flow:<name>`。
- `available_slash_commands` 统一返回：静态命令 + skill commands + flow commands。
- `run` 方法查找实例命令（而非静态 registry），支持动态命令。
- `/flow:<name>` 触发 `FlowRunner.run` 执行 flow 遍历。
- 节点是否需要选择由出边数量决定（多出边即分支）。

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

### 6) Ralph 模式

Ralph 模式是一种特殊的自动迭代模式，通过 `--max-ralph-iterations` 参数启用。
它会自动将用户输入包装成一个带 CONTINUE/STOP 分支的循环流程：

```python
@staticmethod
def ralph_loop(
    user_message: Message,
    max_ralph_iterations: int,
) -> FlowRunner:
    """
    创建 Ralph 模式的循环流程：
    BEGIN → R1(执行用户 prompt) → R2(决策节点) → CONTINUE(回到 R2) / STOP → END
    """
    ...
```

在 `KimiSoul.run` 中，如果启用了 Ralph 模式，会自动创建 Ralph 循环流程：

```python
if self._loop_control.max_ralph_iterations != 0:
    runner = FlowRunner.ralph_loop(
        user_message,
        self._loop_control.max_ralph_iterations,
    )
    await runner.run(self, "")
    return
```

### 7) CLI 集成

Agent Flow 通过 skill discovery 自动加载，不新增 CLI 参数。只要 `SKILL.md` 中声明
`type: flow` 并包含流程图代码块，即可通过 `/flow:<name>` 使用。

### 8) 错误处理与用户反馈

- 解析错误：通过 `FlowParseError` 指出 Mermaid/D2 语法问题（包含行号）。
- 校验错误：通过 `FlowValidationError` 指出图结构问题。
- flow skill 无有效流程图：记录日志并降级为普通 skill。
- 运行时错误：日志记录当前节点、分支选择失败原因。
- choice 无效：自动重试，追加提示要求按格式输出。
- 输出日志：`logger.info`/`logger.warning` 记录节点推进与选择结果，便于调试。

## 兼容性与边界

- 仅支持 flowchart，且只解析上述最小子集。
- `BEGIN`/`END` 只通过 label 识别；如果用户用其它词，需要显式改名。
- 允许循环图；但会受到 `max_moves` 限制。
- flow 名称与 skill 名称一致。
- 分支 label 要求短且稳定；建议避免多行或包含特殊字符。
- `FlowNode.label` 支持 `str | list[ContentPart]`，可用于 Ralph 模式等内部场景。

## 关键参考位置

- CLI 入口：`src/kimi_cli/cli/__init__.py`
- Skill 解析：`src/kimi_cli/skill/__init__.py`
- Flow 解析：`src/kimi_cli/skill/flow/mermaid.py` / `src/kimi_cli/skill/flow/d2.py`
- Flow 数据结构：`src/kimi_cli/skill/flow/__init__.py`
- `KimiSoul` 与 `FlowRunner`：`src/kimi_cli/soul/kimisoul.py`
- `SlashCommand`：`src/kimi_cli/utils/slashcmd.py`
- 静态 soul commands：`src/kimi_cli/soul/slash.py`
- Shell UI：`src/kimi_cli/ui/shell/__init__.py`
- Mermaid 示例：`flowchart.mmd`
