# 第 3 章：最简单的 Agent

现在我们已经理解了核心概念，是时候动手构建第一个 Agent 了！

在这一章，我们将从零开始，构建一个**最简单但完整**的 Agent。它将包含：

- ✅ 命令行界面（CLI）
- ✅ LLM 集成
- ✅ 基础的对话循环
- ✅ 一个简单的工具

## 3.1 项目结构

让我们创建一个新项目：

```bash
mkdir minimal-agent
cd minimal-agent

# 创建目录结构
mkdir -p src/minimal_agent
touch src/minimal_agent/__init__.py
touch src/minimal_agent/cli.py
touch src/minimal_agent/agent.py
touch src/minimal_agent/tools.py
```

最终结构：

```
minimal-agent/
├── src/
│   └── minimal_agent/
│       ├── __init__.py
│       ├── cli.py       # CLI 入口
│       ├── agent.py     # Agent 核心逻辑
│       └── tools.py     # 工具定义
├── pyproject.toml       # 项目配置
└── README.md
```

## 3.2 依赖安装

创建 `pyproject.toml`：

```toml
[project]
name = "minimal-agent"
version = "0.1.0"
description = "A minimal coding agent"
requires-python = ">=3.10"
dependencies = [
    "openai>=1.0.0",        # LLM 客户端
    "pydantic>=2.0.0",      # 数据验证
    "rich>=13.0.0",         # 终端美化
    "typer>=0.9.0",         # CLI 框架
]

[project.scripts]
minimal-agent = "minimal_agent.cli:main"

[build-system]
requires = ["setuptools>=61.0"]
build-backend = "setuptools.build_meta"
```

安装依赖：

```bash
pip install -e .
```

## 3.3 实现第一个工具

**`src/minimal_agent/tools.py`**

```python
"""工具定义"""

from datetime import datetime
from pydantic import BaseModel, Field


class GetTimeParams(BaseModel):
    """获取时间工具的参数"""
    # 这个工具不需要参数，但我们仍然定义一个空的 Params 类
    pass


class GetTimeTool:
    """获取当前时间的工具"""

    # 工具元数据
    name = "get_current_time"
    description = "获取当前系统时间，格式为 YYYY-MM-DD HH:MM:SS"

    # 参数 schema（用于告诉 LLM 这个工具需要什么参数）
    @staticmethod
    def get_schema() -> dict:
        """返回 OpenAI Function Calling 格式的 schema"""
        return {
            "type": "function",
            "function": {
                "name": "get_current_time",
                "description": "获取当前系统时间",
                "parameters": {
                    "type": "object",
                    "properties": {},  # 没有参数
                    "required": []
                }
            }
        }

    async def execute(self, params: dict) -> str:
        """执行工具"""
        now = datetime.now()
        return now.strftime("%Y-%m-%d %H:%M:%S")


class CalculatorParams(BaseModel):
    """计算器参数"""
    expression: str = Field(description="要计算的数学表达式，如 '2 + 2'")


class CalculatorTool:
    """简单的计算器工具"""

    name = "calculator"
    description = "计算数学表达式的结果，支持 +、-、*、/ 等基本运算"

    @staticmethod
    def get_schema() -> dict:
        return {
            "type": "function",
            "function": {
                "name": "calculator",
                "description": "计算数学表达式",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "expression": {
                            "type": "string",
                            "description": "要计算的表达式"
                        }
                    },
                    "required": ["expression"]
                }
            }
        }

    async def execute(self, params: dict) -> str:
        """执行计算"""
        try:
            expression = params["expression"]
            # 警告：在生产环境中不要这样做！这里仅作演示
            result = eval(expression)
            return f"{expression} = {result}"
        except Exception as e:
            return f"计算错误: {str(e)}"


# 工具注册表
TOOLS = {
    "get_current_time": GetTimeTool(),
    "calculator": CalculatorTool(),
}
```

> ⚠️ **安全警告**：这里的 `eval()` 仅用于演示。在生产环境中，应该使用安全的表达式解析器。

## 3.4 实现 Agent 核心

**`src/minimal_agent/agent.py`**

