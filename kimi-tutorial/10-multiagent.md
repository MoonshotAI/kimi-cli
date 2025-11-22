# 第 10 章：多代理系统

到目前为止，我们构建的都是单个 Agent。但在实际应用中，复杂任务往往需要多个专门的 Agent 协作完成。

在本章，我们将学习如何构建**多代理系统（Multi-Agent System）**，这是 kimi-cli 最强大的特性之一。

## 10.1 为什么需要多代理？

### 单一 Agent 的局限

```
用户: "帮我重构这个项目，改进代码质量，然后写测试，最后生成文档"

单一 Agent:
  - 需要在一个上下文中处理所有任务
  - 上下文窗口容易溢出
  - 缺乏专业性（一个 Agent 做所有事）
  - 难以并行处理
```

### 多代理的优势

```
主 Agent (Orchestrator):
  ├─> 代码重构 Agent (专精: Python 重构)
  ├─> 测试生成 Agent (专精: pytest)
  └─> 文档生成 Agent (专精: 技术写作)

优势:
  ✅ 每个 Agent 专注于特定领域
  ✅ 独立的上下文，避免混淆
  ✅ 可以并行执行
  ✅ 可复用（组合不同的子 Agent）
```

## 10.2 多代理架构

### 层次结构

```
┌─────────────────────────────────────────┐
│         主 Agent (Main Agent)            │
│                                         │
│  - 理解用户需求                          │
│  - 任务分解                             │
│  - 委派给子 Agent                       │
│  - 整合结果                             │
└────────┬────────────────────────────────┘
         │
         ├───> 子 Agent 1 (Subagent)
         │     - 专门领域
         │     - 独立上下文
         │     - 独立工具集
         │
         ├───> 子 Agent 2
         │
         └───> 子 Agent 3
```

### Agent 规范

```yaml
# main-agent.yaml
version: 1
agent:
  name: "main-agent"
  system_prompt_path: ./system.md
  tools:
    - "tools.file:ReadFile"
    - "tools.task:TaskTool"  # 委派工具

  # 定义子 Agent
  subagents:
    coder:
      path: ./agents/coder.yaml
      description: "擅长 Python 编程，代码重构和优化"

    tester:
      path: ./agents/tester.yaml
      description: "擅长编写单元测试和集成测试"

    documenter:
      path: ./agents/documenter.yaml
      description: "擅长编写技术文档和 README"
```

```yaml
# agents/coder.yaml
version: 1
agent:
  name: "coder"
  system_prompt_path: ./coder-system.md
  tools:
    - "tools.file:ReadFile"
    - "tools.file:WriteFile"
    - "tools.shell:Shell"
```

## 10.3 实现 Task 工具

`Task` 工具是多代理的核心，用于将任务委派给子 Agent。

### Task 工具定义

```python
# tools/task.py

from pydantic import BaseModel, Field
from typing import Dict
from .base import BaseTool
from .result import ToolSuccess, ToolError, ToolResult
from agent import Agent  # 我们的 Agent 类


class TaskParams(BaseModel):
    """Task 工具参数"""
    agent: str = Field(description="子 Agent 名称（如 'coder', 'tester'）")
    task: str = Field(description="要委派的任务描述")


class TaskTool(BaseTool[TaskParams]):
    """将任务委派给子 Agent 的工具"""

    name = "task"
    description = """将任务委派给专门的子 Agent。

    可用的子 Agent：
    - coder: 擅长 Python 编程，代码重构和优化
    - tester: 擅长编写单元测试和集成测试
    - documenter: 擅长编写技术文档和 README

    使用这个工具来处理需要专门技能的复杂任务。
    """

    def __init__(self, subagents: Dict[str, Agent], **kwargs):
        """初始化

        Args:
            subagents: 子 Agent 字典 {name: agent_instance}
        """
        super().__init__(**kwargs)
        self._subagents = subagents

    async def execute(self, params: TaskParams) -> ToolResult:
        """执行任务委派"""

        # 1. 查找子 Agent
        if params.agent not in self._subagents:
            available = ", ".join(self._subagents.keys())
            return ToolError(
                message=f"未知的子 Agent: {params.agent}",
                details=f"可用的子 Agent: {available}"
            )

        subagent = self._subagents[params.agent]

        # 2. 运行子 Agent
        try:
            result = await subagent.run(params.task)

            return ToolSuccess(
                output=f"=== {params.agent} 的结果 ===\n{result}"
            )

        except Exception as e:
            return ToolError(
                message=f"子 Agent 执行失败: {params.agent}",
                details=str(e)
            )
```

