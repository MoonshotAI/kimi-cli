# Kimi CLI Examples 使用指南

本文档详细介绍了 Kimi CLI 项目中 `examples/` 目录下的各个示例案例，帮助开发者理解和使用这些示例来学习和扩展 Kimi CLI 的功能。

## 概述

`examples/` 目录包含了5个主要示例，每个示例都展示了 Kimi CLI 的不同功能和扩展方式：

1. **custom-echo-soul** - 自定义 Echo Soul 实现
2. **custom-kimi-soul** - 扩展内置 Kimi Soul
3. **custom-tools** - 自定义工具开发
4. **kimi-cli-stream-json** - JSON 流式交互
5. **kimi-cli-wire-messages** - Wire 消息处理

## 示例详解

### 1. custom-echo-soul - 自定义 Echo Soul

**功能说明：**
这个示例演示了如何编写一个完全自定义的 `Soul`（代理循环）实现，可以与 Kimi CLI 的 `Shell` UI 配合使用。

**核心特性：**
- 实现 `EchoSoul` 类，简单地回显用户输入
- 展示了 Soul 接口的基本结构和必需方法
- 支持字符串和内容部分列表两种输入格式

**关键代码结构：**
```python
class EchoSoul:
    def __init__(self) -> None:
        pass

    @property
    def name(self) -> str:
        return "EchoSoul"
    
    async def run(self, user_input: str | list[ContentPart]) -> None:
        wire_send(StepBegin(n=1))
        # 简单回显用户输入
```

**使用场景：**
- 学习 Soul 接口的基本实现
- 理解 Kimi CLI 的消息传递机制
- 作为开发自定义 Soul 的起点

**运行方式：**
```bash
cd examples/custom-echo-soul
uv sync --reinstall
uv run main.py
```

### 2. custom-kimi-soul - 扩展内置 Kimi Soul

**功能说明：**
演示如何扩展内置的 `KimiSoul` 来自定义其行为，并使用 `Shell` UI 运行。

**核心特性：**
- 继承 `KimiSoul` 创建 `HakimiSoul` 子类
- 自定义 LLM 配置和工具集
- 添加自定义工具 `MyBashTool`
- 展示完整的会话管理和上下文恢复

**关键代码结构：**
```python
class HakimiSoul(KimiSoul):
    @staticmethod
    async def create(llm, system_prompt, toolset, session=None, work_dir=None):
        # 创建自定义配置和运行时环境
        
class MyBashTool(CallableTool2):
    # 自定义 bash 工具实现
```

**使用场景：**
- 需要在标准 Kimi 功能基础上进行定制
- 添加自定义工具和配置
- 学习如何集成自定义 LLM 提供商

**运行方式：**
```bash
cd examples/custom-kimi-soul
uv sync --reinstall
uv run main.py
```

### 3. custom-tools - 自定义工具开发

**功能说明：**
展示如何为 Kimi CLI 编写自定义工具，并将它们添加到代理规范文件中。

**核心特性：**
- 实现自定义工具 `Ls`（目录列表工具）
- 使用 YAML 配置文件定义代理规范
- 集成自定义工具到现有工具集
- 演示工具参数定义和错误处理

**关键代码结构：**
```python
class Ls(CallableTool2):
    name: str = "Ls"
    description: str = "List files in a directory."
    params: type[Params] = Params
    
    async def __call__(self, params: Params) -> ToolReturnValue:
        # 工具执行逻辑
```

**配置文件 (`myagent.yaml`)：**
```yaml
agent:
  extend: default
  tools:
    - "my_tools.ls:Ls"  # 自定义工具
    # ... 其他工具
```

**使用场景：**
- 开发领域特定的自定义工具
- 扩展 Kimi CLI 的功能
- 学习工具开发的最佳实践

**运行方式：**
```bash
cd examples/custom-tools
uv sync --reinstall
uv run main.py
```

### 4. kimi-cli-stream-json - JSON 流式交互

**功能说明：**
演示如何在子进程中运行 Kimi CLI，并通过标准输入输出使用 JSON 消息进行交互。

**核心特性：**
- 使用 `stream-json` 输入输出格式
- 异步子进程通信
- JSON 消息的序列化和反序列化
- 实时消息流处理