```python
"""Agent 核心逻辑"""

import json
from typing import Any
from openai import AsyncOpenAI
from rich.console import Console

from .tools import TOOLS

console = Console()


class MinimalAgent:
    """最简单的 Agent 实现"""

    def __init__(self, api_key: str, model: str = "gpt-4"):
        """初始化 Agent"""
        self.client = AsyncOpenAI(api_key=api_key)
        self.model = model

        # 上下文（消息历史）
        self.messages = [
            {
                "role": "system",
                "content": self._get_system_prompt()
            }
        ]

        # 工具 schemas（传给 LLM）
        self.tool_schemas = [
            tool.get_schema() for tool in TOOLS.values()
        ]

    def _get_system_prompt(self) -> str:
        """生成系统提示词"""
        return """你是一个有用的 AI 助手。

你可以使用以下工具来帮助用户：
- get_current_time: 获取当前时间
- calculator: 计算数学表达式

请根据用户的需求，选择合适的工具来完成任务。
"""

    async def run(self, user_input: str) -> str:
        """运行 Agent，处理用户输入"""

        # 1. 添加用户消息
        self.messages.append({
            "role": "user",
            "content": user_input
        })

        # 2. 主循环
        max_iterations = 10  # 防止无限循环

        for iteration in range(max_iterations):
            console.print(f"[dim]迭代 {iteration + 1}...[/dim]")

            # 3. 调用 LLM
            response = await self.client.chat.completions.create(
                model=self.model,
                messages=self.messages,
                tools=self.tool_schemas,
                tool_choice="auto"  # 让 LLM 自己决定是否使用工具
            )

            assistant_message = response.choices[0].message

            # 4. 检查是否有工具调用
            if assistant_message.tool_calls:
                console.print(f"[yellow]🔧 Agent 想要调用 {len(assistant_message.tool_calls)} 个工具[/yellow]")

                # 添加 assistant 消息（包含工具调用）
                self.messages.append(assistant_message.model_dump())

                # 5. 执行所有工具调用
                for tool_call in assistant_message.tool_calls:
                    await self._execute_tool_call(tool_call)

                # 6. 继续循环，让 LLM 看到工具结果
                continue

            else:
                # 7. 没有工具调用，任务完成
                final_response = assistant_message.content or ""

                # 添加到历史
                self.messages.append({
                    "role": "assistant",
                    "content": final_response
                })

                return final_response

        return "达到最大迭代次数，任务可能未完成。"

    async def _execute_tool_call(self, tool_call: Any) -> None:
        """执行单个工具调用"""
        tool_name = tool_call.function.name
        tool_args = json.loads(tool_call.function.arguments)

        console.print(f"  [cyan]→ 调用工具:[/cyan] {tool_name}")
        console.print(f"  [dim]  参数: {tool_args}[/dim]")

        # 查找工具
        if tool_name not in TOOLS:
            result = f"错误：工具 '{tool_name}' 不存在"
        else:
            # 执行工具
            tool = TOOLS[tool_name]
            try:
                result = await tool.execute(tool_args)
                console.print(f"  [green]✓ 结果:[/green] {result}")
            except Exception as e:
                result = f"工具执行错误: {str(e)}"
                console.print(f"  [red]✗ 错误:[/red] {result}")

        # 添加工具结果到消息历史
        self.messages.append({
            "role": "tool",
            "tool_call_id": tool_call.id,
            "content": result
        })

    def show_history(self) -> None:
        """显示对话历史（调试用）"""
        console.print("\n[bold]对话历史：[/bold]")
        for i, msg in enumerate(self.messages):
            role = msg["role"]
            if role == "system":
                console.print(f"{i}. [blue]SYSTEM[/blue]: {msg['content'][:50]}...")
            elif role == "user":
                console.print(f"{i}. [green]USER[/green]: {msg['content']}")
            elif role == "assistant":
                if msg.get("tool_calls"):
                    console.print(f"{i}. [yellow]ASSISTANT[/yellow]: [tool calls]")
                else:
                    console.print(f"{i}. [yellow]ASSISTANT[/yellow]: {msg['content']}")
            elif role == "tool":
                console.print(f"{i}. [cyan]TOOL[/cyan]: {msg['content'][:50]}...")
```

## 3.5 实现 CLI 界面

**`src/minimal_agent/cli.py`**

```python
"""命令行界面"""

import asyncio
import os
from pathlib import Path
import typer
from rich.console import Console
from rich.prompt import Prompt

from .agent import MinimalAgent

app = typer.Typer()
console = Console()


@app.command()
def main(
    api_key: str = typer.Option(
        None,
        "--api-key",
        envvar="OPENAI_API_KEY",
        help="OpenAI API Key"
    ),
    model: str = typer.Option(
        "gpt-4",
        "--model",
        help="使用的模型"
    ),
):
    """最简单的 Coding Agent"""

    # 检查 API Key
    if not api_key:
        console.print("[red]错误：请设置 OPENAI_API_KEY 环境变量或使用 --api-key[/red]")
        raise typer.Exit(1)

    console.print("[bold green]欢迎使用 Minimal Agent！[/bold green]")
    console.print(f"使用模型: [cyan]{model}[/cyan]")
    console.print("输入 'quit' 退出\n")

    # 创建 Agent
    agent = MinimalAgent(api_key=api_key, model=model)

    # 交互循环
    while True:
        try:
            # 获取用户输入
            user_input = Prompt.ask("[bold blue]You[/bold blue]")

            if user_input.lower() in ["quit", "exit", "q"]:
                console.print("[yellow]再见！[/yellow]")
                break

            if user_input.lower() == "history":
                agent.show_history()
                continue

            if not user_input.strip():
                continue

            # 运行 Agent
            console.print()
            response = asyncio.run(agent.run(user_input))

            # 显示回复
            console.print(f"\n[bold yellow]Agent[/bold yellow]: {response}\n")

        except KeyboardInterrupt:
            console.print("\n[yellow]已中断[/yellow]")
            break
        except Exception as e:
            console.print(f"[red]错误: {e}[/red]")


if __name__ == "__main__":
    app()
```