### Agent 类改进

为了支持子 Agent，我们需要改进 `Agent` 类：

```python
# agent.py

from typing import Dict, Optional
from openai import AsyncOpenAI
from tools.registry import ToolRegistry
from tools.task import TaskTool


class Agent:
    """Agent 实现（支持子 Agent）"""

    def __init__(
        self,
        name: str,
        system_prompt: str,
        registry: ToolRegistry,
        llm_client: AsyncOpenAI,
        model: str,
        subagents: Optional[Dict[str, "Agent"]] = None
    ):
        """初始化 Agent

        Args:
            name: Agent 名称
            system_prompt: 系统提示词
            registry: 工具注册表
            llm_client: LLM 客户端
            model: 模型名称
            subagents: 子 Agent 字典
        """
        self.name = name
        self.system_prompt = system_prompt
        self.registry = registry
        self.client = llm_client
        self.model = model
        self.subagents = subagents or {}

        # 如果有子 Agent，注册 Task 工具
        if self.subagents:
            task_tool = TaskTool(subagents=self.subagents)
            self.registry.register(task_tool)

        # 初始化消息
        self.messages = [
            {"role": "system", "content": system_prompt}
        ]

    async def run(self, user_input: str) -> str:
        """运行 Agent"""
        # ... (与之前相同的主循环逻辑)
        pass
```

## 10.4 从配置加载 Agent

### Agent 加载器

```python
# agent_loader.py

import yaml
from pathlib import Path
from typing import Dict
from openai import AsyncOpenAI
from agent import Agent
from tools.registry import ToolRegistry
from tools.loader import load_tool_class


def load_agent(
    config_path: Path,
    llm_client: AsyncOpenAI,
    model: str,
    dependencies: dict
) -> Agent:
    """从配置文件加载 Agent

    Args:
        config_path: Agent 配置文件路径
        llm_client: LLM 客户端
        model: 模型名称
        dependencies: 工具依赖

    Returns:
        Agent 实例
    """
    # 1. 加载配置
    with open(config_path) as f:
        config = yaml.safe_load(f)

    agent_config = config["agent"]
    agent_name = agent_config["name"]

    # 2. 加载系统提示词
    prompt_path = config_path.parent / agent_config["system_prompt_path"]
    with open(prompt_path) as f:
        system_prompt = f.read()

    # 3. 创建工具注册表
    registry = ToolRegistry()

    # 加载工具（不包括 Task，稍后添加）
    for tool_path in agent_config.get("tools", []):
        if "TaskTool" in tool_path:
            continue  # 跳过，稍后处理

        tool_class = load_tool_class(tool_path)
        tool_instance = tool_class(**dependencies)
        registry.register(tool_instance)

    # 4. 递归加载子 Agent
    subagents: Dict[str, Agent] = {}

    for sub_name, sub_config in agent_config.get("subagents", {}).items():
        sub_path = config_path.parent / sub_config["path"]

        # 递归加载
        subagent = load_agent(
            config_path=sub_path,
            llm_client=llm_client,
            model=model,
            dependencies=dependencies
        )

        subagents[sub_name] = subagent

    # 5. 创建 Agent
    agent = Agent(
        name=agent_name,
        system_prompt=system_prompt,
        registry=registry,
        llm_client=llm_client,
        model=model,
        subagents=subagents
    )

    return agent
```

### 使用示例

```python
# main.py

from pathlib import Path
from openai import AsyncOpenAI
from agent_loader import load_agent
from core.dependencies import Config

# 创建依赖
config = Config(work_dir=Path.cwd(), ...)
dependencies = {"config": config}

# 加载主 Agent（自动加载所有子 Agent）
client = AsyncOpenAI()
main_agent = load_agent(
    config_path=Path("agents/main-agent.yaml"),
    llm_client=client,
    model="gpt-4",
    dependencies=dependencies
)

# 运行
result = await main_agent.run("重构 src/utils.py 并添加测试")
```

