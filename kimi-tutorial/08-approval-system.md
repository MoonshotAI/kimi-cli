# 第 8 章：审批系统

想象这个场景：

```
Agent: 我发现了 bug，准备删除 database.db 并重新创建...
你: 等等！那是生产数据库！
Agent: 哦，已经删了 🙃
```

这就是为什么我们需要**审批系统**。

在关键操作执行前，Agent 应该先问问你："我可以这样做吗？"

## 8.1 哪些操作需要审批？

### 危险级别分类

| 级别 | 操作示例 | 是否需要审批 |
|------|---------|-------------|
| 🟢 安全 | 读文件、搜索 | ❌ 不需要 |
| 🟡 中等 | 写新文件、运行测试 | ⭐ 可选 |
| 🔴 危险 | 删除文件、执行 shell、修改配置 | ✅ 必须 |

### 如何判断？

```python
def need_approval(tool_name: str, params: dict) -> bool:
    """判断操作是否需要审批"""

    # 规则 1：所有 shell 命令都需要审批
    if tool_name == "shell":
        return True

    # 规则 2：写文件时，覆盖现有文件需要审批
    if tool_name == "write_file":
        if Path(params["path"]).exists():
            return True  # 覆盖现有文件

    # 规则 3：删除操作必须审批
    if "delete" in tool_name or "remove" in tool_name:
        return True

    # 默认：不需要
    return False
```

## 8.2 设计审批接口

我们需要一个抽象的审批接口，支持不同的 UI 模式：

```python
# approval.py

from typing import Protocol

class Approval(Protocol):
    """审批接口"""

    async def request(
        self,
        tool_name: str,
        action: str,
        details: str
    ) -> bool:
        """请求用户审批

        Args:
            tool_name: 工具名称
            action: 操作描述（一句话）
            details: 详细信息

        Returns:
            True 如果用户批准，False 如果拒绝
        """
        ...
```

### 为什么用 Protocol？

这样我们可以有多种实现：

```python
# 命令行模式：询问用户
class CLIApproval:
    async def request(self, tool_name, action, details):
        print(f"\n🔔 {tool_name} 想要执行操作:")
        print(f"   {action}")
        print(f"\n详情:\n{details}\n")

        response = input("批准? (y/n): ")
        return response.lower() == 'y'

# 自动批准模式（YOLO 模式）
class AutoApproval:
    async def request(self, tool_name, action, details):
        return True  # 总是批准

# IDE 模式：显示对话框
class IDEApproval:
    async def request(self, tool_name, action, details):
        # 显示 VS Code 对话框
        return await show_dialog(action, details)
```

## 8.3 实现 CLI 审批

让我们实现一个完整的命令行审批系统：

```python
# approval.py

from rich.console import Console
from rich.panel import Panel
from rich.prompt import Confirm
from rich.syntax import Syntax

console = Console()

class CLIApproval:
    """命令行审批系统"""

    def __init__(self, auto_approve: bool = False):
        """
        Args:
            auto_approve: 是否自动批准所有操作
        """
        self.auto_approve = auto_approve
        self.approval_count = 0
        self.approved_count = 0

    async def request(
        self,
        tool_name: str,
        action: str,
        details: str
    ) -> bool:
        """请求审批"""

        self.approval_count += 1

        # 如果是自动模式，直接批准
        if self.auto_approve:
            console.print(f"[dim]🤖 自动批准: {action}[/dim]")
            self.approved_count += 1
            return True

        # 显示审批请求
        console.print()
        console.print(Panel(
            f"[bold yellow]🔔 审批请求 #{self.approval_count}[/bold yellow]\n\n"
            f"[cyan]工具:[/cyan] {tool_name}\n"
            f"[cyan]操作:[/cyan] {action}\n\n"
            f"[bold]详情:[/bold]\n{self._format_details(details)}",
            title="需要您的确认",
            border_style="yellow"
        ))

        # 询问用户
        approved = Confirm.ask(
            "批准这个操作吗?",
            default=False
        )

        if approved:
            self.approved_count += 1
            console.print("[green]✅ 已批准[/green]")
        else:
            console.print("[red]❌ 已拒绝[/red]")

        console.print()
        return approved

    def _format_details(self, details: str) -> str:
        """格式化详情（语法高亮）"""

        # 如果看起来像代码，添加语法高亮
        if details.startswith("```"):
            # 提取语言和代码
            lines = details.split("\n")
            lang = lines[0].replace("```", "").strip() or "python"
            code = "\n".join(lines[1:-1])

            return Syntax(code, lang, theme="monokai", line_numbers=True)

        return details

    def get_stats(self) -> dict:
        """获取统计信息"""
        return {
            "total_requests": self.approval_count,
            "approved": self.approved_count,
            "rejected": self.approval_count - self.approved_count,
        }
