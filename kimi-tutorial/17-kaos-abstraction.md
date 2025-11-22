# 第 17 章：KAOS 抽象层

KAOS = **K**imi **A**gent **O**perating **S**ystem

为什么需要文件系统抽象？因为 Agent 不应该只能在本地运行！

- 💻 本地：直接操作文件系统
- ☁️ 云端：操作远程文件系统
- 🐳 容器：操作容器内文件系统

KAOS 提供统一接口。

## 17.1 KAOS 协议

```python
# kaos/__init__.py

from typing import Protocol
from pathlib import Path

class Kaos(Protocol):
    """Kimi Agent Operating System 协议"""

    def chdir(self, path: str) -> None:
        """切换工作目录"""
        ...

    def readtext(self, path: str) -> str:
        """读取文本文件"""
        ...

    def writetext(self, path: str, content: str) -> None:
        """写入文本文件"""
        ...

    def glob(self, pattern: str) -> list[Path]:
        """文件模式匹配"""
        ...

    def exists(self, path: str) -> bool:
        """检查路径是否存在"""
        ...
```

## 17.2 本地实现

```python
# kaos/local.py

from pathlib import Path

class LocalKaos:
    """本地文件系统实现"""

    def __init__(self, work_dir: Path):
        self.work_dir = work_dir.resolve()

    def chdir(self, path: str):
        new_dir = self.work_dir / path
        if new_dir.is_dir():
            self.work_dir = new_dir.resolve()

    def readtext(self, path: str) -> str:
        file_path = self.work_dir / path
        return file_path.read_text()

    def writetext(self, path: str, content: str):
        file_path = self.work_dir / path
        file_path.write_text(content)

    def glob(self, pattern: str) -> list[Path]:
        return list(self.work_dir.glob(pattern))

    def exists(self, path: str) -> bool:
        return (self.work_dir / path).exists()
```

## 17.3 在工具中使用

```python
class ReadFileTool:
    def __init__(self, kaos: Kaos):
        self.kaos = kaos  # 不关心具体实现

    async def execute(self, params):
        # 使用抽象接口
        content = self.kaos.readtext(params.path)
        return content
```

现在工具可以在任何 KAOS 实现上运行！

---

**上一章**：[第 16 章：会话管理](./16-session-management.md) ←
**下一章**：[第 18 章：测试策略](./18-testing.md) →
