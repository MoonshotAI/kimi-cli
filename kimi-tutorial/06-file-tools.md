# 第 6 章：文件操作工具

想象一下，如果 Agent 只能"说话"但不能"动手"，那会是怎样的体验？

```
你: 帮我修复 src/utils.py 里的 bug
Agent: 我觉得问题可能在第 42 行，你应该把 x + 1 改成 x - 1
你: ...那你帮我改啊！
Agent: 抱歉，我不会操作文件 🤷
```

在本章，我们将让 Agent 真正"动起手来"——实现一套完整的文件操作工具。

## 6.1 从最简单的开始：ReadFile

### 第一个版本：能用就行

让我们先实现一个最简单的文件读取工具：

```python
# tools/read_file_v1.py

from pydantic import BaseModel

class ReadFileParams(BaseModel):
    path: str

async def read_file(params: ReadFileParams) -> str:
    """读取文件"""
    with open(params.path) as f:
        return f.read()
```

简单吧？只有 4 行代码！

### 但是...等等！

让我们试试用这个工具：

```python
# 测试 1：读取一个小文件
result = await read_file(ReadFileParams(path="config.py"))
# ✅ 成功！

# 测试 2：读取一个大文件（10,000 行）
result = await read_file(ReadFileParams(path="large_file.py"))
# ❌ 返回了 10,000 行，LLM 看不完，还很贵！

# 测试 3：读取不存在的文件
result = await read_file(ReadFileParams(path="not_exist.py"))
# ❌ 崩溃: FileNotFoundError!
```

所以我们需要改进。

### 第二个版本：添加限制和错误处理

```python
# tools/read_file_v2.py

from pydantic import BaseModel, Field
from pathlib import Path

class ReadFileParams(BaseModel):
    path: str = Field(description="文件路径")
    offset: int = Field(0, description="起始行号（从 0 开始）")
    limit: int | None = Field(100, description="读取的行数，默认 100")

class ToolError(Exception):
    """工具执行错误"""
    pass

async def read_file(params: ReadFileParams) -> str:
    """读取文件

    Returns:
        文件内容（带行号）

    Raises:
        ToolError: 文件不存在或读取失败
    """
    file_path = Path(params.path)

    # 1. 检查文件是否存在
    if not file_path.exists():
        raise ToolError(f"文件不存在: {params.path}")

    # 2. 检查是否是文件（不是目录）
    if not file_path.is_file():
        raise ToolError(f"{params.path} 不是文件")

    try:
        # 3. 读取文件
        with open(file_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()

        # 4. 应用分页
        start = params.offset
        end = start + params.limit if params.limit else len(lines)
        selected_lines = lines[start:end]

        # 5. 添加行号（便于引用）
        numbered_lines = [
            f"{start + i + 1:4d} | {line.rstrip()}"
            for i, line in enumerate(selected_lines)
        ]

        # 6. 构建响应
        total_lines = len(lines)
        showing = len(selected_lines)

        result = f"文件: {params.path}\n"
        result += f"总共 {total_lines} 行，显示 {showing} 行 (第 {start + 1}-{start + showing} 行)\n"
        result += "\n" + "\n".join(numbered_lines)

        return result

    except UnicodeDecodeError:
        raise ToolError(f"无法解码文件: {params.path}（可能是二进制文件）")
    except Exception as e:
        raise ToolError(f"读取文件失败: {e}")
```

现在我们的工具：

- ✅ 检查文件是否存在
- ✅ 支持分页（避免返回太多内容）
- ✅ 添加行号（便于 LLM 引用）
- ✅ 错误处理完善
- ✅ 显示进度信息

### 使用示例

```python
# 读取文件的前 20 行
result = await read_file(ReadFileParams(
    path="src/utils.py",
    offset=0,
    limit=20
))

print(result)
```

输出：

```
文件: src/utils.py
总共 156 行，显示 20 行 (第 1-20 行)

   1 | import os
   2 | from pathlib import Path
   3 |
   4 | def get_config_dir():
   5 |     """获取配置目录"""
   6 |     return Path.home() / ".my-agent"
  ...
```

### Agent 如何使用？

```
用户: 读取 src/utils.py 文件

Agent 想法: 我先读取前 100 行看看
Agent 调用: read_file(path="src/utils.py", offset=0, limit=100)
Agent 看到: 文件有 156 行，前 100 行显示了...

用户: 后面还有什么？

Agent 想法: 用户想看剩余的部分
Agent 调用: read_file(path="src/utils.py", offset=100, limit=56)
Agent 看到: 后面 56 行的内容...
```

## 6.2 WriteFile：让 Agent 能写代码

读文件只是第一步，我们还需要让 Agent 能够**创建和修改**文件。

### 设计考虑

写文件比读文件危险得多：