```

## 8.4 在工具中使用审批

现在让我们修改工具以支持审批：

### 修改 WriteFile 工具

```python
# tools/write_file.py

class WriteFileTool:
    def __init__(self, work_dir: Path, approval: Approval):
        self.work_dir = work_dir
        self.approval = approval  # 注入审批系统

    async def execute(self, params: WriteFileParams) -> str:
        file_path = self.work_dir / params.path

        # 如果文件已存在，请求审批
        if file_path.exists():
            # 读取现有内容（用于显示）
            with open(file_path) as f:
                old_content = f.read()

            # 构建审批详情
            details = f"文件: {params.path}\n\n"
            details += "将要覆盖的内容:\n"
            details += "```python\n"
            details += old_content[:500]  # 只显示前 500 字符
            if len(old_content) > 500:
                details += "\n... (还有更多)"
            details += "\n```\n\n"
            details += "新内容:\n"
            details += "```python\n"
            details += params.content[:500]
            if len(params.content) > 500:
                details += "\n... (还有更多)"
            details += "\n```"

            # 请求审批
            approved = await self.approval.request(
                tool_name="write_file",
                action=f"覆盖文件 {params.path}",
                details=details
            )

            if not approved:
                return "❌ 操作被用户拒绝"

        # 执行写入...
        with open(file_path, 'w') as f:
            f.write(params.content)

        return f"✅ 已写入 {params.path}"
```

### 修改 Shell 工具

```python
# tools/shell.py

class ShellTool:
    def __init__(self, work_dir: Path, approval: Approval):
        self.work_dir = work_dir
        self.approval = approval

    async def execute(self, params: ShellParams) -> str:
        # 构建详情
        details = f"命令: [bold]{params.command}[/bold]\n"
        details += f"工作目录: {self.work_dir}\n"
        details += f"超时: {params.timeout} 秒"

        # 请求审批
        approved = await self.approval.request(
            tool_name="shell",
            action=f"执行 shell 命令",
            details=details
        )

        if not approved:
            return "❌ 操作被用户拒绝"

        # 执行命令...
        result = subprocess.run(...)
        return result
```

## 8.5 审批的用户体验

让我们看看实际使用时的体验：

```
Agent: 我需要修改 config.py 文件

[执行 write_file...]

┌──────────────────── 需要您的确认 ────────────────────┐
│ 🔔 审批请求 #1                                       │
│                                                      │
│ 工具: write_file                                     │
│ 操作: 覆盖文件 config.py                             │
│                                                      │
│ 详情:                                                │
│ 文件: config.py                                      │
│                                                      │
│ 将要覆盖的内容:                                       │
│    1 │ DEBUG = False                                │
│    2 │ API_KEY = "old-key"                          │
│                                                      │
│ 新内容:                                              │
│    1 │ DEBUG = True                                 │
│    2 │ API_KEY = "new-key"                          │
└──────────────────────────────────────────────────────┘

批准这个操作吗? (y/n): y

✅ 已批准
```

## 8.6 智能审批：记住用户的选择

有时用户会说："同类操作都批准"。我们可以实现这个功能：

```python
class SmartApproval:
    """智能审批系统"""

    def __init__(self):
        self.auto_approve = False
        self.approval_rules = {}  # {tool_name: "always_approve" | "always_reject"}

    async def request(self, tool_name, action, details) -> bool:
        # 检查是否有规则
        if tool_name in self.approval_rules:
            rule = self.approval_rules[tool_name]
            if rule == "always_approve":
                console.print(f"[dim]根据规则自动批准: {tool_name}[/dim]")
                return True
            elif rule == "always_reject":
                console.print(f"[dim]根据规则自动拒绝: {tool_name}[/dim]")
                return False

        # 显示审批请求
        console.print(...)

        # 询问用户（增强选项）
        console.print("\n选择:")
        console.print("  [cyan]y[/cyan] - 批准这一次")
        console.print("  [cyan]n[/cyan] - 拒绝这一次")
        console.print("  [cyan]always[/cyan] - 总是批准此类操作")
        console.print("  [cyan]never[/cyan] - 总是拒绝此类操作")

        choice = input("\n你的选择: ").lower()

        if choice == 'y':
            return True
        elif choice == 'n':
            return False
        elif choice == 'always':
            self.approval_rules[tool_name] = "always_approve"
            console.print(f"[green]✅ 已设置规则: 总是批准 {tool_name}[/green]")
            return True
        elif choice == 'never':
            self.approval_rules[tool_name] = "always_reject"
            console.print(f"[red]❌ 已设置规则: 总是拒绝 {tool_name}[/red]")
            return False
        else:
            console.print("[yellow]无效输入，默认拒绝[/yellow]")
            return False
