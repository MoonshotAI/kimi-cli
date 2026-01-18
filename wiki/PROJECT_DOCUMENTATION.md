# Kimi CLI 项目完整文档

## 项目概述

Kimi CLI 是一个基于 Python 的交互式命令行界面代理，专门用于软件开发任务和终端操作。该项目采用现代化的 Python 技术栈，提供了强大的 AI 编程助手功能，支持多种运行模式和丰富的工具生态系统。

### 核心特性

- **交互式 Shell 模式**: 类似 shell 的用户界面，支持直接命令执行
- **IDE 集成**: 通过 Agent Client Protocol (ACP) 支持与 Zed、JetBrains 等 IDE 集成
- **Zsh 集成**: 可与 Zsh shell 深度集成，增强终端体验
- **MCP 支持**: 支持 Model Context Protocol，可扩展外部工具
- **多模态运行**: 支持 shell、print、ACP、wire 四种运行模式
- **会话管理**: 支持会话持久化和恢复
- **代理系统**: 支持自定义代理和子代理任务委派

## 技术架构

### 技术栈

- **语言**: Python 3.13+
- **包管理**: uv (现代 Python 包管理器)
- **构建系统**: uv_build
- **CLI 框架**: Typer
- **LLM 集成**: kosong (自定义 LLM 框架)
- **异步运行时**: asyncio
- **UI 库**: prompt-toolkit、rich
- **配置管理**: pydantic、tomlkit
- **测试框架**: pytest + pytest-asyncio
- **代码质量**: ruff (格式化/检查)、pyright (类型检查)
- **文档工具**: 现有的 wiki 文档系统

### 项目结构

```
kimi-cli/
├── src/kimi_cli/           # 主要源代码
│   ├── agents/             # 内置代理配置
│   │   ├── default/        # 默认代理
│   │   └── okabe/          # Okabe 代理
│   ├── soul/               # 核心代理执行引擎
│   │   ├── kimisoul.py     # 主要执行逻辑
│   │   ├── agent.py        # 代理管理
│   │   ├── context.py      # 会话上下文
│   │   ├── denwarenji.py   # 通信枢纽
│   │   └── toolset.py      # 工具集管理
│   ├── tools/              # 工具实现
│   │   ├── bash/           # Shell 命令执行
│   │   ├── file/           # 文件操作工具
│   │   ├── web/            # Web 搜索和获取
│   │   ├── multiagent/     # 多代理支持
│   │   ├── dmail/          # 时间旅行消息系统
│   │   ├── think/          # 思考工具
│   │   └── todo/           # 任务管理
│   ├── ui/                 # 用户界面实现
│   │   ├── shell/          # 交互式 shell 界面
│   │   ├── print/          # 非交互模式
│   │   └── acp/            # ACP 服务器模式
│   ├── acp/                # Agent Client Protocol 实现
│   ├── wire/               # 通信协议层
│   ├── config.py           # 配置管理
│   ├── cli.py              # 命令行接口
│   └── app.py              # 应用主逻辑
├── tests/                  # 测试代码
├── tests_ai/              # AI 驱动测试
├── examples/              # 示例代码
├── wiki/                  # 项目文档
├── docs/                  # 文档资源
├── pyproject.toml         # 项目配置
├── Makefile              # 构建脚本
└── README.md             # 项目说明
```

## 核心组件详解

### 1. 代理系统 (Agent System)

代理系统是 Kimi CLI 的核心，基于 YAML 配置文件定义代理行为：

```yaml
# src/kimi_cli/agents/default/agent.yaml
version: 1
agent:
  name: ""
  system_prompt_path: ./system.md
  system_prompt_args:
    ROLE_ADDITIONAL: ""
  tools:
    - "kimi_cli.tools.multiagent:Task"
    - "kimi_cli.tools.todo:SetTodoList"
    - "kimi_cli.tools.shell:Shell"
    - "kimi_cli.tools.file:ReadFile"
    # ... 更多工具
  subagents:
    coder:
      path: ./sub.yaml
      description: "Good at general software engineering tasks."
```

**核心特性**:
- YAML 配置驱动
- 系统提示模板化
- 工具动态加载
- 子代理支持

### 2. Soul 架构

Soul 是代理的执行引擎，负责协调各个组件：

```python
class KimiSoul:
    """Kimi CLI 的灵魂"""
    
    def __init__(self, agent: Agent, *, context: Context):
        self._agent = agent
        self._runtime = agent.runtime
        self._denwa_renji = agent.runtime.denwa_renji
        self._approval = agent.runtime.approval
        self._context = context
```

