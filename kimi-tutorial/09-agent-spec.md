# 第 9 章：Agent 规范

到目前为止，我们的 Agent 配置都是硬编码在 Python 代码里的。但如果你想：

- 🎨 快速调整系统提示词
- 🔧 启用/禁用某些工具
- 🤖 创建专门的子 Agent

每次都要修改代码、重新安装，太麻烦了！

在这一章，我们将学习如何用 **YAML 配置文件**定义 Agent——这就是 kimi-cli 的做法。

## 9.1 为什么用配置文件？

### 代码 vs 配置

```python
# ❌ 硬编码：每次修改都要重启
agent = Agent(
    name="my-agent",
    system_prompt="You are a helpful assistant...",
    tools=[ReadFile(), WriteFile(), Shell()]
)
```

```yaml
# ✅ 配置文件：热重载，易于维护
agent:
  name: my-agent
  system_prompt_path: ./system.md
  tools:
    - tools.file:ReadFile
    - tools.file:WriteFile
    - tools.shell:Shell
```

### 配置文件的优势

- ✅ **可读性强**：一目了然
- ✅ **易于修改**：不需要重新编译/安装
- ✅ **可复用**：轻松创建多个 Agent 变体
- ✅ **版本控制友好**：YAML 易于 diff

## 9.2 设计 Agent 规范

让我们设计一个简单但强大的 Agent 配置格式：

```yaml
# agent.yaml

version: 1  # 规范版本

agent:
  name: "coder-agent"  # Agent 名称

  # 系统提示词（支持模板变量）
  system_prompt_path: ./system.md
  system_prompt_args:
    ROLE: "Python 专家"
    EXPERTISE: "重构和优化"

  # 工具列表（模块路径:类名）
  tools:
    - "kimi_cli.tools.file:ReadFile"
    - "kimi_cli.tools.file:WriteFile"
    - "kimi_cli.tools.shell:Shell"

  # 子 Agent（可选）
  subagents:
    tester:
      path: ./subagents/tester.yaml
      description: "专门负责编写测试"
```

## 9.3 系统提示词模板

系统提示词通常很长，单独存放在 Markdown 文件中：

```markdown
<!-- system.md -->

You are ${ROLE}, a coding assistant with expertise in ${EXPERTISE}.

## Current Context

- Time: ${KIMI_NOW}
- Working Directory: ${KIMI_WORK_DIR}
- Directory Contents:
${KIMI_WORK_DIR_LS}

## Tools

You have access to these tools:
- ReadFile: Read file contents
- WriteFile: Create or modify files
- Shell: Execute shell commands

## Guidelines

1. Always read files before modifying them
2. Explain your changes clearly
3. Write clean, well-documented code
4. Run tests after making changes
```

### 模板变量

- `${ROLE}`: 从 `system_prompt_args` 注入
- `${KIMI_NOW}`: 自动注入当前时间
- `${KIMI_WORK_DIR}`: 工作目录
- `${KIMI_WORK_DIR_LS}`: 目录列表

## 9.4 实现配置加载器

```python
# agent_spec.py

import yaml
from pathlib import Path
from typing import Dict, Any
from datetime import datetime
import os

class AgentSpec:
    """Agent 规范"""

    def __init__(self, config_path: Path):
        """加载 Agent 配置

        Args:
            config_path: agent.yaml 文件路径
        """
        self.config_path = config_path
        self.config_dir = config_path.parent

        # 加载 YAML
        with open(config_path) as f:
            self.config = yaml.safe_load(f)

        # 验证版本
        if self.config.get("version") != 1:
            raise ValueError("Unsupported agent spec version")

    @property
    def name(self) -> str:
        """Agent 名称"""
        return self.config["agent"]["name"]

    def load_system_prompt(self, work_dir: Path) -> str:
        """加载并渲染系统提示词

        Args:
            work_dir: 工作目录（用于模板变量）

        Returns:
            渲染后的系统提示词
        """
        # 读取模板
        prompt_path = self.config_dir / self.config["agent"]["system_prompt_path"]
        with open(prompt_path) as f:
            template = f.read()

        # 准备模板变量
        template_args = self._get_template_args(work_dir)

        # 渲染模板
        rendered = self._render_template(template, template_args)

        return rendered

    def _get_template_args(self, work_dir: Path) -> Dict[str, str]:
        """获取模板变量"""

        args = {}

        # 1. 用户定义的变量
        user_args = self.config["agent"].get("system_prompt_args", {})
        args.update(user_args)

        # 2. 系统内置变量
        args["KIMI_NOW"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        args["KIMI_WORK_DIR"] = str(work_dir)

        # 3. 目录列表
        try:
            ls_output = "\n".join([
                f"  {item.name}{'/' if item.is_dir() else ''}"
                for item in sorted(work_dir.iterdir())
            ])
            args["KIMI_WORK_DIR_LS"] = ls_output
        except:
            args["KIMI_WORK_DIR_LS"] = "(无法读取)"

        return args

    def _render_template(self, template: str, args: Dict[str, str]) -> str:
        """渲染模板（简单的 ${VAR} 替换）"""

        result = template
        for key, value in args.items():
            result = result.replace(f"${{{key}}}", str(value))

        return result

    def get_tools(self) -> list[str]:
        """获取工具列表"""
        return self.config["agent"].get("tools", [])

    def get_subagents(self) -> Dict[str, Dict[str, Any]]:
        """获取子 Agent 配置"""
        return self.config["agent"].get("subagents", {})
```

