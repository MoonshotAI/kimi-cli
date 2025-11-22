# Kimi CLI 从零开始完全掌握指南

## 目录

1. [项目概览](#1-项目概览)
2. [环境准备](#2-环境准备)
3. [核心概念理解](#3-核心概念理解)
4. [代码结构深度解析](#4-代码结构深度解析)
5. [从零构建 Coding Agent 的核心技术](#5-从零构建-coding-agent-的核心技术)
6. [实战：动手修改和扩展](#6-实战动手修改和扩展)
7. [高级主题](#7-高级主题)
8. [最佳实践](#8-最佳实践)

---

## 1. 项目概览

### 1.1 Kimi CLI 是什么？

Kimi CLI 是 Moonshot AI 开发的**交互式命令行 AI Agent**，专注于软件工程任务。它不仅仅是一个简单的聊天机器人，而是一个能够：

- 执行 Shell 命令
- 读写文件
- 搜索代码
- 调用 Web API
- 委派任务给子 Agent
- 管理会话历史

的**完整 Agent 系统**。

### 1.2 技术特点

| 特性 | 说明 |
|------|------|
| **语言** | Python 3.13+ |
| **架构模式** | 模块化、插件式、事件驱动 |
| **异步** | 全面使用 async/await |
| **可扩展性** | 支持自定义工具、Agent、LLM 提供商 |
| **协议支持** | ACP、MCP、Wire（实验性） |
| **UI 模式** | Shell（交互式）、Print（非交互）、ACP（IDE 集成） |

### 1.3 核心数据

- **代码量**：~2500 行 Python 代码
- **文件数**：76 个 Python 文件
- **测试覆盖**：30+ 测试文件
- **当前版本**：0.58

---

## 2. 环境准备

### 2.1 安装依赖

```bash
# 1. 安装 uv（现代 Python 包管理器）
curl -LsSf https://astral.sh/uv/install.sh | sh

# 2. 克隆仓库
git clone https://github.com/MoonshotAI/kimi-cli.git
cd kimi-cli

# 3. 安装依赖
make prepare  # 等同于 uv sync --frozen
```

### 2.2 验证安装

```bash
# 运行 Kimi CLI
uv run kimi --help

# 运行测试
make test

# 代码检查
make check
```

### 2.3 IDE 配置（推荐 VS Code）

安装以下扩展：
- Python
- Pylance
- Ruff

`.vscode/settings.json`:
```json
{
  "python.languageServer": "Pylance",
  "python.analysis.typeCheckingMode": "basic",
  "[python]": {
    "editor.defaultFormatter": "charliermarsh.ruff",
    "editor.formatOnSave": true
  }
}
```

---

## 3. 核心概念理解

### 3.1 什么是 Coding Agent？

Coding Agent 是一个能够理解编程任务、自主规划、调用工具、执行代码的 AI 系统。

**核心组成部分**：

```
┌─────────────────────────────────────────┐
│          1. LLM（大语言模型）             │
│     负责理解任务、推理、生成响应           │
└─────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────┐
│       2. Agent 执行引擎（Soul）           │
│     管理对话流程、工具调用、错误处理        │
└─────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────┐
│         3. 工具系统（Tools）              │
│   Shell、文件操作、Web、子 Agent 等        │
└─────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────┐
│         4. 用户界面（UI）                 │
│      Shell、Print、ACP 等多种模式          │
└─────────────────────────────────────────┘
```

### 3.2 Agent 工作流程

```
用户输入
   ↓
添加到上下文（Context）
   ↓
调用 LLM（带系统提示词 + 历史 + 工具定义）
   ↓
LLM 返回响应
   ├─ 纯文本 → 显示给用户 → 结束
   └─ 工具调用 → 用户审批 → 执行工具 → 收集结果 → 继续循环
```

### 3.3 关键设计模式

#### 3.3.1 依赖注入

工具不直接导入依赖，而是通过 `Runtime` 注入：

```python
class ReadFile(Tool):
    async def _prepare(self, runtime: Runtime) -> None:
        self.kaos = runtime.kaos  # 注入文件系统抽象
        self.work_dir = runtime.work_dir
```

#### 3.3.2 协议驱动

定义清晰的接口协议：

```python
# KAOS 协议（文件系统抽象）
async def readtext(path: str) -> str: ...
async def writetext(path: str, content: str) -> None: ...

# Tool 协议
class Tool:
    async def _prepare(self, runtime: Runtime) -> None: ...
    async def _execute(self, **params) -> Any: ...
```

#### 3.3.3 事件驱动

使用观察者模式处理事件：

```python
# 工具执行事件
self._emit(EventType.ToolCallDone, result)

# UI 监听事件
async def _on_text_delta(self, delta: str):
    self.console.print(delta, end="")
```

---

## 4. 代码结构深度解析

### 4.1 入口流程（从 `kimi` 命令开始）

#### 步骤 1: CLI 入口 (`cli.py:cli`)

```python
# src/kimi_cli/cli.py
@app.command()
def cli(
    model: str = typer.Option("kimi", "-m", "--model"),
    work_dir: Path = typer.Option(Path.cwd(), "-w", "--work-dir"),
    # ... 更多参数
):
    # 1. 加载配置
    config = load_config()

    # 2. 创建或恢复会话
    session = find_or_create_session(...)

    # 3. 初始化应用
    app = KimiCLI(...)

    # 4. 运行对应模式
    if print_mode:
        asyncio.run(app.run_print_mode(...))
    else:
        app.run_shell_mode()
```

**关键点**：
- 使用 `typer` 构建 CLI
- 支持命令行参数覆盖配置
- 会话管理（`--continue` 恢复上次会话）

#### 步骤 2: 应用初始化 (`app.py:KimiCLI`)

```python
# src/kimi_cli/app.py
class KimiCLI:
    def __init__(self, ...):
        # 1. 创建 LLM 实例
        self.llm = create_llm(provider, model, ...)

        # 2. 创建 Runtime（依赖注入容器）
        self.runtime = Runtime(
            kaos=LocalKaos(),  # 文件系统抽象
            work_dir=work_dir,
            llm=self.llm,
            ...
        )

        # 3. 加载 Agent 配置
        self.agent = load_agent(agent_spec, runtime)

        # 4. 连接 MCP 服务器（如果有）
        await self._connect_mcp_servers()

        # 5. 创建 Soul（执行引擎）
        self.soul = KimiSoul(
            agent=self.agent,
            context=self.context,
            runtime=self.runtime,
        )
```

**关键点**：
- `Runtime` 是依赖注入容器
- `Agent` 从 YAML 配置加载
- `Soul` 是核心执行引擎

#### 步骤 3: Soul 执行 (`soul/kimisoul.py`)

```python
# src/kimi_cli/soul/kimisoul.py
class KimiSoul:
    async def step(self, user_message: str = None) -> StepResult:
        # 1. 添加用户消息到上下文
        if user_message:
            self.context.add_user_message(user_message)

        # 2. 调用 LLM
        response = await self._call_llm_with_retry()

        # 3. 处理响应
        if response.tool_calls:
            # 执行工具调用
            results = await self._execute_tools(response.tool_calls)
            return StepResult(continue_loop=True)
        else:
            # 返回文本响应
            return StepResult(
                text=response.text,
                continue_loop=False
            )
```

**关键点**：
- `step()` 是 Agent 的一次迭代
- 支持工具调用的循环执行
- 使用 `tenacity` 实现重试机制

### 4.2 核心模块详解

#### 4.2.1 Agent 系统 (`agentspec.py` + `soul/agent.py`)

**Agent 配置文件** (`agents/default/agent.yaml`):

```yaml
version: 1
agent:
  name: "Kimi CLI Agent"
  system_prompt_path: ./system.md
  system_prompt_args:
    ROLE_ADDITIONAL: ""
  tools:
    - "kimi_cli.tools.shell:Shell"
    - "kimi_cli.tools.file:ReadFile"
    - "kimi_cli.tools.file:WriteFile"
    # ... 更多工具
  subagents:
    coder:
      path: ./sub.yaml
      description: "Good at general software engineering tasks."
```

**系统提示词** (`agents/default/system.md`):

```markdown
You are Kimi CLI, an AI coding assistant.

Current time: ${KIMI_NOW}
Working directory: ${KIMI_WORK_DIR}

Directory contents:
${KIMI_WORK_DIR_LS}

You have access to the following tools:
- Shell: Execute shell commands
- ReadFile: Read file contents
- ...
```

**加载过程**:

```python
def load_agent(spec_path: str, runtime: Runtime) -> Agent:
    # 1. 解析 YAML
    spec = AgentSpec.from_yaml(spec_path)

    # 2. 渲染系统提示词（替换变量）
    system_prompt = render_system_prompt(
        spec.system_prompt_path,
        spec.system_prompt_args,
        runtime,
    )

    # 3. 加载工具
    tools = []
    for tool_ref in spec.tools:
        tool_class = import_tool(tool_ref)
        tool = tool_class()
        await tool._prepare(runtime)  # 依赖注入
        tools.append(tool)

    # 4. 加载子 Agent
    subagents = load_subagents(spec.subagents, runtime)

    return Agent(
        name=spec.name,
        system_prompt=system_prompt,
        tools=tools,
        subagents=subagents,
    )
```

#### 4.2.2 工具系统 (`tools/`)

**工具接口**（基于 `kosong` 框架）:

```python
from kosong import Tool

class ReadFile(Tool):
    """工具必须继承 kosong.Tool"""

    # 1. 工具描述（Markdown 格式）
    @property
    def description(self) -> str:
        return """
        Read the contents of a file.

        Parameters:
        - file_path (str): Path to the file
        - offset (int): Starting line number
        - limit (int): Number of lines to read
        """

    # 2. 参数 Schema（JSON Schema）
    @property
    def parameters(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "file_path": {"type": "string"},
                "offset": {"type": "integer", "default": 0},
                "limit": {"type": "integer", "default": -1},
            },
            "required": ["file_path"],
        }

    # 3. 依赖注入（可选）
    async def _prepare(self, runtime: Runtime) -> None:
        self.kaos = runtime.kaos
        self.work_dir = runtime.work_dir

    # 4. 执行逻辑
    async def _execute(
        self,
        file_path: str,
        offset: int = 0,
        limit: int = -1,
    ) -> str:
        # 实现文件读取逻辑
        full_path = self.work_dir / file_path
        content = await self.kaos.readtext(full_path)

        # 处理行号限制
        lines = content.splitlines()
        if limit > 0:
            lines = lines[offset:offset+limit]

        # 格式化输出（带行号）
        return "\n".join(
            f"{i+1:>5} {line}"
            for i, line in enumerate(lines, start=offset)
        )
```

**工具调用流程**:

```
LLM 返回工具调用
   ↓
Soul 解析工具名称和参数
   ↓
Approval 系统检查（非 YOLO 模式）
   ↓
DenwaRenji 协调执行
   ↓
工具 _execute() 方法执行
   ↓
返回结果或错误
   ↓
结果添加到上下文
   ↓
继续下一轮 LLM 调用
```

**实战示例：创建新工具**

创建一个计算文件行数的工具：

```python
# src/kimi_cli/tools/file/count_lines.py
from kosong import Tool
from kimi_cli.soul.agent import Runtime

class CountLines(Tool):
    @property
    def description(self) -> str:
        return "Count the number of lines in a file."

    @property
    def parameters(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "Path to the file"},
            },
            "required": ["file_path"],
        }

    async def _prepare(self, runtime: Runtime) -> None:
        self.kaos = runtime.kaos
        self.work_dir = runtime.work_dir

    async def _execute(self, file_path: str) -> dict:
        full_path = self.work_dir / file_path
        content = await self.kaos.readtext(full_path)
        line_count = len(content.splitlines())

        return {
            "file_path": file_path,
            "line_count": line_count,
        }
```

然后在 Agent 配置中添加：

```yaml
tools:
  - "kimi_cli.tools.file:CountLines"
```

#### 4.2.3 KAOS 文件系统抽象 (`kaos/`)

**设计目的**：
- 统一本地和远程文件系统接口
- 为未来的沙箱环境做准备
- 简化测试（可以 Mock）

**核心接口**:

```python
# src/kaos/__init__.py

# Context variable（线程安全）
_kaos_instance: ContextVar[Kaos] = ContextVar("kaos")

# 异步文件操作
async def readtext(path: str | Path) -> str:
    kaos = _kaos_instance.get()
    return await kaos.readtext(path)

async def writetext(path: str | Path, content: str) -> None:
    kaos = _kaos_instance.get()
    await kaos.writetext(path, content)

async def exists(path: str | Path) -> bool:
    kaos = _kaos_instance.get()
    return await kaos.exists(path)

async def iterdir(path: str | Path) -> AsyncIterator[Path]:
    kaos = _kaos_instance.get()
    async for p in kaos.iterdir(path):
        yield p
```

**本地实现**:

```python
# src/kaos/local.py
class LocalKaos(Kaos):
    async def readtext(self, path: Path) -> str:
        async with aiofiles.open(path, "r") as f:
            return await f.read()

    async def writetext(self, path: Path, content: str) -> None:
        async with aiofiles.open(path, "w") as f:
            await f.write(content)

    async def exists(self, path: Path) -> bool:
        return path.exists()

    async def iterdir(self, path: Path) -> AsyncIterator[Path]:
        for item in path.iterdir():
            yield item
```

**使用示例**:

```python
import kaos

# 在 Runtime 中设置
kaos.set_kaos(LocalKaos())

# 在工具中使用
content = await kaos.readtext("/path/to/file")
await kaos.writetext("/path/to/file", "new content")

async for path in kaos.iterdir("/path/to/dir"):
    print(path)
```

#### 4.2.4 UI 系统 (`ui/`)

**Shell 模式** (`ui/shell/__init__.py`):

```python
class ShellApp:
    def __init__(self, soul: KimiSoul, ...):
        self.soul = soul
        self.session = PromptSession(
            completer=KimiCompleter(),  # 自动补全
            key_bindings=create_key_bindings(),  # 快捷键
            style=create_style(),  # 样式
        )

    def run(self):
        while True:
            try:
                # 获取用户输入
                user_input = self.session.prompt("> ")

                # 处理元命令
                if user_input.startswith("/"):
                    self._handle_meta_command(user_input)
                    continue

                # Agent 执行
                async for event in self.soul.step(user_input):
                    if event.type == EventType.TextDelta:
                        self.console.print(event.data, end="")
                    elif event.type == EventType.ToolCall:
                        self._display_tool_call(event.data)

            except KeyboardInterrupt:
                continue
            except EOFError:
                break
```

**关键特性**：
- 基于 `prompt-toolkit` 构建
- 支持 Ctrl-X 切换 Agent/Shell 模式
- 实时流式输出
- Markdown 渲染

**Print 模式** (`ui/print/__init__.py`):

```python
async def run_print_mode(
    soul: KimiSoul,
    user_message: str,
    output_format: str = "text",
):
    # 非交互模式，直接执行
    result = await soul.step(user_message)

    if output_format == "text":
        print(result.text)
    elif output_format == "stream-json":
        # 输出 JSON 格式（适合解析）
        print(json.dumps({
            "text": result.text,
            "tool_calls": result.tool_calls,
        }))
```

---

## 5. 从零构建 Coding Agent 的核心技术

### 5.1 核心技术栈

#### 5.1.1 LLM 集成（以 OpenAI 为例）

```python
from openai import AsyncOpenAI

class LLMProvider:
    def __init__(self, api_key: str, base_url: str):
        self.client = AsyncOpenAI(
            api_key=api_key,
            base_url=base_url,
        )

    async def chat(
        self,
        messages: list[dict],
        tools: list[dict] = None,
        model: str = "gpt-4",
    ) -> dict:
        response = await self.client.chat.completions.create(
            model=model,
            messages=messages,
            tools=tools,
            tool_choice="auto",  # 自动决定是否调用工具
        )

        message = response.choices[0].message

        return {
            "text": message.content,
            "tool_calls": [
                {
                    "id": tc.id,
                    "name": tc.function.name,
                    "parameters": json.loads(tc.function.arguments),
                }
                for tc in message.tool_calls or []
            ],
        }
```

#### 5.1.2 工具系统设计

**核心原则**：
1. **声明式**：工具通过 Schema 描述自己
2. **异步**：支持 IO 密集型操作
3. **隔离**：工具之间互不依赖
4. **可组合**：通过 Runtime 共享资源

**示例：Shell 工具**

```python
import asyncio
import subprocess

class ShellTool(Tool):
    @property
    def description(self) -> str:
        return """
        Execute a shell command and return the output.

        **WARNING**: Be careful with shell commands!
        """

    @property
    def parameters(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "command": {"type": "string"},
                "timeout": {"type": "integer", "default": 30},
            },
            "required": ["command"],
        }

    async def _execute(self, command: str, timeout: int = 30) -> dict:
        try:
            process = await asyncio.create_subprocess_shell(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )

            stdout, stderr = await asyncio.wait_for(
                process.communicate(),
                timeout=timeout,
            )

            return {
                "stdout": stdout.decode(),
                "stderr": stderr.decode(),
                "exit_code": process.returncode,
            }
        except asyncio.TimeoutError:
            process.kill()
            raise ToolExecutionError(f"Command timed out after {timeout}s")
```

#### 5.1.3 上下文管理

**设计要点**：
- 管理对话历史
- 压缩长上下文
- 持久化会话

```python
class Context:
    def __init__(self, max_tokens: int = 100000):
        self.messages: list[dict] = []
        self.max_tokens = max_tokens

    def add_user_message(self, text: str):
        self.messages.append({
            "role": "user",
            "content": text,
        })

    def add_assistant_message(self, text: str, tool_calls: list = None):
        self.messages.append({
            "role": "assistant",
            "content": text,
            "tool_calls": tool_calls,
        })

    def add_tool_result(self, tool_call_id: str, result: str):
        self.messages.append({
            "role": "tool",
            "tool_call_id": tool_call_id,
            "content": result,
        })

    async def compact_if_needed(self, llm: LLMProvider):
        # 估算 token 数量
        total_tokens = self._estimate_tokens()

        if total_tokens > self.max_tokens * 0.8:
            # 压缩历史
            compressed = await self._compress_history(llm)
            self.messages = [
                self.messages[0],  # 保留系统消息
                {"role": "system", "content": f"Previous context: {compressed}"},
                *self.messages[-10:],  # 保留最近 10 条
            ]

    async def _compress_history(self, llm: LLMProvider) -> str:
        # 调用 LLM 压缩历史
        response = await llm.chat([
            {"role": "system", "content": "Summarize the following conversation:"},
            *self.messages[1:-10],
        ])
        return response["text"]

    def save(self, path: str):
        with open(path, "w") as f:
            json.dump(self.messages, f, indent=2)

    @classmethod
    def load(cls, path: str) -> "Context":
        with open(path, "r") as f:
            messages = json.load(f)
        context = cls()
        context.messages = messages
        return context
```

#### 5.1.4 执行引擎

**核心循环**:

```python
class AgentEngine:
    def __init__(
        self,
        llm: LLMProvider,
        tools: list[Tool],
        context: Context,
    ):
        self.llm = llm
        self.tools = {tool.name: tool for tool in tools}
        self.context = context

    async def step(self, user_message: str = None) -> dict:
        # 1. 添加用户消息
        if user_message:
            self.context.add_user_message(user_message)

        # 2. 准备工具定义
        tool_schemas = [
            {
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.parameters,
                }
            }
            for tool in self.tools.values()
        ]

        # 3. 调用 LLM
        response = await self.llm.chat(
            messages=self.context.messages,
            tools=tool_schemas,
        )

        # 4. 处理响应
        if response["tool_calls"]:
            # 执行工具
            tool_results = await self._execute_tools(response["tool_calls"])

            # 添加到上下文
            self.context.add_assistant_message(
                text=response["text"],
                tool_calls=response["tool_calls"],
            )
            for tc, result in zip(response["tool_calls"], tool_results):
                self.context.add_tool_result(tc["id"], result)

            # 继续循环
            return await self.step()
        else:
            # 返回最终响应
            self.context.add_assistant_message(response["text"])
            return response

    async def _execute_tools(self, tool_calls: list[dict]) -> list[str]:
        results = []
        for tc in tool_calls:
            tool = self.tools[tc["name"]]
            try:
                result = await tool._execute(**tc["parameters"])
                results.append(json.dumps(result))
            except Exception as e:
                results.append(f"Error: {str(e)}")
        return results
```

### 5.2 关键设计决策

#### 5.2.1 为什么使用异步？

**问题**：Agent 需要执行多个 IO 操作（文件读写、网络请求、Shell 命令）

**解决方案**：使用 `async/await` 实现并发

```python
# 同步版本（慢）
def execute_tools(tool_calls):
    results = []
    for tc in tool_calls:
        result = tool.execute(tc)  # 阻塞
        results.append(result)
    return results

# 异步版本（快）
async def execute_tools(tool_calls):
    tasks = [
        tool.execute(tc)
        for tc in tool_calls
    ]
    results = await asyncio.gather(*tasks)  # 并行执行
    return results
```

#### 5.2.2 为什么需要 KAOS？

**问题**：
- 工具直接访问文件系统不安全
- 难以测试（需要真实文件）
- 无法支持远程文件系统

**解决方案**：引入抽象层

```python
# 不好的设计
class ReadFile(Tool):
    async def _execute(self, file_path: str):
        with open(file_path) as f:  # 直接访问
            return f.read()

# 好的设计
class ReadFile(Tool):
    async def _prepare(self, runtime: Runtime):
        self.kaos = runtime.kaos  # 依赖注入

    async def _execute(self, file_path: str):
        return await self.kaos.readtext(file_path)  # 通过抽象层
```

#### 5.2.3 为什么需要审批机制？

**问题**：Agent 可能执行危险操作（删除文件、运行 `rm -rf`）

**解决方案**：在工具执行前询问用户

```python
class ApprovalSystem:
    async def approve_tool_call(self, tool_call: dict) -> bool:
        # 显示工具调用信息
        print(f"Agent wants to call: {tool_call['name']}")
        print(f"Parameters: {tool_call['parameters']}")

        # 询问用户
        response = input("Approve? [y/n]: ")
        return response.lower() == "y"
```

### 5.3 实战：构建一个最小 Agent

让我们构建一个简化版的 Agent：

```python
# mini_agent.py
import asyncio
import json
from openai import AsyncOpenAI

class MiniAgent:
    def __init__(self, api_key: str):
        self.client = AsyncOpenAI(api_key=api_key)
        self.messages = []
        self.tools = {
            "read_file": self._read_file,
            "write_file": self._write_file,
        }

    async def chat(self, user_input: str):
        # 添加用户消息
        self.messages.append({
            "role": "user",
            "content": user_input,
        })

        # 定义工具
        tool_schemas = [
            {
                "type": "function",
                "function": {
                    "name": "read_file",
                    "description": "Read a file",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "path": {"type": "string"},
                        },
                        "required": ["path"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "write_file",
                    "description": "Write to a file",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "path": {"type": "string"},
                            "content": {"type": "string"},
                        },
                        "required": ["path", "content"],
                    },
                },
            },
        ]

        # 调用 OpenAI
        response = await self.client.chat.completions.create(
            model="gpt-4",
            messages=self.messages,
            tools=tool_schemas,
        )

        message = response.choices[0].message

        # 处理工具调用
        if message.tool_calls:
            self.messages.append({
                "role": "assistant",
                "content": message.content,
                "tool_calls": [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.function.name,
                            "arguments": tc.function.arguments,
                        },
                    }
                    for tc in message.tool_calls
                ],
            })

            for tc in message.tool_calls:
                tool_name = tc.function.name
                args = json.loads(tc.function.arguments)
                result = await self.tools[tool_name](**args)

                self.messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": result,
                })

            # 继续对话
            return await self.chat("")
        else:
            # 返回最终响应
            self.messages.append({
                "role": "assistant",
                "content": message.content,
            })
            return message.content

    async def _read_file(self, path: str) -> str:
        try:
            with open(path) as f:
                return f.read()
        except Exception as e:
            return f"Error: {str(e)}"

    async def _write_file(self, path: str, content: str) -> str:
        try:
            with open(path, "w") as f:
                f.write(content)
            return "File written successfully"
        except Exception as e:
            return f"Error: {str(e)}"

# 使用示例
async def main():
    agent = MiniAgent(api_key="sk-...")

    response = await agent.chat("Read the file README.md and tell me what it says")
    print(response)

asyncio.run(main())
```

---

## 6. 实战：动手修改和扩展

### 6.1 任务 1：添加一个新工具 - 文件搜索

**目标**：实现一个搜索文件名的工具

**步骤**：

#### 1. 创建工具文件

```python
# src/kimi_cli/tools/file/find_files.py
from pathlib import Path
from kosong import Tool
from kimi_cli.soul.agent import Runtime

class FindFiles(Tool):
    """搜索文件名"""

    @property
    def description(self) -> str:
        return """
        Search for files by name pattern.

        Parameters:
        - pattern (str): File name pattern (supports wildcards like *.py)
        - max_results (int): Maximum number of results to return

        Returns:
        List of matching file paths.
        """

    @property
    def parameters(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "File name pattern (e.g., '*.py', 'test_*.json')",
                },
                "max_results": {
                    "type": "integer",
                    "default": 50,
                    "description": "Maximum number of results",
                },
            },
            "required": ["pattern"],
        }

    async def _prepare(self, runtime: Runtime) -> None:
        self.work_dir = runtime.work_dir

    async def _execute(self, pattern: str, max_results: int = 50) -> dict:
        matches = []

        # 递归搜索
        for path in self.work_dir.rglob(pattern):
            if path.is_file():
                relative_path = path.relative_to(self.work_dir)
                matches.append(str(relative_path))

                if len(matches) >= max_results:
                    break

        return {
            "pattern": pattern,
            "count": len(matches),
            "files": matches,
        }
```

#### 2. 添加到 Agent 配置

编辑 `src/kimi_cli/agents/default/agent.yaml`:

```yaml
tools:
  # ... 现有工具
  - "kimi_cli.tools.file:FindFiles"
```

#### 3. 测试工具

```python
# tests/test_find_files.py
import pytest
from pathlib import Path
from kimi_cli.tools.file.find_files import FindFiles
from kimi_cli.soul.agent import Runtime
from kaos.local import LocalKaos

@pytest.mark.asyncio
async def test_find_files(tmp_path: Path):
    # 创建测试文件
    (tmp_path / "test1.py").touch()
    (tmp_path / "test2.py").touch()
    (tmp_path / "other.txt").touch()

    # 初始化工具
    runtime = Runtime(
        kaos=LocalKaos(),
        work_dir=tmp_path,
    )
    tool = FindFiles()
    await tool._prepare(runtime)

    # 执行搜索
    result = await tool._execute(pattern="*.py")

    # 验证结果
    assert result["count"] == 2
    assert "test1.py" in result["files"]
    assert "test2.py" in result["files"]
```

运行测试：

```bash
pytest tests/test_find_files.py -v
```

### 6.2 任务 2：添加一个子 Agent - 数据分析助手

**目标**：创建一个专门处理数据分析任务的子 Agent

**步骤**：

#### 1. 创建 Agent 配置

```yaml
# src/kimi_cli/agents/data_analyst/agent.yaml
version: 1
agent:
  name: "Data Analyst"
  system_prompt_path: ./system.md
  tools:
    - "kimi_cli.tools.file:ReadFile"
    - "kimi_cli.tools.file:WriteFile"
    - "kimi_cli.tools.shell:Shell"  # 可以运行 Python 脚本
```

#### 2. 编写系统提示词

```markdown
# src/kimi_cli/agents/data_analyst/system.md

You are a Data Analyst Agent specialized in data analysis tasks.

Your capabilities:
- Read and analyze CSV, JSON, and other data files
- Write Python scripts for data processing
- Use pandas, numpy, matplotlib for analysis
- Generate visualizations and reports

When given a data analysis task:
1. First, read the data file to understand its structure
2. Write a Python script to perform the analysis
3. Execute the script using the Shell tool
4. Summarize the findings

Always provide clear explanations of your analysis steps.
```

#### 3. 在主 Agent 中注册

编辑 `src/kimi_cli/agents/default/agent.yaml`:

```yaml
subagents:
  coder:
    path: ./sub.yaml
    description: "Good at general software engineering tasks."

  data_analyst:
    path: ../data_analyst/agent.yaml
    description: "Specialized in data analysis and visualization tasks."
```

#### 4. 使用子 Agent

现在主 Agent 可以委派任务给数据分析 Agent：

```
User: Analyze the sales data in sales.csv and create a visualization

Main Agent: I'll delegate this to the Data Analyst.
[Calls Task tool with subagent="data_analyst"]

Data Analyst:
1. Reading sales.csv...
2. Writing analysis script...
3. Running script...
4. Summary: ...
```

### 6.3 任务 3：添加新的 LLM 提供商

**目标**：添加对 Google Gemini 的支持

**步骤**：

#### 1. 安装依赖

```bash
uv add google-generativeai
```

#### 2. 实现提供商

```python
# src/kimi_cli/llm.py

import google.generativeai as genai

# 添加到 LLMProviderType 枚举
class LLMProviderType(str, Enum):
    # ... 现有提供商
    GOOGLE_GEMINI = "google_gemini"

# 在 create_llm 函数中添加
def create_llm(provider_type: str, model: dict, ...) -> LLM:
    if provider_type == LLMProviderType.GOOGLE_GEMINI:
        genai.configure(api_key=model.api_key)
        return GeminiLLM(
            model_name=model.name,
            max_tokens=model.max_context_size,
        )
    # ... 其他提供商

# 实现 GeminiLLM 类
class GeminiLLM:
    def __init__(self, model_name: str, max_tokens: int):
        self.model = genai.GenerativeModel(model_name)
        self.max_tokens = max_tokens

    async def chat(self, messages: list[dict], tools: list = None) -> dict:
        # 转换消息格式
        gemini_messages = self._convert_messages(messages)

        # 调用 Gemini
        response = await self.model.generate_content_async(
            gemini_messages,
            tools=tools,
        )

        # 解析响应
        return self._parse_response(response)
```

#### 3. 更新配置

```json
// ~/.kimi/config.json
{
  "providers": {
    "google": {
      "type": "google_gemini",
      "api_key": "your-api-key"
    }
  },
  "models": {
    "gemini-pro": {
      "provider": "google",
      "name": "gemini-pro",
      "max_context_size": 30000
    }
  }
}
```

#### 4. 使用新模型

```bash
kimi --model gemini-pro
```

---

## 7. 高级主题

### 7.1 多 Agent 协作

**场景**：主 Agent 将复杂任务分解给多个子 Agent

**实现**：

```python
# src/kimi_cli/tools/multiagent/task.py
class Task(Tool):
    async def _execute(
        self,
        subagent: str,
        prompt: str,
    ) -> str:
        # 1. 获取子 Agent
        subagent_instance = self.runtime.subagents[subagent]

        # 2. 创建独立的上下文
        subagent_context = Context()

        # 3. 创建 Soul
        subagent_soul = KimiSoul(
            agent=subagent_instance,
            context=subagent_context,
            runtime=self.runtime,
        )

        # 4. 执行任务
        result = await subagent_soul.step(prompt)

        return result.text
```

**使用示例**：

```python
# 主 Agent 推理
"""
User wants to build a web application.
This is complex, I'll delegate:
1. Backend API → coder subagent
2. Frontend UI → coder subagent
3. Database schema → coder subagent
"""

# 调用工具
await Task(subagent="coder", prompt="Design a REST API for user management")
await Task(subagent="coder", prompt="Create a React frontend with login page")
```

### 7.2 历史压缩策略

**问题**：长对话超出 LLM 上下文限制

**策略 1：滑动窗口**

```python
class SlidingWindowContext(Context):
    def compact(self, window_size: int = 10):
        # 保留系统消息 + 最近 N 条
        self.messages = [
            self.messages[0],  # 系统消息
            *self.messages[-window_size:],  # 最近 N 条
        ]
```

**策略 2：LLM 压缩**

```python
class LLMCompactionContext(Context):
    async def compact(self, llm: LLMProvider):
        # 提取需要压缩的消息
        old_messages = self.messages[1:-10]

        # 调用 LLM 生成摘要
        summary = await llm.chat([
            {"role": "system", "content": COMPACTION_PROMPT},
            *old_messages,
        ])

        # 替换为摘要
        self.messages = [
            self.messages[0],
            {"role": "system", "content": f"Previous conversation summary:\n{summary}"},
            *self.messages[-10:],
        ]
```

**策略 3：关键信息提取**

```python
class KeyInfoContext(Context):
    async def compact(self, llm: LLMProvider):
        # 提取关键信息
        key_info = await llm.chat([
            {
                "role": "system",
                "content": "Extract key information from the conversation: "
                          "file paths, variable names, decisions made, etc."
            },
            *self.messages[1:-10],
        ])

        self.messages = [
            self.messages[0],
            {"role": "system", "content": f"Key context:\n{key_info}"},
            *self.messages[-10:],
        ]
```

### 7.3 错误处理和重试

**使用 tenacity 实现智能重试**：

```python
from tenacity import (
    retry,
    stop_after_attempt,
    wait_exponential,
    retry_if_exception_type,
)

class KimiSoul:
    @retry(
        stop=stop_after_attempt(3),  # 最多重试 3 次
        wait=wait_exponential(multiplier=1, min=2, max=10),  # 指数退避
        retry=retry_if_exception_type((APIError, TimeoutError)),  # 仅重试特定错误
    )
    async def _call_llm(self) -> dict:
        return await self.llm.chat(
            messages=self.context.messages,
            tools=self.agent.tool_schemas,
        )
```

**错误分类处理**：

```python
class KimiSoul:
    async def step(self, user_message: str = None):
        try:
            return await self._step_impl(user_message)
        except APIError as e:
            # API 错误（可重试）
            if "rate_limit" in str(e):
                await asyncio.sleep(5)
                return await self.step(user_message)
            else:
                raise
        except ToolExecutionError as e:
            # 工具执行错误（返回错误信息给 LLM）
            self.context.add_tool_error(str(e))
            return await self.step()  # 继续循环
        except ValidationError as e:
            # 参数验证错误（不可重试）
            return {"error": f"Invalid parameters: {e}"}
```

### 7.4 性能优化

#### 7.4.1 并行工具调用

```python
async def _execute_tools(self, tool_calls: list[dict]) -> list[str]:
    # 并行执行所有工具
    tasks = [
        self._execute_single_tool(tc)
        for tc in tool_calls
    ]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    # 处理异常
    return [
        str(result) if not isinstance(result, Exception) else f"Error: {result}"
        for result in results
    ]
```

#### 7.4.2 缓存

```python
from functools import lru_cache

class ReadFile(Tool):
    @lru_cache(maxsize=100)
    async def _read_cached(self, file_path: str) -> str:
        return await self.kaos.readtext(file_path)

    async def _execute(self, file_path: str, **kwargs) -> str:
        content = await self._read_cached(file_path)
        # ... 处理内容
```

#### 7.4.3 流式输出

```python
class KimiSoul:
    async def step_streaming(self, user_message: str):
        # 流式调用 LLM
        async for chunk in self.llm.chat_stream(self.context.messages):
            if chunk.type == "text":
                yield {"type": "text", "data": chunk.text}
            elif chunk.type == "tool_call":
                yield {"type": "tool_call", "data": chunk.tool_call}
```

---

## 8. 最佳实践

### 8.1 系统提示词设计

#### 原则

1. **清晰明确**：明确 Agent 的角色和能力
2. **结构化**：使用 Markdown 格式组织信息
3. **示例驱动**：提供具体的使用示例
4. **约束明确**：说明 Agent 的限制

#### 示例

```markdown
# System Prompt Template

## Role
You are ${AGENT_NAME}, an AI assistant specialized in ${DOMAIN}.

## Capabilities
You have access to the following tools:
- Tool1: Description
- Tool2: Description

## Guidelines

### When to use tools
- Use ReadFile when you need to examine code
- Use Shell when you need to run commands
- Use Task when you need specialized help

### Best practices
1. Always read files before editing
2. Test changes before committing
3. Provide clear explanations

## Constraints
- Only access files within ${WORK_DIR}
- Always ask before destructive operations
- Respect user preferences

## Examples

### Example 1: Reading a file
User: "What's in main.py?"
Assistant: I'll read the file.
[Calls ReadFile tool]
The file contains...

### Example 2: Running tests
User: "Run the tests"
Assistant: I'll execute the test suite.
[Calls Shell tool with "pytest"]
```

### 8.2 工具设计原则

#### 1. 单一职责

```python
# ❌ 不好：一个工具做太多事
class FileManager(Tool):
    def _execute(self, action: str, path: str, content: str = None):
        if action == "read":
            return self._read(path)
        elif action == "write":
            return self._write(path, content)
        elif action == "delete":
            return self._delete(path)

# ✅ 好：每个工具只做一件事
class ReadFile(Tool):
    def _execute(self, path: str): ...

class WriteFile(Tool):
    def _execute(self, path: str, content: str): ...

class DeleteFile(Tool):
    def _execute(self, path: str): ...
```

#### 2. 清晰的错误信息

```python
class ReadFile(Tool):
    async def _execute(self, file_path: str) -> str:
        try:
            return await self.kaos.readtext(file_path)
        except FileNotFoundError:
            raise ToolExecutionError(
                f"File not found: {file_path}\n"
                f"Working directory: {self.work_dir}\n"
                f"Available files: {list(self.work_dir.iterdir())}"
            )
        except PermissionError:
            raise ToolExecutionError(
                f"Permission denied: {file_path}\n"
                f"Please check file permissions."
            )
```

#### 3. 参数验证

```python
class WriteFile(Tool):
    async def _execute(self, file_path: str, content: str) -> str:
        # 验证路径
        if ".." in file_path:
            raise ValidationError("Path traversal not allowed")

        # 验证内容大小
        if len(content) > 1_000_000:  # 1 MB
            raise ValidationError("Content too large (max 1 MB)")

        # 执行写入
        await self.kaos.writetext(file_path, content)
        return "File written successfully"
```

### 8.3 测试策略

#### 单元测试

```python
@pytest.mark.asyncio
async def test_read_file_success(tmp_path):
    # Arrange
    test_file = tmp_path / "test.txt"
    test_file.write_text("Hello, world!")

    runtime = Runtime(kaos=LocalKaos(), work_dir=tmp_path)
    tool = ReadFile()
    await tool._prepare(runtime)

    # Act
    result = await tool._execute("test.txt")

    # Assert
    assert "Hello, world!" in result

@pytest.mark.asyncio
async def test_read_file_not_found(tmp_path):
    # Arrange
    runtime = Runtime(kaos=LocalKaos(), work_dir=tmp_path)
    tool = ReadFile()
    await tool._prepare(runtime)

    # Act & Assert
    with pytest.raises(ToolExecutionError, match="File not found"):
        await tool._execute("nonexistent.txt")
```

#### 集成测试

```python
@pytest.mark.asyncio
async def test_agent_workflow(mock_llm, tmp_path):
    # 设置 Mock LLM
    mock_llm.set_responses([
        {"text": "I'll read the file", "tool_calls": [
            {"name": "ReadFile", "parameters": {"file_path": "test.txt"}}
        ]},
        {"text": "The file contains: Hello", "tool_calls": []},
    ])

    # 创建 Agent
    agent = create_test_agent(llm=mock_llm, work_dir=tmp_path)

    # 执行
    response = await agent.step("What's in test.txt?")

    # 验证
    assert "Hello" in response.text
    assert mock_llm.call_count == 2
```

### 8.4 安全性考虑

#### 1. 路径遍历保护

```python
def validate_path(base_dir: Path, user_path: str) -> Path:
    # 解析绝对路径
    full_path = (base_dir / user_path).resolve()

    # 检查是否在 base_dir 内
    if not full_path.is_relative_to(base_dir):
        raise SecurityError("Path traversal attempt detected")

    return full_path
```

#### 2. 命令注入保护

```python
import shlex

class Shell(Tool):
    DANGEROUS_COMMANDS = ["rm -rf", "dd", "mkfs", ":(){ :|:& };:"]

    async def _execute(self, command: str) -> str:
        # 检查危险命令
        for dangerous in self.DANGEROUS_COMMANDS:
            if dangerous in command:
                raise SecurityError(f"Dangerous command detected: {dangerous}")

        # 使用 shlex 转义
        safe_command = shlex.quote(command)

        # 执行
        return await self._run_shell(safe_command)
```

#### 3. API Key 保护

```python
from pydantic import SecretStr

class Config:
    api_key: SecretStr  # 自动隐藏打印

    def to_dict(self) -> dict:
        return {
            "api_key": "***"  # 不暴露真实值
        }
```

### 8.5 调试技巧

#### 1. 启用详细日志

```python
import logging
from loguru import logger

# 配置 loguru
logger.add(
    "kimi.log",
    level="DEBUG",
    rotation="10 MB",
    format="{time} {level} {message}",
)

# 在代码中使用
logger.debug(f"Calling LLM with {len(messages)} messages")
logger.info(f"Tool {tool_name} executed successfully")
logger.error(f"Error in tool execution: {error}")
```

#### 2. 保存调试信息

```python
class KimiSoul:
    def __init__(self, debug: bool = False):
        self.debug = debug
        self.debug_log = []

    async def step(self, user_message: str):
        if self.debug:
            self.debug_log.append({
                "timestamp": datetime.now(),
                "user_message": user_message,
                "context_size": len(self.context.messages),
            })

        # ... 执行逻辑

        if self.debug:
            with open("debug.json", "w") as f:
                json.dump(self.debug_log, f, indent=2)
```

#### 3. 使用 Replay 功能

```python
# 保存会话
session.save("session.json")

# 重放会话
session = Session.load("session.json")
for message in session.messages:
    print(f"{message['role']}: {message['content']}")
```

---

## 总结

### 你学到了什么

通过本指南，你应该掌握了：

1. **Agent 系统架构**
   - LLM 集成
   - 工具系统
   - 上下文管理
   - 执行引擎

2. **Kimi CLI 的实现**
   - KAOS 文件系统抽象
   - Soul 执行引擎
   - 多 UI 模式
   - Agent 配置系统

3. **实战技能**
   - 添加新工具
   - 创建子 Agent
   - 集成新 LLM 提供商
   - 测试和调试

4. **高级主题**
   - 多 Agent 协作
   - 历史压缩
   - 性能优化
   - 安全性

### 下一步

1. **深入源码**
   - 阅读 `src/kimi_cli/soul/kimisoul.py`
   - 研究工具实现
   - 理解 Agent 加载流程

2. **动手实践**
   - 完成上面的 3 个实战任务
   - 创建自己的 Agent
   - 贡献代码到项目

3. **探索生态**
   - 了解 MCP 协议
   - 研究 ACP 集成
   - 探索其他 Agent 框架（LangChain、AutoGPT）

4. **构建自己的 Agent**
   - 根据需求设计架构
   - 实现核心功能
   - 测试和优化

### 推荐资源

- [Kimi CLI 文档](https://www.kimi.com/coding/docs/kimi-cli.html)
- [OpenAI Function Calling](https://platform.openai.com/docs/guides/function-calling)
- [LangChain](https://python.langchain.com/)
- [Anthropic Claude](https://www.anthropic.com/claude)
- [Model Context Protocol](https://modelcontextprotocol.io/)

---

**恭喜你完成了这个全面的指南！现在你已经掌握了构建 Coding Agent 的核心知识。**

Happy coding! 🚀