**关键代码结构：**
```python
proc = await asyncio.create_subprocess_exec(
    *KIMI_CLI_COMMAND.split(),
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    stdin=asyncio.subprocess.PIPE,
    stdout=asyncio.subprocess.PIPE,
)

# 发送 JSON 消息
user_message = {
    "role": "user",
    "content": "How many lines of code are there in the current working directory?",
}
proc.stdin.write(json.dumps(user_message).encode("utf-8") + b"\n")

# 接收响应流
while True:
    line = await proc.stdout.readline()
    message = json.loads(line.decode("utf-8"))
```

**使用场景：**
- 集成 Kimi CLI 到其他应用程序
- 构建自定义的前端界面
- 批量处理和自动化任务

**运行方式：**
```bash
cd examples/kimi-cli-stream-json
uv run main.py
```

### 5. kimi-cli-wire-messages - Wire 消息处理

**功能说明：**
演示如何创建和运行具有原始 Wire 消息输出的 Kimi CLI 实例。

**核心特性：**
- 直接使用 KimiCLI 类进行编程式调用
- Wire 消息的异步流处理
- 合并 Wire 消息选项
- 访问完整的会话历史

**关键代码结构：**
```python
instance = await KimiCLI.create(session)

async for msg in instance.run(
    user_input=user_input,
    cancel_event=asyncio.Event(),
    merge_wire_messages=True,
):
    print(msg)

# 访问会话历史
print(instance.soul.context.history[-1])
```

**使用场景：**
- 需要详细控制执行流程
- 调试和监控代理行为
- 构建自定义的 UI 或集成

**运行方式：**
```bash
cd examples/kimi-cli-wire-messages
uv sync --reinstall
uv run main.py
```

## 学习路径建议

### 初学者路径
1. **custom-echo-soul** → 理解基本 Soul 接口
2. **custom-tools** → 学习工具开发
3. **kimi-cli-wire-messages** → 了解程序化调用

### 进阶开发者路径
1. **custom-kimi-soul** → 扩展核心功能
2. **kimi-cli-stream-json** → 集成和自动化
3. **custom-tools** → 深度定制

### 项目集成路径
1. **kimi-cli-stream-json** → 子进程集成
2. **kimi-cli-wire-messages** → 直接 API 集成
3. **custom-kimi-soul** → 完全自定义实现

## 技术要点总结

### 核心概念
- **Soul**: 代理执行引擎，负责处理用户输入和协调工具调用
- **Tool**: 可重用的功能组件，通过标准化接口与 Soul 交互
- **Wire Message**: 系统内部的消息格式，用于组件间通信
- **Session**: 会话管理，维护上下文和历史记录

### 扩展方式
1. **继承扩展**: 继承现有类并重写方法
2. **组合扩展**: 通过配置和工具集组合功能
3. **接口实现**: 直接实现核心接口
4. **外部集成**: 通过进程或 API 调用

### 开发最佳实践
- 遵循现有的接口约定和命名规范
- 实现适当的错误处理和日志记录
- 使用类型提示提高代码可维护性
- 编写测试确保功能正确性
- 参考现有示例的目录结构和配置

## 常见问题

### Q: 如何选择合适的示例？
A: 根据你的具体需求：
- 学习基础概念 → custom-echo-soul
- 添加新功能 → custom-tools
- 集成到现有系统 → kimi-cli-stream-json
- 完全自定义 → custom-kimi-soul

### Q: 示例中的依赖如何管理？
A: 每个示例都有自己的 `pyproject.toml`，使用 `uv sync --reinstall` 安装依赖。

### Q: 如何调试示例代码？
A: 可以启用日志记录：`enable_logging()`，或者在代码中添加 print 语句进行调试。

### Q: 示例代码可以用于生产环境吗？
A: 示例主要用于学习和演示，生产使用前需要进行充分的测试和安全审查。

## 相关文档

- [架构设计](架构设计.md) - 了解 Kimi CLI 的整体架构
- [Agent 设计](agent-design.md) - 深入理解 Agent 系统
- [上下文管理](context-management.md) - 学习会话和上下文管理
- [Kosong 使用指南](Kosong使用指南.md) - 了解底层框架

---

通过这些示例，您可以全面了解 Kimi CLI 的扩展能力和使用方式，为构建自定义的 AI 代理应用提供坚实的基础。