## 10.5 实战：代码审查系统

让我们构建一个完整的代码审查多代理系统。

### 1. 主 Agent 配置

```yaml
# agents/reviewer/agent.yaml
version: 1
agent:
  name: "code-reviewer"
  system_prompt_path: ./system.md
  tools:
    - "tools.file:ReadFile"
    - "tools.file:WriteFile"
    - "tools.task:TaskTool"

  subagents:
    security:
      path: ../security/agent.yaml
      description: "安全专家，检查潜在的安全漏洞"

    performance:
      path: ../performance/agent.yaml
      description: "性能专家，分析性能瓶颈"

    style:
      path: ../style/agent.yaml
      description: "代码风格专家，检查代码规范"
```

### 2. 主 Agent 系统提示词

```markdown
# agents/reviewer/system.md

你是一个代码审查协调器。

当用户请求代码审查时，你应该：

1. 读取要审查的代码文件
2. 将代码分发给专门的子 Agent 进行审查：
   - `security`: 安全审查
   - `performance`: 性能分析
   - `style`: 代码风格检查
3. 整合所有子 Agent 的反馈
4. 生成综合的审查报告

## 示例

用户: "审查 src/auth.py"

你的行动:
1. 使用 read_file 读取 src/auth.py
2. 使用 task(agent="security", task="审查这段认证代码的安全性: [代码]")
3. 使用 task(agent="performance", task="分析这段代码的性能: [代码]")
4. 使用 task(agent="style", task="检查这段代码的风格: [代码]")
5. 整合反馈，生成报告
```

### 3. 安全 Agent

```yaml
# agents/security/agent.yaml
version: 1
agent:
  name: "security-expert"
  system_prompt_path: ./system.md
  tools: []  # 只需要分析，不需要工具
```

```markdown
# agents/security/system.md

你是一个安全审查专家。

专注于检查：
- SQL 注入
- XSS 漏洞
- CSRF 漏洞
- 认证和授权问题
- 敏感信息泄露
- 加密问题

对于每个问题，提供：
1. 严重程度（高/中/低）
2. 问题描述
3. 修复建议
4. 示例代码
```

### 4. 运行示例

```
用户: 审查 src/auth.py

主 Agent:
  ├─ [读取文件] src/auth.py
  │
  ├─ [委派] → 安全 Agent
  │   └─ 发现: SQL 注入风险（高）
  │
  ├─ [委派] → 性能 Agent
  │   └─ 发现: N+1 查询问题（中）
  │
  └─ [委派] → 风格 Agent
      └─ 发现: 缺少类型提示（低）

主 Agent 整合报告:

# 代码审查报告: src/auth.py

## 🔴 高危问题

### SQL 注入风险
**位置**: 第 42 行
**问题**: 直接拼接 SQL 查询
**建议**: 使用参数化查询

\`\`\`python
# 修改前
query = f"SELECT * FROM users WHERE id = {user_id}"

# 修改后
query = "SELECT * FROM users WHERE id = ?"
cursor.execute(query, (user_id,))
\`\`\`

## 🟡 中等问题

### N+1 查询
...

## 🟢 低优先级

### 代码风格
...
```

## 10.6 并行执行子 Agent

目前我们是串行执行子 Agent，可以改进为并行：

```python
import asyncio
from typing import List, Tuple

async def execute_parallel_tasks(
    subagents: Dict[str, Agent],
    tasks: List[Tuple[str, str]]  # [(agent_name, task_description), ...]
) -> List[str]:
    """并行执行多个子 Agent 任务

    Args:
        subagents: 子 Agent 字典
        tasks: 任务列表

    Returns:
        结果列表（顺序与 tasks 相同）
    """
    async def run_task(agent_name: str, task: str) -> str:
        """运行单个任务"""
        agent = subagents[agent_name]
        return await agent.run(task)

    # 创建并发任务
    coroutines = [
        run_task(agent_name, task)
        for agent_name, task in tasks
    ]

    # 并行执行
    results = await asyncio.gather(*coroutines)

    return results
```

