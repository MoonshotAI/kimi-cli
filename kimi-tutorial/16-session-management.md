# 第 16 章：会话管理

每次对话都是一个"会话"（Session）。好的会话管理让用户能够：

- 📝 继续上次的对话
- 🔍 查看历史会话
- 🗑️ 清理旧会话

## 16.1 会话 ID

每个会话有唯一 ID：

```python
import uuid

def create_session_id() -> str:
    """创建会话 ID"""
    return str(uuid.uuid4())[:8]  # 例如: "a3b4c5d6"
```

## 16.2 会话元数据

```python
# session.py

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

@dataclass
class Session:
    """会话元数据"""
    id: str
    work_dir: Path
    created_at: datetime
    last_active: datetime
    message_count: int

class SessionManager:
    """会话管理器"""

    def __init__(self, sessions_dir: Path):
        self.sessions_dir = sessions_dir
        self.sessions_dir.mkdir(parents=True, exist_ok=True)

    def create_session(self, work_dir: Path) -> Session:
        """创建新会话"""
        session = Session(
            id=create_session_id(),
            work_dir=work_dir,
            created_at=datetime.now(),
            last_active=datetime.now(),
            message_count=0
        )

        self._save_metadata(session)
        return session

    def get_session(self, session_id: str) -> Session | None:
        """获取会话"""
        metadata_file = self.sessions_dir / f"{session_id}.json"
        if not metadata_file.exists():
            return None

        with open(metadata_file) as f:
            data = json.load(f)
            return Session(**data)

    def list_sessions(self) -> list[Session]:
        """列出所有会话"""
        sessions = []
        for meta_file in self.sessions_dir.glob("*.json"):
            with open(meta_file) as f:
                sessions.append(Session(**json.load(f)))

        # 按最后活跃时间排序
        sessions.sort(key=lambda s: s.last_active, reverse=True)
        return sessions
```

## 16.3 继续会话

```python
# 启动时检查是否有会话可继续
session_manager = SessionManager(Path("~/.kimi/sessions"))

# 方式 1：指定会话 ID
if args.continue_session:
    session = session_manager.get_session(args.session_id)
    agent = Agent.from_session(session)

# 方式 2：自动继续最近的会话
else:
    sessions = session_manager.list_sessions()
    if sessions:
        latest = sessions[0]
        print(f"继续会话 {latest.id}...")
        agent = Agent.from_session(latest)
    else:
        # 创建新会话
        session = session_manager.create_session(Path.cwd())
        agent = Agent(session=session)
```

---

**上一章**：[第 15 章：配置系统](./15-config-system.md) ←
**下一章**：[第 17 章：KAOS 抽象](./17-kaos-abstraction.md) →