```python
# 危险操作 1：覆盖重要文件
write_file("~/.bashrc", "# 我删了所有配置")

# 危险操作 2：写入恶意代码
write_file("hack.py", "import os; os.system('rm -rf /')")

# 危险操作 3：写到系统目录
write_file("/etc/passwd", "root::0:0:root:/root:/bin/bash")
```

所以我们需要：

1. **安全检查**：不能写系统文件
2. **备份机制**：覆盖前先备份
3. **用户确认**：危险操作需要批准

### 实现 WriteFile

```python
# tools/write_file.py

from pydantic import BaseModel, Field
from pathlib import Path
import shutil
from datetime import datetime

class WriteFileParams(BaseModel):
    path: str = Field(description="文件路径")
    content: str = Field(description="文件内容")
    create_dirs: bool = Field(True, description="是否自动创建父目录")
    backup: bool = Field(True, description="是否备份现有文件")

class WriteFileTool:
    """写文件工具"""

    name = "write_file"
    description = "创建或覆盖文件。注意：会覆盖现有文件！"

    def __init__(self, work_dir: Path):
        """
        Args:
            work_dir: 工作目录（只能在此目录下写文件）
        """
        self.work_dir = work_dir

    def _is_safe_path(self, path: Path) -> bool:
        """检查路径是否安全"""
        # 1. 必须在工作目录下
        try:
            path.resolve().relative_to(self.work_dir.resolve())
        except ValueError:
            return False

        # 2. 不能是系统关键文件
        dangerous_names = {
            ".bashrc", ".zshrc", ".profile",
            "passwd", "shadow", "sudoers"
        }
        if path.name in dangerous_names:
            return False

        return True

    async def execute(self, params: WriteFileParams) -> str:
        """执行写文件"""
        # 解析路径（相对于工作目录）
        file_path = self.work_dir / params.path

        # 安全检查
        if not self._is_safe_path(file_path):
            return f"❌ 拒绝写入：{params.path} 在工作目录外或是危险文件"

        # 创建父目录
        if params.create_dirs:
            file_path.parent.mkdir(parents=True, exist_ok=True)

        # 备份现有文件
        if file_path.exists() and params.backup:
            backup_path = self._create_backup(file_path)
            backup_msg = f"（已备份到 {backup_path.name}）"
        else:
            backup_msg = ""

        # 写入文件
        try:
            with open(file_path, 'w', encoding='utf-8') as f:
                f.write(params.content)

            lines = params.content.count('\n') + 1
            size = len(params.content)

            return f"✅ 已写入 {params.path}\n" \
                   f"   {lines} 行，{size} 字节 {backup_msg}"

        except Exception as e:
            return f"❌ 写入失败: {e}"

    def _create_backup(self, file_path: Path) -> Path:
        """创建备份文件"""
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_path = file_path.with_suffix(f".{timestamp}.backup")
        shutil.copy2(file_path, backup_path)
        return backup_path
```

### 使用示例

```python
tool = WriteFileTool(work_dir=Path("/home/user/project"))

# 创建新文件
result = await tool.execute(WriteFileParams(
    path="src/new_file.py",
    content="print('Hello, World!')\n"
))
# ✅ 已写入 src/new_file.py
#    1 行，22 字节

# 覆盖现有文件（会自动备份）
result = await tool.execute(WriteFileParams(
    path="src/config.py",
    content="CONFIG = {'debug': True}\n"
))
# ✅ 已写入 src/config.py
#    1 行，27 字节 （已备份到 config.20250115_143000.backup）
```

## 6.3 EditFile：精准修改

有时我们不想覆盖整个文件，只想修改其中一部分。

### 设计：字符串替换

最简单的编辑方式是**字符串替换**：

```python
# 替换前
old_str = "def calculate(x):\n    return x + 1"

# 替换后
new_str = "def calculate(x):\n    return x - 1"
```

### 实现 EditFile

```python
# tools/edit_file.py

from pydantic import BaseModel, Field
from pathlib import Path

class EditFileParams(BaseModel):
    path: str = Field(description="文件路径")
    old_string: str = Field(description="要替换的字符串")
    new_string: str = Field(description="替换成的字符串")

class EditFileTool:
    """编辑文件工具（字符串替换）"""

    name = "edit_file"
    description = """在文件中进行精确的字符串替换。

    重要：old_string 必须在文件中完全匹配（包括缩进、换行）。
    """

    def __init__(self, work_dir: Path):
        self.work_dir = work_dir

    async def execute(self, params: EditFileParams) -> str:
        file_path = self.work_dir / params.path

        # 读取文件
        if not file_path.exists():
            return f"❌ 文件不存在: {params.path}"

        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()

        # 检查 old_string 是否存在
        if params.old_string not in content:
            return f"❌ 未找到要替换的字符串\n\n" \
                   f"请确保包含正确的缩进和换行。\n\n" \
                   f"要查找的字符串:\n{params.old_string}"

        # 检查是否唯一
        count = content.count(params.old_string)
        if count > 1:
            return f"❌ 找到 {count} 处匹配\n\n" \
                   f"请提供更具体的字符串以唯一定位。"

        # 执行替换
        new_content = content.replace(params.old_string, params.new_string)

        # 创建备份
        backup_path = file_path.with_suffix('.backup')
        shutil.copy2(file_path, backup_path)

        # 写入新内容
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(new_content)

        return f"✅ 已修改 {params.path}\n" \
               f"   替换了 1 处\n" \
               f"   备份: {backup_path.name}"
```