**关键组件**:
- **KimiSoul**: 主要执行引擎
- **Context**: 会话历史管理
- **DenwaRenji**: 通信枢纽
- **Approval**: 用户确认机制

### 3. 工具系统 (Tool System)

工具系统采用模块化设计，支持依赖注入：

**可用工具类别**:
- **Shell**: 执行 shell 命令
- **File**: 文件操作 (ReadFile, WriteFile, Glob, Grep, StrReplaceFile)
- **Web**: Web 搜索和 URL 获取 (SearchWeb, FetchURL)
- **MultiAgent**: 任务委派 (Task, CreateSubagent)
- **Todo**: 任务管理 (SetTodoList)
- **Think**: 内部推理 (Think)
- **DMail**: 时间旅行消息 (SendDMail)

**工具开发模式**:
```python
# 工具定义示例
class MyTool:
    def __init__(self, runtime: Runtime, config: Config, session: Session):
        self.runtime = runtime
        self.config = config
        self.session = session
    
    def __call__(self, param1: str, param2: int = 10) -> str:
        # 工具实现
        return result
```

### 4. UI 系统

支持多种用户界面模式：

#### Shell 模式 (默认)
- 交互式终端界面
- 支持 Ctrl-X 切换到 shell 模式
- 丰富的斜杠命令支持

#### Print 模式
- 非交互模式，适合脚本调用
- 支持 JSON 流输入输出
- 自动确认所有操作

#### ACP 模式
- Agent Client Protocol 服务器
- 支持与 IDE 集成
- 标准化协议通信

#### Wire 模式 (实验性)
- 原始 Wire 协议通信
- 低级 API 接口

### 5. 配置系统

基于 TOML 的配置管理：

```toml
# ~/.kimi/config.toml
[models.my-model]
provider = "kimi"
model = "kimi-chat"
max_context_size = 128000

[providers.kimi]
type = "kimi"
base_url = "https://api.moonshot.cn/v1"
api_key = "your-api-key"

[loop_control]
max_steps_per_run = 100
max_retries_per_step = 3
```

**配置特性**:
- 支持多模型和多提供商
- 环境变量覆盖
- 自动配置迁移
- 类型安全的验证

## 开发环境搭建

### 环境要求

- Python 3.13+
- uv (现代 Python 包管理器)
- Git

### 快速开始

1. **克隆项目**:
```bash
git clone https://github.com/MoonshotAI/kimi-cli.git
cd kimi-cli
```

2. **准备开发环境**:
```bash
make prepare  # 等同于: uv sync --frozen --all-extras
```

3. **运行项目**:
```bash
uv run kimi  # 运行 CLI
```

### 开发命令

```bash
# 代码格式化
make format  # 等同于: uv run ruff check --fix && uv run ruff format

# 代码检查
make check   # 等同于: uv run ruff check && uv run ruff format --check && uv run pyright

# 运行测试
make test    # 等同于: uv run pytest tests -vv

# 构建可执行文件
make build   # 等同于: uv run pyinstaller kimi.spec

# AI 驱动测试
make ai-test # 等同于: uv run tests_ai/scripts/run.py tests_ai
```

## 测试策略

### 测试架构

- **单元测试**: 覆盖所有工具和核心组件
- **集成测试**: 端到端工作流测试
- **Mock 提供商**: LLM 交互模拟，确保测试一致性
- **Async 测试**: 完整的异步/等待测试支持

### 测试文件组织

```
tests/
├── test_load_agent.py          # 代理加载测试
├── test_bash.py                # Shell 命令测试
├── test_*_file.py              # 文件操作工具测试
├── test_task_subagents.py      # 子代理功能测试
├── test_web_search.py          # Web 功能测试
├── test_config.py              # 配置系统测试
└── fixtures/                   # 测试夹具和辅助数据
```

### 运行测试

```bash
# 运行所有测试
uv run pytest tests -vv

# 运行特定测试文件
uv run pytest tests/test_bash.py -vv

# 运行带覆盖率的测试
uv run pytest tests --cov=src/kimi_cli
```

## 构建和部署

### 构建系统

项目使用 `uv_build` 作为构建后端，支持现代 Python 打包：

```python
# pyproject.toml
[build-system]
requires = ["uv_build>=0.8.5,<0.10.0"]
build-backend = "uv_build"

[tool.uv.build-backend]
module-name = ["kimi_cli"]
source-exclude = ["examples/**/*", "tests/**/*", "src/kimi_cli/deps/**/*"]
```

### 可执行文件构建

使用 PyInstaller 构建独立可执行文件：

```bash
uv run pyinstaller kimi.spec
```

生成的可执行文件位于 `dist/` 目录，可以独立运行而无需 Python 环境。

### PyPI 发布

