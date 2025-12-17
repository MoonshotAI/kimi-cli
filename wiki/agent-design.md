# Agent 与 MultiAgent 设计

本文档介绍 Kimi CLI 的 Agent 架构和 MultiAgent 协作机制。

## 设计概览

Kimi CLI 的 Agent 系统采用**三层结构**：

```
┌─────────────────────────────────────────┐
│              Agent 实例                  │
│  - name: 代理名称                        │
│  - system_prompt: 系统提示               │
│  - toolset: 工具集                       │
│  - runtime: 运行时环境                   │
└─────────────────────────────────────────┘
                    ↑
        ┌───────────┴───────────┐
        │                       │
    ┌─────────┐          ┌──────────┐
    │AgentSpec│          │ Runtime  │
    │ YAML配置│          │ 运行环境 │
    └─────────┘          └──────────┘
```

## Agent 定义

**文件路径：** `src/kimi_cli/soul/agent.py`

### Agent 类

```python
@dataclass(frozen=True, slots=True, kw_only=True)
class Agent:
    name: str              # 代理名称
    system_prompt: str     # 系统提示（已模板替换）
    toolset: Toolset       # 工具集合
    runtime: Runtime       # 运行时上下文
```

### Runtime 类

Runtime 是 Agent 的运行时环境，包含所有依赖：

```python
@dataclass(frozen=True, slots=True, kw_only=True)
class Runtime:
    config: Config                         # 配置信息
    llm: LLM | None                        # LLM 提供者
    session: Session                       # 会话信息
    builtin_args: BuiltinSystemPromptArgs  # 内置系统提示参数
    denwa_renji: DenwaRenji                # D-Mail 系统
    approval: Approval                     # 审批系统
    labor_market: LaborMarket              # 代理劳动力市场
    environment: Environment               # 环境信息
```

## Agent 配置（YAML）

**文件路径：** `src/kimi_cli/agents/default/agent.yaml`

### 配置格式

```yaml
version: 1
agent:
  name: ""                          # 代理名称
  system_prompt_path: ./system.md   # 系统提示文件路径
  system_prompt_args:               # 系统提示模板参数
    ROLE_ADDITIONAL: ""
  tools:                            # 工具列表
    - "kimi_cli.tools.multiagent:Task"
    - "kimi_cli.tools.shell:Shell"
    - "kimi_cli.tools.file:ReadFile"
  exclude_tools: []                 # 排除的工具
  subagents:                        # 子代理定义
    coder:
      path: ./sub.yaml
      description: "Good at general software engineering tasks."
```

### AgentSpec 数据结构

**文件路径：** `src/kimi_cli/agentspec.py`

```python
class AgentSpec(BaseModel):
    extend: str | None = None           # 扩展的父代理文件
    name: str | Inherit                 # 代理名称
    system_prompt_path: Path | Inherit  # 系统提示路径
    system_prompt_args: dict[str, str]  # 模板参数
    tools: list[str] | None | Inherit   # 工具列表
    exclude_tools: list[str] | None     # 排除工具
    subagents: dict[str, SubagentSpec]  # 子代理

class SubagentSpec(BaseModel):
    path: Path           # 子代理配置文件路径
    description: str     # 子代理描述
```

### 继承机制

Agent 配置支持**递归继承**：

```yaml
# okabe/agent.yaml - 继承默认代理
version: 1
agent:
  extend: default           # 继承默认代理
  tools:
    - "kimi_cli.tools.dmail:SendDMail"  # 添加 D-Mail 工具
  exclude_tools: []
```

**继承解析流程：**
1. 加载当前配置
2. 如果有 `extend` 字段，递归加载父配置
3. 合并配置（子配置覆盖父配置）
4. `system_prompt_args` 被**合并**而不是覆盖

## Agent 加载流程

### 主入口函数

```python
async def load_agent(agent_file: Path, runtime: Runtime) -> Agent:
    # 1. 加载 Agent 规范
    agent_spec = load_agent_spec(agent_file)

    # 2. 加载系统提示（模板替换）
    system_prompt = _load_system_prompt(
        agent_spec.system_prompt_path,
        agent_spec.system_prompt_args,
        runtime.builtin_args
    )

    # 3. 加载子代理
    for name, subagent_spec in agent_spec.subagents.items():
        subagent = await load_agent(
            subagent_spec.path,
            runtime.copy_for_fixed_subagent()  # 克隆 Runtime
        )
        runtime.labor_market.add_fixed_subagent(name, subagent, subagent_spec.description)

    # 4. 加载工具（依赖注入）
    toolset = KimiToolset()
    for tool_path in agent_spec.tools:
        tool = _load_tool(tool_path, tool_deps)
        toolset.add(tool)

    # 5. 加载 MCP 工具
    if mcp_configs:
        await _load_mcp_tools(toolset, mcp_configs, runtime)

    return Agent(name, system_prompt, toolset, runtime)
```