### 为什么要求"精确匹配"？

这是为了避免错误替换：

```python
# 文件内容
"""
def add(x, y):
    return x + y

def multiply(x, y):
    return x * y
"""

# ❌ 错误：old_string = "x"（太宽泛）
# 会替换所有的 x！

# ✅ 正确：old_string = "def add(x, y):\n    return x + y"
# 只替换 add 函数
```

### Agent 如何使用？

```
用户: 把 add 函数改成减法

Agent 步骤:
1. 先调用 read_file 读取文件，看到：
   def add(x, y):
       return x + y

2. 确定要替换的内容

3. 调用 edit_file:
   old_string = "def add(x, y):\n    return x + y"
   new_string = "def add(x, y):\n    return x - y"

4. 完成！
```

## 6.4 Glob：查找文件

Agent 经常需要"找文件"：

```
用户: 所有的测试文件在哪里？
Agent: 我需要找到匹配 *_test.py 的文件
```

### 什么是 Glob？

Glob 是一种文件名匹配模式：

- `*.py` - 所有 Python 文件
- `test_*.py` - 以 test_ 开头的 Python 文件
- `src/**/*.py` - src 目录下所有 Python 文件（递归）
- `[abc].txt` - a.txt, b.txt, c.txt

### 实现 Glob

```python
# tools/glob.py

from pydantic import BaseModel, Field
from pathlib import Path

class GlobParams(BaseModel):
    pattern: str = Field(description="匹配模式，如 '*.py' 或 'src/**/*.ts'")
    max_results: int = Field(100, description="最多返回的文件数")

class GlobTool:
    """文件查找工具"""

    name = "glob"
    description = """使用 glob 模式查找文件。

    示例:
    - "*.py" - 当前目录的所有 Python 文件
    - "**/*.py" - 所有子目录的 Python 文件（递归）
    - "test_*.py" - 以 test_ 开头的 Python 文件
    - "src/**/*.{js,ts}" - src 下所有 JS 和 TS 文件
    """

    def __init__(self, work_dir: Path):
        self.work_dir = work_dir

    async def execute(self, params: GlobParams) -> str:
        """执行 glob 搜索"""
        try:
            # pathlib 的 glob 方法
            if "**" in params.pattern:
                # 递归搜索
                matches = list(self.work_dir.glob(params.pattern))
            else:
                # 非递归
                matches = list(self.work_dir.glob(params.pattern))

            # 限制结果数量
            matches = matches[:params.max_results]

            if not matches:
                return f"未找到匹配的文件: {params.pattern}"

            # 转换为相对路径
            rel_paths = [
                str(m.relative_to(self.work_dir))
                for m in matches
                if m.is_file()  # 只返回文件，不返回目录
            ]

            # 按路径排序
            rel_paths.sort()

            result = f"找到 {len(rel_paths)} 个文件匹配 '{params.pattern}':\n\n"
            result += "\n".join(f"  {i+1}. {p}" for i, p in enumerate(rel_paths))

            if len(matches) == params.max_results:
                result += f"\n\n(已限制为前 {params.max_results} 个结果)"

            return result

        except Exception as e:
            return f"❌ Glob 失败: {e}"
```

### 使用示例

```python
tool = GlobTool(work_dir=Path("/home/user/project"))

# 查找所有测试文件
result = await tool.execute(GlobParams(pattern="**/*_test.py"))
```

输出：

```
找到 15 个文件匹配 '**/*_test.py':

  1. tests/test_utils.py
  2. tests/test_config.py
  3. tests/agent/test_soul.py
  4. tests/tools/test_file.py
  ...
```

## 6.5 Grep：搜索内容

Glob 找文件名，Grep 找**文件内容**。

### 实现 Grep

