# 第 14 章：UI 模式

同一个 Agent，不同的使用场景。

- 👨‍💻 开发者：想要**命令行交互**
- 🤖 CI/CD：需要**脚本化执行**
- 💻 IDE 用户：希望**编辑器集成**

一个好的 Agent 应该支持多种 UI 模式。kimi-cli 支持 4 种：Shell、Print、ACP、Wire。

## 14.1 四种 UI 模式

### Mode 1: Shell（交互式）

```bash
$ kimi

> 你: 读取 README.md
Agent: [读取文件...]
这是项目的 README 文件...

> 你: 修改第一行
Agent: [修改文件...]
已完成！

> 你: quit
再见！
```

### Mode 2: Print（脚本化）

```bash
$ kimi --command "读取 README.md" --mode print
正在读取 README.md...
[文件内容]
```

### Mode 3: ACP（IDE 集成）

IDE（如 Zed）通过 Agent Client Protocol 与 Agent 通信，实时显示进度。

### Mode 4: Wire（自定义协议）

用于高级集成场景，JSON-RPC 通信。

## 14.2 实现 UI 抽象

```python
# ui/base.py

from typing import Protocol

class UI(Protocol):
    """UI 接口"""

    async def display_message(self, role: str, content: str):
        """显示消息"""
        ...

    async def get_user_input(self) -> str:
        """获取用户输入"""
        ...

    async def show_tool_call(self, tool_name: str, params: dict):
        """显示工具调用"""
        ...
```

### Shell Mode 实现

```python
# ui/shell.py

from rich.console import Console
from rich.prompt import Prompt

class ShellUI:
    """交互式 Shell UI"""

    def __init__(self):
        self.console = Console()

    async def display_message(self, role: str, content: str):
        if role == "user":
            self.console.print(f"[bold blue]你[/bold blue]: {content}")
        elif role == "assistant":
            self.console.print(f"[bold yellow]Agent[/bold yellow]: {content}")

    async def get_user_input(self) -> str:
        return Prompt.ask("[bold blue]你[/bold blue]")

    async def show_tool_call(self, tool_name, params):
        self.console.print(f"[dim]🔧 调用工具: {tool_name}[/dim]")
```

### Print Mode 实现

```python
# ui/print.py

class PrintUI:
    """非交互式 Print UI"""

    def __init__(self, output_format: str = "text"):
        self.output_format = output_format

    async def display_message(self, role: str, content: str):
        if self.output_format == "text":
            print(f"{role}: {content}")
        elif self.output_format == "json":
            print(json.dumps({"role": role, "content": content}))

    async def get_user_input(self) -> str:
        # Print 模式不支持交互
        raise NotImplementedError("Print mode doesn't support user input")
```

## 14.3 在 Agent 中使用

```python
class Agent:
    def __init__(self, ui: UI):
        self.ui = ui

    async def run(self, user_input: str | None = None) -> str:
        # 如果没有提供输入，从 UI 获取
        if user_input is None:
            user_input = await self.ui.get_user_input()

        # 显示用户消息
        await self.ui.display_message("user", user_input)

        # 执行推理...
        response = await self.llm.generate(...)

        # 显示工具调用
        if response.tool_calls:
            for tc in response.tool_calls:
                await self.ui.show_tool_call(tc.name, tc.params)

        # 显示最终回复
        await self.ui.display_message("assistant", response.content)

        return response.content
```

## 14.4 小结

多种 UI 模式让 Agent 适应不同场景：

- ✅ **Shell**: 开发调试
- ✅ **Print**: 自动化脚本
- ✅ **ACP**: IDE 集成
- ✅ **Wire**: 自定义集成

---

**上一章**：[第 13 章：上下文压缩](./13-context-compaction.md) ←
**下一章**：[第 15 章：配置系统](./15-config-system.md) →