项目发布为 `kimi-cli` 包：

```bash
# 用户安装
uv tool install --python 3.13 kimi-cli

# 升级
uv tool upgrade kimi-cli --no-cache
```

## 扩展开发

### 自定义工具开发

创建自定义工具的步骤：

1. **创建工具类**:
```python
# my_tool.py
from kimi_cli.soul.agent import Runtime
from kimi_cli.config import Config

class MyCustomTool:
    def __init__(self, runtime: Runtime, config: Config):
        self.runtime = runtime
        self.config = config
    
    def __call__(self, input_text: str) -> str:
        # 实现工具逻辑
        return f"Processed: {input_text}"
```

2. **注册工具**:
```yaml
# agent.yaml
tools:
  - "my_module.my_tool:MyCustomTool"
```

### 自定义代理开发

1. **创建代理配置**:
```yaml
# my_agent/agent.yaml
version: 1
agent:
  name: "My Custom Agent"
  system_prompt_path: ./system.md
  tools:
    - "kimi_cli.tools.shell:Shell"
    - "my_module.my_tool:MyCustomTool"
```

2. **定义系统提示**:
```markdown
<!-- my_agent/system.md -->
你是一个专门处理 {TASK_TYPE} 的代理...
```

3. **使用自定义代理**:
```bash
kimi --agent-file my_agent/agent.yaml
```

## 使用场景和最佳实践

### 1. 日常开发工作流

```bash
# 启动 kimi 并设置
kimi
/setup  # 配置 API

# 使用场景
"帮我重构这个函数"  # 代码重构
"写单元测试"       # 测试编写
"修复这个 bug"     # 问题调试
"优化性能"         # 性能分析
```

### 2. 脚本集成

```bash
# 非交互模式
kimi --print --command "生成配置文件" --output-format stream-json
```

### 3. IDE 集成

```json
// ~/.config/zed/settings.json
{
  "agent_servers": {
    "Kimi CLI": {
      "command": "kimi",
      "args": ["--acp"],
      "env": {}
    }
  }
}
```

### 4. MCP 工具集成

```json
{
  "mcpServers": {
    "my-custom-tool": {
      "command": "node",
      "args": ["my-mcp-server.js"]
    }
  }
}
```

## 性能优化

### 内存管理

- 使用 SimpleCompaction 进行上下文压缩
- 配置适当的 max_context_size
- 定期清理空会话

### 并发处理

- 异步工具执行
- 非阻塞用户交互
- 流式响应处理

### 缓存策略

- 会话持久化
- 配置缓存
- 工具结果缓存

## 安全考虑

### 文件系统访问

- 默认限制在工作目录
- 用户确认机制
- 安全的路径处理

### API 密钥管理

- SecretStr 类型保护
- 环境变量支持
- 配置文件权限控制

### Shell 命令执行

- 用户确认提示
- 命令白名单机制
- 安全的 shell 调用

## 故障排查

### 常见问题

1. **配置问题**:
```bash
# 检查配置
kimi --debug  # 启用调试日志
```

2. **模型连接**:
```bash
# 检查 API 配置
export KIMI_API_KEY="your-key"
export KIMI_BASE_URL="https://api.moonshot.cn/v1"
```

3. **权限问题**:
```bash
# 检查工作目录权限
ls -la
chmod +x scripts
```

### 日志分析

日志文件位置：`~/.kimi/logs/kimi.log`

```bash
# 实时查看日志
tail -f ~/.kimi/logs/kimi.log
```

## 社区和贡献

### 贡献指南

1. **代码质量**: 确保代码符合项目标准
2. **测试覆盖**: 新功能必须包含测试
3. **文档更新**: 同步更新相关文档
4. **提交规范**: 遵循 Conventional Commits

### 提交流程

1. Fork 项目
2. 创建特性分支
3. 提交代码和测试
4. 发起 Pull Request
5. 代码审查和合并

### 社区资源

- **GitHub**: https://github.com/MoonshotAI/kimi-cli
- **Issues**: 报告 bug 和功能请求
- **Wiki**: 详细文档和教程
- **Discussions**: 社区讨论

## 版本历史和路线图

### 当前版本特性

- 支持多种 UI 模式
- 完整的工具生态系统
- ACP 和 MCP 协议支持
- 强大的配置系统

### 未来规划

- 更多内置工具
- 性能优化
- 更丰富的集成选项
- 插件系统

---

**文档维护**: Kimi CLI 开发团队  
**最后更新**: 2025-12-20  
**项目版本**: 0.66  

本文档涵盖了 Kimi CLI 项目的完整技术架构、开发指南和使用说明。如需更详细的信息，请参考项目源码中的具体实现和 wiki 文档。