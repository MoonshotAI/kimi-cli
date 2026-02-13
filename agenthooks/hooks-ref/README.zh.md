# agenthooks-ref

Agent Hooks 的参考实现库。

> **注意：** 此库仅用于演示目的，不适用于生产环境。

## 安装

### macOS / Linux

使用 pip：

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e .
```

或使用 [uv](https://docs.astral.sh/uv/)：

```bash
uv sync
source .venv/bin/activate
```

### Windows

使用 pip (PowerShell)：

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -e .
```

使用 pip (命令提示符)：

```cmd
python -m venv .venv
.venv\Scripts\activate.bat
pip install -e .
```

或使用 [uv](https://docs.astral.sh/uv/)：

```powershell
uv sync
.venv\Scripts\Activate.ps1
```

安装后，`agenthooks-ref` 可执行文件将在您的 `PATH` 中可用（在激活的虚拟环境中）。

## 用法

### CLI

```bash
# 验证钩子
agenthooks-ref validate path/to/hook

# 读取钩子属性（输出 JSON）
agenthooks-ref read-properties path/to/hook

# 列出所有发现的钩子
agenthooks-ref list

# 在默认位置发现钩子
agenthooks-ref discover

# 生成 <available_hooks> XML 用于代理提示词
agenthooks-ref to-prompt path/to/hook-a path/to/hook-b
```

### Python API

```python
from pathlib import Path
from agenthooks_ref import validate, read_properties, to_prompt

# 验证钩子目录
result = validate(Path("my-hook"))
if result.valid:
    print("Valid hook!")
else:
    print("Errors:", result.errors)

# 读取钩子属性
props = read_properties(Path("my-hook"))
print(f"Hook: {props.name} - {props.description}")
print(f"Trigger: {props.trigger.value}")

# 生成可用钩子的提示词
prompt = to_prompt([Path("hook-a"), Path("hook-b")])
print(prompt)
```

### 发现功能

```python
from agenthooks_ref import (
    discover_user_hooks,
    discover_project_hooks,
    load_hooks,
    load_hooks_by_trigger,
)

# 发现用户级别钩子 (~/.config/agents/hooks/)
user_hooks = discover_user_hooks()

# 发现项目级别钩子 (./.agents/hooks/)
project_hooks = discover_project_hooks()

# 加载所有钩子及其元数据
all_hooks = load_hooks()

# 按触发器加载钩子
before_tool_hooks = load_hooks_by_trigger("before_tool")
```

## 代理提示词集成

使用 `to-prompt` 生成建议的 `<available_hooks>` XML 块，用于代理的系统提示词：

```xml
<available_hooks>
<hook>
<name>
block-dangerous-commands
</name>
<description>
Blocks dangerous shell commands like rm -rf /
</description>
<trigger>
before_tool
</trigger>
<location>
/path/to/block-dangerous-commands/HOOK.md
</location>
</hook>
</available_hooks>
```

`<location>` 元素告诉代理在哪里找到完整的钩子说明。

## 许可证

Apache 2.0
