# 附录 A：Kimi-CLI 架构总览

本附录提供 kimi-cli 的完整架构概述，作为快速参考。

## A.1 整体架构图

```
┌─────────────────────────────────────────────────────────┐
│                    Kimi-CLI                              │
└─────────────────────────────────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
        ▼                  ▼                  ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│     CLI      │   │      UI      │   │    Config    │
│   (cli.py)   │   │   Modes      │   │  (config.py) │
└──────┬───────┘   └──────────────┘   └──────────────┘
       │                  │
       │           ┌──────┴──────┐
       │           │             │
       │           ▼             ▼
       │    ┌──────────┐  ┌──────────┐
       │    │  Shell   │  │   ACP    │
       │    │   Mode   │  │   Mode   │
       │    └──────────┘  └──────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│              KimiCLI (app.py)                            │
│  - 应用主入口                                             │
│  - 协调各个组件                                           │
└────────────────────┬────────────────────────────────────┘
                     │
        ┌────────────┼────────────┐
        │            │            │
        ▼            ▼            ▼
┌──────────┐  ┌──────────┐  ┌──────────┐
│  Agent   │  │  Soul    │  │ Runtime  │
│  Spec    │  │  (执行)   │  │  (运行时) │
└──────────┘  └──────────┘  └──────────┘
        │            │            │
        └────────────┼────────────┘
                     │
        ┌────────────┼────────────┐
        │            │            │
        ▼            ▼            ▼
┌──────────┐  ┌──────────┐  ┌──────────┐
│  Tools   │  │ Context  │  │   LLM    │
│  (工具)   │  │ (上下文)  │  │  (模型)  │
└──────────┘  └──────────┘  └──────────┘
        │
        └────> KAOS (文件系统抽象)
```

## A.2 目录结构

```
kimi-cli/
├── src/
│   ├── kimi_cli/              # 主应用
│   │   ├── agents/            # Agent 配置
│   │   │   ├── default/       # 默认 Agent
│   │   │   │   ├── agent.yaml
│   │   │   │   └── system.md
│   │   │   └── subagents/     # 子 Agent
│   │   │
│   │   ├── soul/              # 执行引擎
│   │   │   ├── kimisoul.py    # 主执行循环
│   │   │   ├── context.py     # 上下文管理
│   │   │   ├── agent.py       # Agent 加载
│   │   │   ├── approval.py    # 审批系统
│   │   │   └── denwarenji.py  # 时间旅行
│   │   │
│   │   ├── tools/             # 工具实现
│   │   │   ├── file.py        # 文件操作
│   │   │   ├── shell.py       # Shell 执行
│   │   │   ├── multiagent.py  # 子 Agent 委派
│   │   │   ├── web.py         # Web 搜索/抓取
│   │   │   └── ...
│   │   │
│   │   ├── ui/                # UI 模式
│   │   │   ├── shell/         # 交互式 Shell
│   │   │   ├── print/         # 非交互模式
│   │   │   ├── acp/           # Agent Client Protocol
│   │   │   └── wire/          # Wire Protocol
│   │   │
│   │   ├── wire/              # Wire 协议实现
│   │   ├── utils/             # 工具函数
│   │   │
│   │   ├── cli.py             # CLI 入口
│   │   ├── app.py             # 应用主类
│   │   ├── config.py          # 配置管理
│   │   ├── llm.py             # LLM 抽象
│   │   ├── session.py         # 会话管理
│   │   ├── agentspec.py       # Agent 规范
│   │   └── metadata.py        # 元数据
│   │
│   └── kaos/                  # KAOS 抽象层
│       ├── __init__.py        # 协议定义
│       ├── path.py            # 抽象路径
│       └── local.py           # 本地实现
│
├── tests/                     # 测试
├── pyproject.toml             # 项目配置
└── README.md
```

## A.3 核心组件详解

### A.3.1 CLI 层 (`cli.py`)

**职责**：解析命令行参数，启动应用

```python
@app.command()
def main(
    agent_file: Path,     # Agent 配置文件
    model: str,           # 模型名称
    work_dir: Path,       # 工作目录
    continue_: bool,      # 继续上次会话
    command: str,         # 一次性命令
    # ... 更多参数
):
    # 创建 KimiCLI 实例并运行
    pass
```

**关键功能**：
- 参数验证
- 配置加载
- UI 模式选择（shell/print/acp/wire）

### A.3.2 应用层 (`app.py`)

**职责**：协调各个组件，管理应用生命周期