### 系统提示模板参数

```python
@dataclass(frozen=True, slots=True, kw_only=True)
class BuiltinSystemPromptArgs:
    KIMI_NOW: str           # ISO 格式的当前时间
    KIMI_WORK_DIR: KaosPath # 当前工作目录绝对路径
    KIMI_WORK_DIR_LS: str   # 工作目录列表输出
    KIMI_AGENTS_MD: str     # AGENTS.md 文件内容
```

在系统提示中使用：
```markdown
当前时间: ${KIMI_NOW}
工作目录: ${KIMI_WORK_DIR}
```

## 工具加载与依赖注入

### 工具加载函数

```python
def _load_tool(tool_path: str, dependencies: dict[type, Any]) -> ToolType:
    # 解析 "module:Class" 格式
    module_name, class_name = tool_path.rsplit(":", 1)
    module = importlib.import_module(module_name)
    cls = getattr(module, class_name)

    # 依赖注入：检查 __init__ 参数，从 dependencies 中获取
    args = []
    for param in inspect.signature(cls).parameters.values():
        if param.annotation in dependencies:
            args.append(dependencies[param.annotation])

    return cls(*args)
```

### 依赖注入容器

```python
tool_deps = {
    KimiToolset: toolset,
    Runtime: runtime,
    Config: runtime.config,
    Session: runtime.session,
    DenwaRenji: runtime.denwa_renji,
    Approval: runtime.approval,
    LaborMarket: runtime.labor_market,
    Environment: runtime.environment,
}
```

### 工具定义示例

```python
class Shell(CallableTool2[Params]):
    name: str = "Shell"
    params: type[Params] = Params

    def __init__(self, approval: Approval, environment: Environment):
        # 依赖通过构造函数注入
        self._approval = approval
        self._environment = environment

    async def __call__(self, params: Params) -> ToolReturnValue:
        # 实现工具逻辑
        return ToolOk(...) or ToolError(...)
```

## SubAgent 设计

### 两种子代理类型

Kimi CLI 支持两种子代理，有不同的 Runtime 克隆策略：

#### Fixed Subagents（固定子代理）

**定义方式：** 在 `agent.yaml` 的 `subagents` 部分

**Runtime 克隆：**
```python
def copy_for_fixed_subagent(self) -> Runtime:
    return Runtime(
        config=self.config,
        llm=self.llm,
        session=self.session,
        builtin_args=self.builtin_args,
        denwa_renji=DenwaRenji(),      # 新的独立 DenwaRenji
        approval=self.approval,
        labor_market=LaborMarket(),    # 新的独立 LaborMarket
        environment=self.environment,
    )
```

**特点：**
- 配置阶段定义
- 独立的 LaborMarket → **无法互相调用**
- 独立的 DenwaRenji

#### Dynamic Subagents（动态子代理）

**定义方式：** 运行时通过 `CreateSubagent` 工具创建

**Runtime 克隆：**
```python
def copy_for_dynamic_subagent(self) -> Runtime:
    return Runtime(
        config=self.config,
        llm=self.llm,
        session=self.session,
        builtin_args=self.builtin_args,
        denwa_renji=DenwaRenji(),      # 新的独立 DenwaRenji
        approval=self.approval,
        labor_market=self.labor_market, # 共享父代理的 LaborMarket
        environment=self.environment,
    )
```

**特点：**
- 运行时动态创建
- 共享 LaborMarket → **可以互相调用**
- 独立的 DenwaRenji

### LaborMarket（代理劳动力市场）

管理所有可用的子代理：

```python
class LaborMarket:
    def __init__(self):
        self.fixed_subagents: dict[str, Agent] = {}
        self.fixed_subagent_descs: dict[str, str] = {}
        self.dynamic_subagents: dict[str, Agent] = {}

    @property
    def subagents(self) -> Mapping[str, Agent]:
        """获取所有子代理"""
        return {**self.fixed_subagents, **self.dynamic_subagents}

    def add_fixed_subagent(self, name: str, agent: Agent, description: str):
        self.fixed_subagents[name] = agent
        self.fixed_subagent_descs[name] = description

    def add_dynamic_subagent(self, name: str, agent: Agent):
        self.dynamic_subagents[name] = agent
```