```

## 8.7 批量审批

当 Agent 想执行多个操作时，逐个审批会很烦。我们可以支持**批量审批**：

```python
class BatchApproval:
    """批量审批系统"""

    def __init__(self):
        self.pending_approvals = []
        self.batch_mode = False

    def start_batch(self):
        """开始批量审批模式"""
        self.batch_mode = True
        self.pending_approvals = []

    async def request(self, tool_name, action, details) -> bool:
        if self.batch_mode:
            # 批量模式：先收集，不询问
            self.pending_approvals.append({
                "tool": tool_name,
                "action": action,
                "details": details
            })
            return True  # 暂时返回 True
        else:
            # 正常模式
            return await self._ask_user(tool_name, action, details)

    async def review_batch(self) -> bool:
        """审查整批操作"""

        if not self.pending_approvals:
            return True

        console.print("\n[bold]📋 批量审批: 以下操作等待审批[/bold]\n")

        for i, approval in enumerate(self.pending_approvals, 1):
            console.print(f"{i}. [{approval['tool']}] {approval['action']}")

        console.print(f"\n总共 {len(self.pending_approvals)} 个操作")

        approved = Confirm.ask("\n批准所有操作?")

        if approved:
            console.print("[green]✅ 已批准所有操作[/green]")
        else:
            console.print("[red]❌ 已拒绝所有操作[/red]")

        return approved
```

使用：

```python
# Agent 开始执行一系列操作
approval.start_batch()

await write_file_tool.execute(...)  # 不会立即询问
await shell_tool.execute(...)       # 不会立即询问
await write_file_tool.execute(...)  # 不会立即询问

# 最后一次性审批
if await approval.review_batch():
    # 用户批准了，执行实际操作
    ...
else:
    # 用户拒绝了，取消所有操作
    ...
```

## 8.8 审批日志

记录所有审批决策，用于审计：

```python
class ApprovalLogger:
    """审批日志"""

    def __init__(self, log_file: Path):
        self.log_file = log_file

    def log_approval(
        self,
        tool_name: str,
        action: str,
        approved: bool,
        timestamp: datetime
    ):
        """记录审批决策"""

        log_entry = {
            "timestamp": timestamp.isoformat(),
            "tool": tool_name,
            "action": action,
            "approved": approved
        }

        with open(self.log_file, 'a') as f:
            f.write(json.dumps(log_entry) + '\n')

    def get_recent_approvals(self, limit: int = 10) -> list:
        """获取最近的审批记录"""

        with open(self.log_file) as f:
            lines = f.readlines()

        return [json.loads(line) for line in lines[-limit:]]
```

## 8.9 小结

审批系统是 Agent 安全运行的关键保障。在这一章，我们学习了：

- ✅ **危险级别分类**：哪些操作需要审批
- ✅ **审批接口设计**：Protocol 模式支持多种实现
- ✅ **CLI 审批**：友好的命令行交互
- ✅ **工具集成**：如何在工具中使用审批
- ✅ **智能审批**：记住用户选择，批量审批
- ✅ **审批日志**：审计和追溯

记住：**审批系统让用户保持控制权**。Agent 再聪明，最终决策权应该在人类手中。

在下一章，我们将学习如何通过 YAML 配置来定义 Agent 的行为——**Agent 规范**！

---

**上一章**：[第 7 章：Shell 执行](./07-shell-execution.md) ←
**下一章**：[第 9 章：Agent 规范](./09-agent-spec.md) →