## 3.6 运行你的第一个 Agent！

设置 API Key：

```bash
export OPENAI_API_KEY="sk-..."
```

运行 Agent：

```bash
python -m minimal_agent.cli
```

或者安装后直接使用：

```bash
minimal-agent
```

### 示例对话

```
欢迎使用 Minimal Agent！
使用模型: gpt-4
输入 'quit' 退出

You: 现在几点了？

迭代 1...
🔧 Agent 想要调用 1 个工具
  → 调用工具: get_current_time
    参数: {}
  ✓ 结果: 2025-01-15 14:30:00
迭代 2...

Agent: 现在是 2025 年 1 月 15 日 14:30:00

You: 帮我计算 123 * 456

迭代 1...
🔧 Agent 想要调用 1 个工具
  → 调用工具: calculator
    参数: {'expression': '123 * 456'}
  ✓ 结果: 123 * 456 = 56088
迭代 2...

Agent: 123 * 456 = 56088
```

## 3.7 代码解析

让我们理解这个 Agent 的工作流程：

### 1. 初始化

```python
agent = MinimalAgent(api_key="...", model="gpt-4")
```

- 创建 OpenAI 客户端
- 初始化消息列表（包含系统提示词）
- 准备工具 schemas

### 2. 用户输入

```python
await agent.run("现在几点了？")
```

- 将用户消息添加到 `messages`

### 3. 主循环

```python
for iteration in range(max_iterations):
    response = await client.chat.completions.create(...)

    if assistant_message.tool_calls:
        # 执行工具
        # 继续循环
    else:
        # 返回最终回复
        return final_response
```

### 4. 工具执行

```python
tool = TOOLS[tool_name]
result = await tool.execute(tool_args)

messages.append({
    "role": "tool",
    "tool_call_id": tool_call.id,
    "content": result
})
```

### 5. 消息流

```
1. [system] 你是一个有用的 AI 助手...
2. [user] 现在几点了？
3. [assistant] [tool_call: get_current_time]
4. [tool] 2025-01-15 14:30:00
5. [assistant] 现在是 2025 年 1 月 15 日 14:30:00
```

## 3.8 改进和扩展

这个 Agent 虽然简单，但已经具备了核心功能。你可以：

### 添加更多工具

```python
class ReadFileTool:
    """读取文件工具"""
    name = "read_file"
    description = "读取指定文件的内容"

    @staticmethod
    def get_schema() -> dict:
        return {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "读取文件内容",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "文件路径"
                        }
                    },
                    "required": ["path"]
                }
            }
        }

    async def execute(self, params: dict) -> str:
        path = params["path"]
        with open(path) as f:
            return f.read()
```

### 持久化对话历史

```python
def save_history(self, path: str):
    """保存对话历史"""
    import json
    with open(path, 'w') as f:
        json.dump(self.messages, f, indent=2)

def load_history(self, path: str):
    """加载对话历史"""
    import json
    with open(path) as f:
        self.messages = json.load(f)
```

### 添加流式输出

```python
response = await self.client.chat.completions.create(
    model=self.model,
    messages=self.messages,
    tools=self.tool_schemas,
    stream=True  # 启用流式
)

async for chunk in response:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

## 3.9 小结

恭喜！你已经构建了第一个 Coding Agent！🎉

这个 Agent 虽然简单，但包含了所有核心组件：

- ✅ CLI 交互界面
- ✅ LLM 集成（OpenAI）
- ✅ 工具系统（时间、计算器）
- ✅ 主执行循环
- ✅ 上下文管理（消息历史）

**关键收获**：

1. Agent = LLM + Tools + Loop
2. 工具通过 Function Calling 与 LLM 集成
3. 消息历史是 Agent 的"记忆"
4. 主循环不断调用 LLM 直到任务完成

在下一章，我们将深入工具系统，学习如何设计更灵活的工具架构。

## 练习题

1. 添加一个新工具：`weather_tool`，返回天气信息（可以mock数据）
2. 实现对话历史的保存和加载功能
3. 添加流式输出，让 Agent 的回复逐字显示
4. 实现错误重试：如果工具执行失败，让 Agent 自动重试

---

**下一章**：[第 4 章：工具系统设计](./04-tool-system.md) →