```python
# tools/grep.py

import re
from pydantic import BaseModel, Field
from pathlib import Path

class GrepParams(BaseModel):
    pattern: str = Field(description="搜索模式（正则表达式）")
    path: str = Field(".", description="搜索路径（文件或目录）")
    case_sensitive: bool = Field(True, description="是否区分大小写")
    file_pattern: str | None = Field(None, description="文件名过滤，如 '*.py'")
    max_results: int = Field(50, description="最多返回的匹配数")

class GrepTool:
    """内容搜索工具"""

    name = "grep"
    description = """在文件中搜索文本（支持正则表达式）。

    示例:
    - pattern="TODO" - 搜索 TODO 注释
    - pattern="def.*test" - 搜索测试函数
    - pattern="class \\w+Error" - 搜索错误类定义
    """

    def __init__(self, work_dir: Path):
        self.work_dir = work_dir

    async def execute(self, params: GrepParams) -> str:
        search_path = self.work_dir / params.path

        # 编译正则表达式
        flags = 0 if params.case_sensitive else re.IGNORECASE
        try:
            regex = re.compile(params.pattern, flags)
        except re.error as e:
            return f"❌ 无效的正则表达式: {e}"

        matches = []

        # 确定要搜索的文件
        if search_path.is_file():
            files = [search_path]
        else:
            # 搜索目录
            if params.file_pattern:
                files = search_path.rglob(params.file_pattern)
            else:
                files = search_path.rglob("*")

        # 搜索每个文件
        for file_path in files:
            if not file_path.is_file():
                continue

            # 跳过二进制文件
            if self._is_binary(file_path):
                continue

            matches.extend(self._search_file(file_path, regex, params.max_results))

            if len(matches) >= params.max_results:
                break

        # 格式化结果
        if not matches:
            return f"未找到匹配 '{params.pattern}' 的内容"

        result = f"找到 {len(matches)} 处匹配:\n\n"
        for match in matches[:params.max_results]:
            result += f"{match}\n"

        if len(matches) > params.max_results:
            result += f"\n(还有 {len(matches) - params.max_results} 处匹配未显示)"

        return result

    def _search_file(self, file_path: Path, regex: re.Pattern, max_results: int) -> list[str]:
        """在单个文件中搜索"""
        matches = []

        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                for line_num, line in enumerate(f, 1):
                    if regex.search(line):
                        rel_path = file_path.relative_to(self.work_dir)
                        match_str = f"{rel_path}:{line_num}: {line.rstrip()}"
                        matches.append(match_str)

                        if len(matches) >= max_results:
                            break

        except UnicodeDecodeError:
            pass  # 跳过无法解码的文件

        return matches

    def _is_binary(self, file_path: Path) -> bool:
        """检查是否是二进制文件"""
        try:
            with open(file_path, 'rb') as f:
                chunk = f.read(1024)
                return b'\x00' in chunk  # 包含空字节的可能是二进制
        except:
            return True
```

### 使用示例

```python
# 搜索所有 TODO 注释
result = await grep_tool.execute(GrepParams(
    pattern="TODO",
    file_pattern="*.py"
))
```

输出：

```
找到 8 处匹配:

src/agent.py:45: # TODO: 添加重试机制
src/tools/file.py:123: # TODO: 支持二进制文件
tests/test_agent.py:67: # TODO: 测试边界情况
...
```

## 6.6 综合示例：Agent 自己修 Bug

让我们看看 Agent 如何组合使用这些工具：

```
用户: src/utils.py 里有个 TODO，帮我实现它

Agent 的思考过程:

1. 先用 grep 找到 TODO
   grep(pattern="TODO", path="src/utils.py")

   结果: src/utils.py:42: # TODO: 实现配置缓存

2. 用 read_file 读取那部分代码
   read_file(path="src/utils.py", offset=35, limit=20)

   看到:
   42 | # TODO: 实现配置缓存
   43 | def get_config():
   44 |     return load_config_from_disk()

3. 分析：这里应该加缓存

4. 用 edit_file 修改代码
   edit_file(
       path="src/utils.py",
       old_string="# TODO: 实现配置缓存\ndef get_config():\n    return load_config_from_disk()",
       new_string="_config_cache = None\n\ndef get_config():\n    global _config_cache\n    if _config_cache is None:\n        _config_cache = load_config_from_disk()\n    return _config_cache"
   )

5. 完成！向用户汇报
```

## 6.7 小结

在这一章，我们实现了四个核心的文件操作工具：

- ✅ **ReadFile**：读取文件（支持分页、行号）
- ✅ **WriteFile**：创建/覆盖文件（安全检查、自动备份）
- ✅ **EditFile**：精确修改文件（字符串替换）
- ✅ **Glob**：查找文件（模式匹配）
- ✅ **Grep**：搜索内容（正则表达式）

这些工具让 Agent 能够：

- 📖 阅读代码
- ✍️ 编写代码
- 🔍 查找文件和内容
- 🛠️ 修改代码

在下一章，我们将学习最强大（也最危险）的工具：**Shell 执行**！

---

**上一章**：[第 5 章：上下文管理](./05-context-management.md) ←
**下一章**：[第 7 章：Shell 执行](./07-shell-execution.md) →