## 9.5 加载 Agent

现在我们可以从配置文件创建 Agent：

```python
# agent_loader.py

from pathlib import Path
from agent_spec import AgentSpec
from tools.registry import ToolRegistry
from tools.loader import load_tool_class

def load_agent_from_spec(
    spec_path: Path,
    work_dir: Path,
    dependencies: dict
) -> Agent:
    """从规范文件加载 Agent"""

    # 1. 加载规范
    spec = AgentSpec(spec_path)

    # 2. 加载系统提示词
    system_prompt = spec.load_system_prompt(work_dir)

    # 3. 创建工具注册表
    registry = ToolRegistry()

    # 4. 加载工具
    for tool_path in spec.get_tools():
        # tool_path 格式: "module.path:ClassName"
        tool_class = load_tool_class(tool_path)
        tool_instance = tool_class(**dependencies)
        registry.register(tool_instance)

    # 5. 递归加载子 Agent
    subagents = {}
    for sub_name, sub_config in spec.get_subagents().items():
        sub_path = spec.config_dir / sub_config["path"]
        subagents[sub_name] = load_agent_from_spec(
            sub_path, work_dir, dependencies
        )

    # 6. 创建 Agent
    agent = Agent(
        name=spec.name,
        system_prompt=system_prompt,
        registry=registry,
        subagents=subagents
    )

    return agent
```

## 9.6 使用示例

### 创建 Agent 配置

```bash
my-agent/
├── agents/
│   ├── main.yaml
│   ├── system.md
│   └── subagents/
│       ├── tester.yaml
│       └── tester-system.md
```

**`agents/main.yaml`**:

```yaml
version: 1
agent:
  name: "main-agent"
  system_prompt_path: ./system.md
  system_prompt_args:
    ROLE: "全栈工程师"

  tools:
    - "tools.file:ReadFile"
    - "tools.file:WriteFile"
    - "tools.shell:Shell"

  subagents:
    tester:
      path: ./subagents/tester.yaml
      description: "编写和运行测试"
```

**`agents/system.md`**:

```markdown
You are a ${ROLE}.

Current directory: ${KIMI_WORK_DIR}

Contents:
${KIMI_WORK_DIR_LS}

Use your tools to help the user with their coding tasks.
```

### 加载并运行

```python
from pathlib import Path
from agent_loader import load_agent_from_spec

# 准备依赖
dependencies = {
    "work_dir": Path.cwd(),
    "approval": approval_system,
    # ...
}

# 加载 Agent
agent = load_agent_from_spec(
    spec_path=Path("agents/main.yaml"),
    work_dir=Path.cwd(),
    dependencies=dependencies
)

# 运行
await agent.run("帮我创建一个新功能")
```

## 9.7 高级特性：继承

有时多个 Agent 有相同的基础配置，我们可以支持继承：

```yaml
# base-agent.yaml
version: 1
agent:
  name: "base"
  system_prompt_path: ./base-system.md
  tools:
    - "tools.file:ReadFile"
    - "tools.file:WriteFile"
```

```yaml
# python-agent.yaml
version: 1
extends: ./base-agent.yaml  # 继承基础配置
agent:
  name: "python-expert"
  system_prompt_args:
    LANGUAGE: "Python"
  tools:
    # 继承 base 的工具，然后添加新的
    - "tools.python:PythonREPL"
```

实现继承：

```python
class AgentSpec:
    def __init__(self, config_path: Path):
        with open(config_path) as f:
            self.config = yaml.safe_load(f)

        # 处理继承
        if "extends" in self.config:
            base_path = config_path.parent / self.config["extends"]
            base_spec = AgentSpec(base_path)

            # 合并配置（深度合并）
            self.config = self._merge_configs(
                base_spec.config,
                self.config
            )

    def _merge_configs(self, base: dict, override: dict) -> dict:
        """深度合并配置"""
        result = base.copy()

        for key, value in override.items():
            if key == "extends":
                continue  # 跳过 extends 字段

            if isinstance(value, dict) and key in result:
                result[key] = self._merge_configs(result[key], value)
            elif isinstance(value, list) and key in result:
                # 列表：合并（去重）
                result[key] = result[key] + value
            else:
                result[key] = value

        return result
```

## 9.8 小结

Agent 规范让我们能够：

- ✅ **声明式配置**：用 YAML 定义 Agent
- ✅ **模板系统**：动态生成系统提示词
- ✅ **工具管理**：灵活添加/移除工具
- ✅ **子 Agent**：组织复杂的 Agent 层次
- ✅ **配置继承**：复用通用配置

这种设计让 Agent 的创建和维护变得非常简单——改配置文件就行，不用动代码！

在下一章，我们将进入高级特性：**多代理系统**已经在第 10 章讲过了，所以我们直接跳到第 11 章：**时间旅行**！

---

**上一章**：[第 8 章：审批系统](./08-approval-system.md) ←
**下一章**：[第 10 章：多代理系统](./10-multiagent.md) →