```python
class KimiCLI:
    def __init__(self, config, session, agent, ui_mode):
        self.config = config
        self.session = session
        self.agent = agent
        self.ui = ui_mode

    async def run(self):
        # 1. 加载 Agent
        # 2. 创建 Soul
        # 3. 启动 UI
        # 4. 运行主循环
        pass
```

### A.3.3 Soul 层 (`soul/kimisoul.py`)

**职责**：Agent 的"灵魂"，执行主循环

```python
class KimiSoul:
    """Agent 执行引擎"""

    async def run(self, user_input: str) -> str:
        """主执行循环"""
        # 1. Checkpoint
        # 2. 调用 LLM
        # 3. 执行工具
        # 4. 更新上下文
        # 5. 循环直到完成
        pass

    async def _execute_tool(self, tool_call):
        """执行单个工具"""
        pass
```

**关键特性**：
- 支持思维模式（Thinking）
- 上下文压缩（Compaction）
- 重试机制（Tenacity）
- Token 统计

### A.3.4 Context (`soul/context.py`)

**职责**：管理对话历史

```python
class Context:
    """上下文管理器"""

    def __init__(self, history_file: Path):
        self.messages: List[dict] = []
        self.history_file = history_file

    def append(self, message: dict):
        """添加消息"""
        self.messages.append(message)
        self._persist(message)

    def _persist(self, message: dict):
        """持久化到 JSONL 文件"""
        with open(self.history_file, 'a') as f:
            f.write(json.dumps(message) + '\n')
```

### A.3.5 Agent Spec (`soul/agent.py`)

**职责**：加载和解析 Agent 配置

```python
@dataclass
class Agent:
    """Agent 数据类"""
    name: str
    system_prompt: str
    toolset: KimiToolset
    subagents: Dict[str, "Agent"]

def load_agent(config_path: Path, ...) -> Agent:
    """从 YAML 加载 Agent"""
    # 1. 解析 YAML
    # 2. 加载系统提示词
    # 3. 加载工具
    # 4. 递归加载子 Agent
    pass
```

### A.3.6 Tools (`tools/`)

**职责**：实现各种工具

```python
class ReadFile(CallableTool2[ReadFileParams]):
    """读取文件工具"""

    name = "ReadFile"
    description = "读取文件内容"
    params = ReadFileParams

    async def __call__(self, params: ReadFileParams) -> ToolReturnType:
        # 执行文件读取
        return ToolOk(output=content)
```

**工具列表**：

| 工具 | 描述 |
|------|------|
| `ReadFile` | 读取文件内容 |
| `WriteFile` | 写入文件 |
| `Glob` | 文件模式匹配 |
| `Grep` | 内容搜索 |
| `StrReplaceFile` | 字符串替换 |
| `Shell` | 执行 Shell 命令 |
| `SearchWeb` | Web 搜索 |
| `FetchURL` | 抓取 URL |
| `Task` | 委派给子 Agent |
| `SendDMail` | 时间旅行 |
| `Think` | 内部推理 |
| `SetTodoList` | 设置待办事项 |

### A.3.7 KAOS (`kaos/`)

**职责**：文件系统抽象层

```python
class Kaos(Protocol):
    """Agent 操作系统协议"""

    def chdir(self, path: str) -> None:
        """切换目录"""
        ...

    def readtext(self, path: str) -> str:
        """读取文件"""
        ...

    def glob(self, pattern: str) -> List[KaosPath]:
        """文件匹配"""
        ...
```

**实现**：
- `LocalKaos`：本地文件系统
- （未来）`RemoteKaos`：远程文件系统

### A.3.8 Config (`config.py`)

**职责**：管理配置

```python
@dataclass
class Config:
    """全局配置"""

    # LLM 配置
    llm_providers: Dict[str, LLMProvider]
    llm_models: Dict[str, LLMModel]

    # 服务配置
    moonshot_search_key: str
    moonshot_fetch_key: str

    # 循环控制
    max_steps: int = 100
    max_retries: int = 3
```

**配置文件**：`~/.kimi/config.json`

### A.3.9 UI Modes (`ui/`)

**职责**：不同的用户界面

#### Shell Mode (`ui/shell/`)
- 交互式 REPL
- Rich 终端美化
- 命令历史
- 元命令（/help, /debug 等）

#### Print Mode (`ui/print/`)
- 非交互模式
- 适合脚本和 CI/CD
- 支持 JSON 输出

#### ACP Mode (`ui/acp/`)
- Agent Client Protocol
- IDE 集成（Zed 等）
- 实时流式输出

#### Wire Mode (`ui/wire/`)
- 自定义协议
- JSON-RPC
- 用于高级集成

