# 第 1 章：核心概念

在开始构建 Agent 之前,我们需要理解几个核心概念。这些概念将贯穿整本书,是构建 Coding Agent 的基石。

## 1.1 什么是 Agent？

### 定义

**Agent（代理）** 是一个能够感知环境、自主决策并采取行动以实现目标的系统。

在 AI 的上下文中，一个 **Coding Agent** 具有以下特征：

```
┌─────────────────────────────────────────┐
│              Coding Agent               │
├─────────────────────────────────────────┤
│                                         │
│  ┌─────────┐      ┌─────────┐         │
│  │  感知    │─────▶│  推理    │         │
│  │ Perceive│      │ Reason  │         │
│  └─────────┘      └────┬────┘         │
│       ▲                 │               │
│       │                 ▼               │
│  ┌────┴────┐      ┌─────────┐         │
│  │  观察    │◀─────│  行动    │         │
│  │ Observe │      │  Act    │         │
│  └─────────┘      └─────────┘         │
│                                         │
└─────────────────────────────────────────┘
```

### Agent vs 传统程序

| 特性 | 传统程序 | Agent |
|------|---------|-------|
| **决策** | 预定义的逻辑分支 | LLM 动态推理 |
| **适应性** | 固定流程 | 根据情况调整策略 |
| **学习** | 需要重新编程 | 从对话中学习 |
| **交互** | 有限的输入输出 | 自然语言对话 |

### Kimi-CLI 中的 Agent

在 kimi-cli 中，Agent 是一个配置文件 + 一组工具：

```yaml
# agent.yaml
version: 1
agent:
  name: "kimi-agent"
  system_prompt_path: ./system.md
  tools:
    - "kimi_cli.tools.file:ReadFile"
    - "kimi_cli.tools.shell:Shell"
```

## 1.2 大语言模型（LLM）

### LLM 的角色

LLM 是 Agent 的"大脑"，负责：

1. **理解**：解析用户的自然语言输入
2. **推理**：分析问题，制定解决方案
3. **决策**：选择合适的工具和参数
4. **生成**：产生代码、文档、解释

### Function Calling

现代 LLM 支持 **Function Calling**（函数调用），这是构建 Agent 的关键：

```python
# 用户输入
"读取 config.py 文件的内容"

# LLM 推理后生成
{
    "tool_calls": [
        {
            "name": "ReadFile",
            "arguments": {
                "file_path": "/path/to/config.py"
            }
        }
    ]
}

# Agent 执行工具
result = read_file("/path/to/config.py")

# 将结果返回给 LLM
# LLM 继续推理...
```

### 消息格式

LLM 使用消息列表来维护对话：

```python
messages = [
    {
        "role": "system",
        "content": "You are a helpful coding assistant..."
    },
    {
        "role": "user",
        "content": "Read config.py"
    },
    {
        "role": "assistant",
        "content": "",
        "tool_calls": [...]
    },
    {
        "role": "tool",
        "tool_call_id": "call_123",
        "content": "# config.py content..."
    }
]
```

## 1.3 工具系统（Tools）

### 什么是工具？

**工具（Tool）** 是 Agent 能够执行的操作。每个工具有：

- **名称**：唯一标识符（如 `ReadFile`）
- **描述**：告诉 LLM 这个工具的用途
- **参数**：工具需要的输入（如 `file_path`）
- **实现**：实际执行的代码

### 工具的定义

```python
from pydantic import BaseModel

class ReadFileParams(BaseModel):
    """读取文件的参数"""
    file_path: str
    limit: int | None = None

class ReadFile:
    """读取文件内容的工具"""

    name = "ReadFile"
    description = "读取指定路径的文件内容"
    params = ReadFileParams

    async def __call__(self, params: ReadFileParams):
        """执行工具"""
        with open(params.file_path) as f:
            content = f.read()
        return {"content": content}
```

### 工具的类型

在 kimi-cli 中，工具分为几类：

1. **文件工具**：`ReadFile`、`WriteFile`、`Glob`、`Grep`
2. **执行工具**：`Shell`、`Python`
3. **Web 工具**：`SearchWeb`、`FetchURL`
4. **Agent 工具**：`Task`（委派给子 Agent）
5. **系统工具**：`Think`、`SetTodoList`

## 1.4 上下文（Context）

### 什么是上下文？

**上下文（Context）** 是 Agent 的"记忆"，包含：

- 对话历史（用户和 Agent 的所有消息）
- 工具调用记录
- 系统提示词

### 为什么需要上下文？

```python
# 没有上下文
User: "读取 config.py"
Agent: [读取文件]
User: "第 10 行是什么？"
Agent: ❌ "我不知道你在说哪个文件"

# 有上下文
User: "读取 config.py"
Agent: [读取文件，记录在上下文]
User: "第 10 行是什么？"
Agent: ✅ [从上下文知道是 config.py 的第 10 行]
```

### 上下文管理

```python
class Context:
    """上下文管理器"""

    def __init__(self):
        self.messages = []

    def add_user_message(self, content: str):
        """添加用户消息"""
        self.messages.append({
            "role": "user",
            "content": content
        })

    def add_assistant_message(self, content: str, tool_calls=None):
        """添加 Agent 回复"""
        self.messages.append({
            "role": "assistant",
            "content": content,
            "tool_calls": tool_calls
        })

    def add_tool_result(self, tool_call_id: str, result: str):
        """添加工具执行结果"""
        self.messages.append({
            "role": "tool",
            "tool_call_id": tool_call_id,
            "content": result
        })
```

### 上下文持久化

上下文需要保存到磁盘，以便：

- **继续会话**：下次可以接着上次的进度
- **调试**：回顾 Agent 的思考过程
- **审计**：记录 Agent 做了什么