### 子代理配置示例

**文件路径：** `src/kimi_cli/agents/default/sub.yaml`

```yaml
version: 1
agent:
  extend: ./agent.yaml          # 继承主代理配置
  system_prompt_args:
    ROLE_ADDITIONAL: |          # 添加子代理特定的系统提示
      You are now running as a subagent. All the `user` messages
      are sent by the main agent. The main agent cannot see your
      context, it can only see your last message when you finish.
  exclude_tools:                # 子代理不能使用这些工具
    - "kimi_cli.tools.multiagent:Task"
    - "kimi_cli.tools.multiagent:CreateSubagent"
    - "kimi_cli.tools.dmail:SendDMail"
    - "kimi_cli.tools.todo:SetTodoList"
  subagents: {}                 # 子代理不能有自己的子代理
```

## MultiAgent 协作机制

### Task 工具 - 子代理调用

**文件路径：** `src/kimi_cli/tools/multiagent/task.py`

#### 参数定义

```python
class Params(BaseModel):
    description: str      # 任务描述 (3-5 字)
    subagent_name: str    # 子代理名称
    prompt: str           # 详细的任务提示
```

#### 执行流程

```
Task.__call__(description, subagent_name, prompt)
    │
    ▼
┌─────────────────────────────────────────────────────┐
│ 1. 验证子代理存在                                    │
│    subagent = labor_market.subagents[subagent_name] │
└─────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────┐
│ 2. 获取当前 Wire 和 ToolCall                         │
│    用于建立与主代理的通信链接                         │
└─────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────┐
│ 3. 创建子代理独立的上下文文件                         │
│    context_file = next_available_rotation(...)      │
└─────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────┐
│ 4. 创建 KimiSoul 实例                                │
│    soul = KimiSoul(subagent, context, ...)          │
└─────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────┐
│ 5. 运行子代理                                        │
│    await run_soul(soul, prompt, wire_send)          │
└─────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────┐
│ 6. 返回子代理最终响应                                 │
│    return ToolOk(final_response)                    │
└─────────────────────────────────────────────────────┘
```

### CreateSubagent 工具 - 动态创建代理

**文件路径：** `src/kimi_cli/tools/multiagent/create.py`

```python
class CreateSubagent(CallableTool2[Params]):
    async def __call__(self, params: Params) -> ToolReturnValue:
        # 检查是否已存在
        if params.name in self._runtime.labor_market.subagents:
            return ToolError(f"Subagent '{params.name}' already exists.")

        # 创建动态子代理
        subagent = Agent(
            name=params.name,
            system_prompt=params.system_prompt,
            toolset=self._toolset,  # 共享父代理的工具集
            runtime=self._runtime.copy_for_dynamic_subagent(),
        )

        # 注册到劳动力市场
        self._runtime.labor_market.add_dynamic_subagent(params.name, subagent)

        return ToolOk(
            output="Available subagents: " +
                   ", ".join(self._runtime.labor_market.subagents.keys())
        )
```

### 并行任务执行

主代理可以在单个响应中发起多个 Task 调用，实现并行执行：

```
主代理响应:
├─ Task(subagent="coder", prompt="实现功能A")  ─┐
├─ Task(subagent="coder", prompt="实现功能B")  ─┼─ 并行执行
└─ Task(subagent="coder", prompt="实现功能C")  ─┘
```

## Agent 通信机制

### Wire 系统 - 主通信通道

**文件路径：** `src/kimi_cli/wire/__init__.py`

Wire 是 Soul（灵魂）与 UI 之间的通信通道：

```python
class Wire:
    def __init__(self, *, file_backend: Path | None = None):
        self._raw_queue = WireMessageQueue()      # 原始消息队列
        self._merged_queue = WireMessageQueue()   # 合并消息队列
        self._soul_side = WireSoulSide(...)       # 灵魂侧接口
        self._recorder = _WireRecorder(...)       # 消息记录器

    @property
    def soul_side(self) -> WireSoulSide:
        """灵魂侧 - 发送消息"""
        return self._soul_side

    def ui_side(self, *, merge: bool) -> WireUISide:
        """UI 侧 - 接收消息"""
        return WireUISide(...)
```

### SubagentEvent - 子代理事件

**文件路径：** `src/kimi_cli/wire/message.py`

子代理的事件被包装后发送到主 Wire：

```python
class SubagentEvent(BaseModel):
    task_tool_call_id: str  # 关联的 Task 工具调用 ID
    event: Event            # 子代理事件
```

**子代理通信流程：**