## A.4 数据流

### A.4.1 消息流

```
用户输入
   │
   ▼
┌────────────┐
│   CLI      │
└──────┬─────┘
       │
       ▼
┌────────────┐
│    UI      │
│   Mode     │
└──────┬─────┘
       │
       ▼
┌────────────┐
│   Soul     │ ◀──── Context
└──────┬─────┘
       │
       ▼
┌────────────┐
│    LLM     │
└──────┬─────┘
       │
       ▼
   Tool Calls?
   ╱        ╲
  是          否
 ╱              ╲
▼                ▼
执行工具       返回结果
│                 │
▼                 │
KAOS/Tools        │
│                 │
└────────┐        │
         │        │
         ▼        ▼
      添加到 Context
         │
         └───> (循环)
```

### A.4.2 配置流

```
命令行参数
   │
   ▼
环境变量
   │
   ▼
~/.kimi/config.json
   │
   ▼
Agent YAML
   │
   ▼
系统提示词模板
   │
   ▼
最终配置
```

### A.4.3 会话流

```
开始会话
   │
   ▼
创建 Session ID
   │
   ▼
加载历史（如果 --continue）
   │
   ▼
初始化 Context
   │
   ▼
运行主循环
   │
   ▼
保存历史到 JSONL
   │
   ▼
结束会话
```

## A.5 关键设计模式

### A.5.1 协议（Protocol）

使用 Python 的 `Protocol` 实现接口：

```python
class Soul(Protocol):
    """Soul 协议"""
    async def run(self, input: str) -> str: ...

class Kaos(Protocol):
    """KAOS 协议"""
    def readtext(self, path: str) -> str: ...
```

### A.5.2 依赖注入

工具通过构造函数接收依赖：

```python
class ReadFile(CallableTool2):
    def __init__(
        self,
        kaos: Kaos,          # 文件系统
        config: Config,      # 配置
        approval: Approval,  # 审批
        **kwargs
    ):
        self._kaos = kaos
        self._config = config
        self._approval = approval
```

### A.5.3 泛型工具

使用泛型确保类型安全：

```python
TParams = TypeVar("TParams", bound=BaseModel)

class CallableTool2(Generic[TParams]):
    params: type[TParams]

    async def __call__(self, params: TParams) -> ToolReturnType:
        ...
```

### A.5.4 异步优先

所有 I/O 操作都是异步的：

```python
async def run(self, input: str) -> str:
    response = await self.llm.generate(...)
    result = await self.tool.execute(...)
    return response
```

## A.6 配置示例

### Agent 配置

```yaml
version: 1
agent:
  name: "kimi-agent"
  system_prompt_path: ./system.md
  system_prompt_args:
    ROLE_ADDITIONAL: "专注于 Python 开发"

  tools:
    - "kimi_cli.tools.file:ReadFile"
    - "kimi_cli.tools.shell:Shell"

  subagents:
    coder:
      path: ./subagents/coder.yaml
      description: "编程专家"
```

### 系统提示词

```markdown
# system.md

You are ${AGENT_NAME}, a helpful coding assistant.

Current time: ${KIMI_NOW}
Working directory: ${KIMI_WORK_DIR}

${ROLE_ADDITIONAL}

# Tools

You have access to these tools:
- ReadFile: Read files
- Shell: Execute commands

# Guidelines

- Always read before editing
- Explain your actions
```

### 全局配置

```json
{
  "llm_providers": {
    "kimi": {
      "base_url": "https://api.moonshot.cn/v1",
      "api_key": "sk-..."
    }
  },
  "llm_models": {
    "kimi": {
      "name": "moonshot-v1-128k",
      "max_context_size": 128000
    }
  },
  "max_steps": 100
}
```

## A.7 扩展点

### 添加新工具

1. 实现 `CallableTool2[TParams]`
2. 在 Agent 配置中添加工具路径

### 添加新 UI 模式

1. 实现 UI 接口
2. 在 `cli.py` 中注册

### 添加新 LLM 提供商

1. 在 `config.json` 添加配置
2. 使用统一的 LLM 接口

## A.8 性能考虑

### Token 管理

- 自动上下文压缩
- 工具输出截断
- 历史消息裁剪

### 并发

- 异步 I/O
- 并行工具执行（未来）
- 并行子 Agent（未来）

### 缓存

- 文件内容缓存
- LLM 响应缓存（未来）

---

这个架构总览为你提供了 kimi-cli 的全景视图。随时参考本附录以理解各个组件如何协同工作！

**返回**：[README](./README.md)