在主 Agent 中使用：

```python
# 并行执行三个子 Agent
tasks = [
    ("security", f"审查安全性:\n{code}"),
    ("performance", f"分析性能:\n{code}"),
    ("style", f"检查风格:\n{code}")
]

results = await execute_parallel_tasks(self.subagents, tasks)

security_report = results[0]
performance_report = results[1]
style_report = results[2]
```

## 10.7 Kimi-CLI 的多代理实现

在 kimi-cli 中，多代理系统更加完善：

### LaborMarket（劳动市场）

```python
# kimi_cli/soul/labor_market.py

class LaborMarket:
    """子 Agent 注册表"""

    def __init__(self):
        self._agents: Dict[str, Agent] = {}

    def register(self, name: str, agent: Agent):
        """注册子 Agent"""
        self._agents[name] = agent

    def hire(self, name: str) -> Agent:
        """雇佣（获取）子 Agent"""
        return self._agents.get(name)
```

### Task 工具

```python
# kimi_cli/tools/multiagent.py

class Task(CallableTool2[TaskParams]):
    """委派任务给子 Agent"""

    def __init__(
        self,
        labor_market: LaborMarket,
        runtime: Runtime,
        **kwargs
    ):
        super().__init__(**kwargs)
        self._labor_market = labor_market
        self._runtime = runtime

    async def __call__(self, params: TaskParams) -> ToolReturnType:
        # 1. 从劳动市场雇佣 Agent
        subagent = self._labor_market.hire(params.agent)

        # 2. 克隆 Runtime（独立上下文）
        sub_runtime = self._runtime.clone()

        # 3. 创建子 Soul
        sub_soul = KimiSoul(agent=subagent, runtime=sub_runtime)

        # 4. 运行
        result = await sub_soul.run(params.task)

        return ToolOk(output=result)
```

## 10.8 最佳实践

### 1. 子 Agent 的粒度

```python
# ❌ 太细：每个函数一个 Agent
subagents:
  add_function: ...
  subtract_function: ...

# ✅ 合适：按功能领域划分
subagents:
  coder: ...      # 编写代码
  tester: ...     # 编写测试
  reviewer: ...   # 代码审查
```

### 2. 避免循环委派

```yaml
# ❌ 危险：A → B → A
agent-a:
  subagents:
    b: agent-b.yaml

agent-b:
  subagents:
    a: agent-a.yaml  # 循环！
```

### 3. 限制委派深度

```python
class Agent:
    def __init__(self, max_depth: int = 3):
        self.max_depth = max_depth
        self.current_depth = 0

    async def run(self, task: str) -> str:
        if self.current_depth >= self.max_depth:
            raise MaxDepthExceeded("委派层级过深")

        self.current_depth += 1
        try:
            result = await self._run_impl(task)
        finally:
            self.current_depth -= 1

        return result
```

### 4. 子 Agent 的上下文隔离

每个子 Agent 应该有独立的上下文，避免污染父 Agent 的上下文。

## 10.9 小结

在本章，我们学习了多代理系统：

- ✅ **多代理的优势**：专业化、上下文隔离、可并行
- ✅ **Task 工具**：委派任务给子 Agent
- ✅ **配置化**：通过 YAML 定义 Agent 层次
- ✅ **动态加载**：递归加载子 Agent
- ✅ **并行执行**：同时运行多个子 Agent
- ✅ **实战案例**：代码审查系统

多代理系统是构建复杂 AI 应用的关键技术，它让我们能够：

- 将复杂任务分解为多个简单任务
- 让每个 Agent 专注于特定领域
- 通过组合创建灵活的工作流

## 思考题

1. 如何实现子 Agent 之间的通信（而不是通过主 Agent）？
2. 如果两个子 Agent 需要共享某些状态怎么办？
3. 如何监控和调试多代理系统的执行流程？

---

**下一章**：[第 11 章：时间旅行](./11-time-travel.md) →