Kimi-CLI 使用 **JSON Lines** 格式：

```jsonl
{"role": "user", "content": "读取 config.py"}
{"role": "assistant", "content": "", "tool_calls": [...]}
{"role": "tool", "content": "# config content..."}
```

## 1.5 执行循环（Loop）

### Agent 的执行流程

```python
async def agent_loop(user_input: str):
    """Agent 主循环"""

    # 1. 添加用户输入到上下文
    context.add_user_message(user_input)

    while True:
        # 2. 调用 LLM 推理
        response = await llm.generate(context.messages)

        # 3. 处理回复
        if response.tool_calls:
            # 有工具调用
            context.add_assistant_message("", response.tool_calls)

            # 4. 执行工具
            for tool_call in response.tool_calls:
                result = await execute_tool(tool_call)
                context.add_tool_result(tool_call.id, result)

            # 5. 继续循环，让 LLM 看到工具结果
            continue
        else:
            # 没有工具调用，任务完成
            context.add_assistant_message(response.content)
            break

    return response.content
```

### 执行流程图

```
用户输入
   │
   ▼
┌─────────────┐
│ 添加到上下文 │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  调用 LLM   │
└──────┬──────┘
       │
       ▼
   有工具调用？
   ╱        ╲
  是          否
 ╱              ╲
▼                ▼
执行工具      返回结果
│
▼
添加结果到上下文
│
└────────┐
         │
         ▼
      (循环)
```

## 1.6 系统提示词（System Prompt）

### 作用

**系统提示词** 定义了 Agent 的"人格"和行为规范：

```markdown
# system.md

You are a helpful coding assistant. Your task is to help users with
software engineering tasks.

## Guidelines

- Always read files before modifying them
- Prefer using tools over guessing
- Explain your reasoning
- Ask for clarification when needed

## Tools

You have access to these tools:
- ReadFile: Read file contents
- WriteFile: Write to files
- Shell: Execute shell commands
```

### 模板变量

系统提示词支持动态变量：

```markdown
Current time: ${KIMI_NOW}
Working directory: ${KIMI_WORK_DIR}

Directory listing:
${KIMI_WORK_DIR_LS}
```

在运行时会被替换：

```markdown
Current time: 2025-01-15 10:30:00
Working directory: /home/user/project

Directory listing:
- src/
- tests/
- README.md
```

## 1.7 核心概念关系图

```
┌────────────────────────────────────────────────────────┐
│                    Coding Agent                         │
└────────────────────────────────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
        ▼                  ▼                  ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│     LLM      │   │   Tools      │   │   Context    │
│   (大脑)     │   │   (手)       │   │   (记忆)     │
└──────────────┘   └──────────────┘   └──────────────┘
        │                  │                  │
        └──────────────────┼──────────────────┘
                           │
                           ▼
                   ┌──────────────┐
                   │ Execution    │
                   │   Loop       │
                   │  (执行循环)   │
                   └──────────────┘
                           │
                           ▼
                   ┌──────────────┐
                   │ System       │
                   │  Prompt      │
                   │ (行为规范)    │
                   └──────────────┘
```

## 1.8 实践：概念验证

让我们用代码验证这些概念：

```python
# concept_demo.py

import asyncio
from openai import AsyncOpenAI

# 1. 定义一个简单的工具
def get_current_time():
    """获取当前时间"""
    from datetime import datetime
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

# 2. 定义工具描述（给 LLM 看的）
tools = [
    {
        "type": "function",
        "function": {
            "name": "get_current_time",
            "description": "获取当前系统时间",
            "parameters": {
                "type": "object",
                "properties": {},
            }
        }
    }
]

# 3. 创建上下文
messages = [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "现在几点了？"}
]

async def demo():
    client = AsyncOpenAI()

    # 4. 调用 LLM
    response = await client.chat.completions.create(
        model="gpt-4",
        messages=messages,
        tools=tools
    )

    # 5. 检查是否有工具调用
    if response.choices[0].message.tool_calls:
        tool_call = response.choices[0].message.tool_calls[0]

        print(f"LLM 想要调用工具: {tool_call.function.name}")

        # 6. 执行工具
        result = get_current_time()
        print(f"工具返回: {result}")

        # 7. 将结果返回给 LLM
        messages.append(response.choices[0].message)
        messages.append({
            "role": "tool",
            "tool_call_id": tool_call.id,
            "content": result
        })

        # 8. 再次调用 LLM
        final_response = await client.chat.completions.create(
            model="gpt-4",
            messages=messages
        )

        print(f"LLM 最终回复: {final_response.choices[0].message.content}")

# 运行
asyncio.run(demo())
```

输出示例：

```
LLM 想要调用工具: get_current_time
工具返回: 2025-01-15 10:30:00
LLM 最终回复: 现在是 2025 年 1 月 15 日 10:30:00
```

## 1.9 小结

在这一章，我们学习了构建 Coding Agent 的核心概念：

- ✅ **Agent**：能感知、推理、行动的系统
- ✅ **LLM**：Agent 的"大脑"，负责推理和决策
- ✅ **Tools**：Agent 的"手"，执行具体操作
- ✅ **Context**：Agent 的"记忆"，维护对话历史
- ✅ **Loop**：Agent 的执行流程
- ✅ **System Prompt**：Agent 的行为规范

这些概念构成了 Agent 的基础架构。在接下来的章节中，我们将逐步实现每个部分。

## 思考题

1. 为什么 Agent 需要"上下文"？如果没有上下文会怎样？
2. Function Calling 和传统的 API 调用有什么区别？
3. 如果一个工具执行失败了，Agent 应该如何处理？

---

**下一章**：[第 2 章：环境准备](./02-environment-setup.md) →