```python
def _super_wire_send(msg: WireMessage) -> None:
    if isinstance(msg, ApprovalRequest | ApprovalRequestResolved):
        # 审批请求直接发送到根 Wire
        super_wire.soul_side.send(msg)
        return

    # 其他事件包装为 SubagentEvent
    event = SubagentEvent(
        task_tool_call_id=current_tool_call_id,
        event=msg,
    )
    super_wire.soul_side.send(event)
```

### Approval 系统 - 审批通信

**文件路径：** `src/kimi_cli/soul/approval.py`

工具执行前可能需要用户审批：

```python
class Approval:
    async def request(self, sender: str, action: str, description: str) -> bool:
        """请求用户审批"""
        request = Request(
            id=str(uuid.uuid4()),
            tool_call_id=get_current_tool_call().id,
            sender=sender,
            action=action,
            description=description,
        )
        self._request_queue.put_nowait(request)
        return await approved_future  # 等待用户响应
```

## 隔离机制

### 三层隔离设计

| 层级 | Fixed Subagent | Dynamic Subagent |
|------|----------------|------------------|
| **Context** | 独立上下文文件 | 独立上下文文件 |
| **DenwaRenji** | 独立实例 | 独立实例 |
| **LaborMarket** | **独立实例** | **共享父代理** |

### 隔离的影响

| 特性 | Fixed Subagent | Dynamic Subagent |
|------|----------------|------------------|
| 调用其他子代理 | ❌ 不能 | ✅ 可以 |
| 被其他子代理调用 | ❌ 不能 | ✅ 可以 |
| 独立的 D-Mail | ✅ 是 | ✅ 是 |

## 核心设计模式

| 模式 | 应用场景 | 实现位置 |
|------|----------|----------|
| **工厂模式** | Agent 和 Tool 创建 | `agent.py` |
| **依赖注入** | Tool 参数注入 | `_load_tool()` |
| **策略模式** | Runtime 克隆策略 | `copy_for_*_subagent()` |
| **观察者模式** | Wire 消息发布订阅 | `wire/__init__.py` |
| **上下文变量** | 运行时上下文管理 | `ContextVar` |

## 文件结构

```
src/kimi_cli/
├── agentspec.py              # Agent 规范定义和解析
├── agents/                   # Agent 配置目录
│   ├── default/
│   │   ├── agent.yaml        # 默认代理配置
│   │   ├── sub.yaml          # 默认子代理配置
│   │   └── system.md         # 默认系统提示
│   └── okabe/
│       └── agent.yaml        # Okabe 代理（带 D-Mail）
│
├── soul/
│   ├── agent.py              # Agent/Runtime 定义，加载逻辑
│   ├── toolset.py            # KimiToolset 实现
│   ├── denwarenji.py         # D-Mail 系统
│   ├── approval.py           # 审批系统
│   ├── context.py            # 上下文管理
│   └── kimisoul.py           # Agent 执行引擎
│
├── tools/
│   ├── multiagent/
│   │   ├── task.py           # Task 工具（子代理调用）
│   │   └── create.py         # CreateSubagent 工具
│   ├── shell/                # Shell 执行
│   ├── file/                 # 文件操作
│   └── mcp.py                # MCP 工具适配
│
└── wire/
    ├── __init__.py           # Wire 通信系统
    └── message.py            # Wire 消息定义
```

## 扩展指南

### 添加新工具

1. 创建工具类，继承 `CallableTool2`
2. 定义参数模型（Pydantic）
3. 实现 `__call__` 方法
4. 在 `agent.yaml` 中注册

```python
class MyTool(CallableTool2[MyParams]):
    name: str = "MyTool"
    params: type[MyParams] = MyParams

    def __init__(self, approval: Approval):  # 依赖注入
        self._approval = approval

    async def __call__(self, params: MyParams) -> ToolReturnValue:
        # 实现逻辑
        return ToolOk(output="result")
```

### 添加新 Agent

1. 创建目录 `agents/my_agent/`
2. 创建 `agent.yaml`（可继承 `default`）
3. 创建 `system.md`（系统提示）

```yaml
version: 1
agent:
  extend: default
  name: my_agent
  system_prompt_path: ./system.md
  tools:
    - "my_module:MyTool"
```

### 添加动态子代理

在 LLM 对话中调用 `CreateSubagent`：

```
CreateSubagent(
    name="specialist",
    system_prompt="You are a specialist in..."
)
```

然后通过 `Task` 调用：

```
Task(
    subagent_name="specialist",
    description="执行专业任务",
    prompt="..."
)
```
