# 第 5 章：上下文管理

还记得我们在第 3 章构建的最简 Agent 吗？它能记住对话内容，这正是**上下文**的功劳。

但如果我告诉你，上下文管理其实是构建 Agent 最微妙、最容易出错的部分之一，你信吗？

在这一章，我们将深入探讨上下文管理的艺术。

## 5.1 为什么上下文如此重要？

### 一个失忆的 Agent

想象你正在使用一个没有上下文的 Agent：

```
你: 读取 config.py 文件
Agent: [读取文件，显示内容]

你: 第 10 行有问题，帮我修改
Agent: ❌ 我不知道你在说哪个文件

你: 就是刚才那个文件啊！
Agent: ❌ 抱歉，我没有"刚才"的记忆
```

frustrating，对吧？这就是没有上下文的 Agent。

### 有上下文的 Agent

```
你: 读取 config.py 文件
Agent: [读取文件，记住了这个操作]

你: 第 10 行有问题，帮我修改
Agent: ✅ [知道你指的是 config.py 的第 10 行]

你: 再读一次
Agent: ✅ [知道"再读"指的是 config.py]
```

上下文让 Agent 拥有了**短期记忆**。

## 5.2 上下文的解剖

在 LLM 的世界里，上下文就是**消息列表**：

```python
context = [
    {
        "role": "system",
        "content": "You are a helpful assistant."
    },
    {
        "role": "user",
        "content": "读取 config.py"
    },
    {
        "role": "assistant",
        "content": "",
        "tool_calls": [{"name": "read_file", ...}]
    },
    {
        "role": "tool",
        "tool_call_id": "call_123",
        "content": "# config.py 的内容..."
    },
    {
        "role": "assistant",
        "content": "这个文件定义了..."
    }
]
```

### 四种角色

| 角色 | 用途 | 谁创建 |
|------|------|--------|
| `system` | 定义 Agent 的行为 | 我们（开发者） |
| `user` | 用户的输入 | 用户 |
| `assistant` | Agent 的回复和工具调用 | LLM |
| `tool` | 工具执行的结果 | 我们（Agent） |

### 为什么需要这些角色？

LLM 通过角色来理解对话的**时间线**：

```
时间 →
[system] 你是助手
[user] 帮我读文件
[assistant] 好的，我调用 read_file
[tool] 文件内容是...
[assistant] 我看到文件内容是...
[user] 修改第 10 行
[assistant] 好的，我调用 edit_file...
```

LLM 能看到整个对话历史，所以它知道"第 10 行"指的是哪个文件。

## 5.3 实现上下文管理器

让我们从零开始实现一个上下文管理器。

### 版本 1：最简单的实现

```python
class SimpleContext:
    """最简单的上下文管理器"""

    def __init__(self):
        self.messages = []

    def add_message(self, role: str, content: str):
        """添加消息"""
        self.messages.append({
            "role": role,
            "content": content
        })

    def get_messages(self):
        """获取所有消息"""
        return self.messages
```

使用：

```python
ctx = SimpleContext()

# 添加系统提示
ctx.add_message("system", "You are a helpful assistant")

# 添加用户消息
ctx.add_message("user", "Hello!")

# 添加 Assistant 回复
ctx.add_message("assistant", "Hi! How can I help?")

# 获取所有消息传给 LLM
messages = ctx.get_messages()
```

### 问题 1：消息太多了

如果对话进行了 100 轮，`messages` 列表会有 200+ 条消息。LLM 的上下文窗口是有限的（比如 128k tokens），消息太多会：

1. 超出窗口限制
2. 增加 API 成本
3. 降低响应速度

### 版本 2：添加限制

```python
class LimitedContext:
    """限制消息数量的上下文"""

    def __init__(self, max_messages: int = 50):
        self.messages = []
        self.max_messages = max_messages

    def add_message(self, role: str, content: str):
        self.messages.append({"role": role, "content": content})

        # 保留最近的 N 条消息
        if len(self.messages) > self.max_messages:
            # 始终保留第一条（system prompt）
            system_msg = self.messages[0]
            recent_msgs = self.messages[-self.max_messages+1:]
            self.messages = [system_msg] + recent_msgs

    def get_messages(self):
        return self.messages
```

现在，如果消息超过 `max_messages`，旧消息会被自动丢弃（但保留 system prompt）。

### 问题 2：会话无法继续

如果 Agent 崩溃或者用户关闭程序，所有上下文都丢失了。下次启动时，Agent 完全不记得之前的对话。

### 版本 3：持久化上下文

```python
import json
from pathlib import Path
from typing import List, Dict

class PersistentContext:
    """持久化的上下文管理器"""

    def __init__(self, history_file: Path):
        """
        Args:
            history_file: 历史文件路径（JSON Lines 格式）
        """
        self.history_file = history_file
        self.messages: List[Dict] = []

        # 如果历史文件存在，加载它
        if history_file.exists():
            self._load()

    def _load(self):
        """从文件加载历史"""
        with open(self.history_file) as f:
            for line in f:
                if line.strip():
                    self.messages.append(json.loads(line))

    def _append_to_file(self, message: Dict):
        """追加消息到文件"""
        with open(self.history_file, 'a') as f:
            f.write(json.dumps(message, ensure_ascii=False) + '\n')

    def add_message(self, role: str, content: str, **kwargs):
        """添加消息"""
        message = {
            "role": role,
            "content": content,
            **kwargs
        }

        self.messages.append(message)
        self._append_to_file(message)

    def get_messages(self):
        return self.messages
```

### 为什么用 JSON Lines？

你可能注意到了，我们用的是 **JSON Lines** 格式（`.jsonl`），而不是普通的 JSON 数组：

```jsonl
{"role": "user", "content": "Hello"}
{"role": "assistant", "content": "Hi!"}
{"role": "user", "content": "How are you?"}
```

而不是：

```json
[
  {"role": "user", "content": "Hello"},
  {"role": "assistant", "content": "Hi!"},
  {"role": "user", "content": "How are you?"}
]
```

**原因**：

1. **追加友好**：可以直接 `append`，不需要重写整个文件
2. **流式处理**：可以逐行读取，不需要一次性加载所有内容
3. **容错性好**：如果文件损坏，只影响部分消息

## 5.4 完整的 Context 实现

现在让我们实现一个生产级的 Context：

```python
# context.py

import json
from pathlib import Path
from typing import List, Dict, Any, Optional
from datetime import datetime


class Context:
    """
    上下文管理器

    负责：
    1. 存储对话历史
    2. 持久化到磁盘
    3. 管理消息数量
    4. 支持检查点（时间旅行）
    """

    def __init__(
        self,
        history_file: Path,
        max_messages: Optional[int] = None,
        auto_persist: bool = True
    ):
        """
        Args:
            history_file: 历史文件路径
            max_messages: 最大消息数（None 表示无限制）
            auto_persist: 是否自动持久化
        """
        self.history_file = history_file
        self.max_messages = max_messages
        self.auto_persist = auto_persist

        self.messages: List[Dict[str, Any]] = []
        self._checkpoints: List[int] = []  # 检查点索引

        # 确保目录存在
        history_file.parent.mkdir(parents=True, exist_ok=True)

        # 加载历史（如果存在）
        if history_file.exists():
            self._load()

    def _load(self):
        """从文件加载历史"""
        with open(self.history_file) as f:
            for line in f:
                line = line.strip()
                if line:
                    msg = json.loads(line)
                    self.messages.append(msg)

    def _persist(self, message: Dict):
        """持久化单条消息"""
        if not self.auto_persist:
            return

        with open(self.history_file, 'a', encoding='utf-8') as f:
            f.write(json.dumps(message, ensure_ascii=False) + '\n')

    def add_message(
        self,
        role: str,
        content: str,
        **kwargs
    ) -> None:
        """添加消息

        Args:
            role: 角色（system/user/assistant/tool）
            content: 内容
            **kwargs: 其他字段（如 tool_calls, tool_call_id）
        """
        message = {
            "role": role,
            "content": content,
            "timestamp": datetime.now().isoformat(),
            **kwargs
        }

        self.messages.append(message)
        self._persist(message)

        # 检查是否超过限制
        if self.max_messages and len(self.messages) > self.max_messages:
            self._trim()

    def _trim(self):
        """修剪消息（保留最近的）"""
        # 始终保留第一条 system message
        system_msgs = [m for m in self.messages if m["role"] == "system"]
        other_msgs = [m for m in self.messages if m["role"] != "system"]

        # 保留最近的 max_messages - len(system_msgs) 条
        keep_count = self.max_messages - len(system_msgs)
        other_msgs = other_msgs[-keep_count:]

        self.messages = system_msgs + other_msgs

    def get_messages(self) -> List[Dict[str, Any]]:
        """获取所有消息（用于传给 LLM）"""
        return self.messages

    def get_last_n(self, n: int) -> List[Dict[str, Any]]:
        """获取最后 N 条消息"""
        return self.messages[-n:]

    def create_checkpoint(self) -> int:
        """创建检查点（用于时间旅行）

        Returns:
            检查点索引
        """
        checkpoint_idx = len(self.messages)
        self._checkpoints.append(checkpoint_idx)
        return checkpoint_idx

    def revert_to_checkpoint(self, checkpoint_idx: int):
        """回退到检查点

        Args:
            checkpoint_idx: 检查点索引
        """
        if checkpoint_idx > len(self.messages):
            raise ValueError(f"Invalid checkpoint: {checkpoint_idx}")

        # 丢弃检查点之后的所有消息
        self.messages = self.messages[:checkpoint_idx]

        # 重写历史文件
        with open(self.history_file, 'w', encoding='utf-8') as f:
            for msg in self.messages:
                f.write(json.dumps(msg, ensure_ascii=False) + '\n')

    def clear(self):
        """清空上下文"""
        self.messages = []
        if self.history_file.exists():
            self.history_file.unlink()

    def __len__(self):
        """返回消息数量"""
        return len(self.messages)

    def __repr__(self):
        return f"Context(messages={len(self.messages)}, file={self.history_file})"
```

## 5.5 使用 Context

让我们看看如何在 Agent 中使用这个 Context：

```python
# agent.py

from pathlib import Path
from context import Context

class Agent:
    def __init__(self, session_id: str):
        # 创建会话专属的历史文件
        history_file = Path(f"~/.my-agent/sessions/{session_id}.jsonl").expanduser()

        self.context = Context(
            history_file=history_file,
            max_messages=100  # 最多保留 100 条消息
        )

        # 初始化系统提示
        if len(self.context) == 0:
            self.context.add_message(
                role="system",
                content="You are a helpful coding assistant."
            )

    async def run(self, user_input: str) -> str:
        # 1. 添加用户输入
        self.context.add_message("user", user_input)

        # 2. 调用 LLM
        response = await self.llm.generate(
            messages=self.context.get_messages()
        )

        # 3. 添加 Assistant 回复
        self.context.add_message("assistant", response.content)

        return response.content
```

### 继续之前的会话

```python
# 第一次运行
agent = Agent(session_id="session-123")
await agent.run("Hello!")
# Context 被保存到 session-123.jsonl

# 程序退出...

# 第二次运行（同一个 session_id）
agent = Agent(session_id="session-123")
# Context 自动从 session-123.jsonl 加载
# Agent 记得之前的对话！
```

## 5.6 Token 计数：上下文的成本

### 为什么要关心 Token 数？

LLM API 是按 Token 计费的：

```
输入成本 = (输入 tokens) × (价格每千 tokens)
输出成本 = (输出 tokens) × (价格每千 tokens)
```

如果你的上下文有 10,000 个 tokens，每次调用 LLM 都要为这 10,000 tokens 付费！

### 估算 Token 数

一个粗略的规则：**1 token ≈ 4 个字符**（英文）或 **1.5-2 个中文字**。

```python
def estimate_tokens(text: str) -> int:
    """粗略估算 token 数"""
    # 英文：1 token ≈ 4 chars
    # 中文：1 token ≈ 1.5 chars
    chinese_chars = sum(1 for c in text if '\u4e00' <= c <= '\u9fff')
    other_chars = len(text) - chinese_chars

    return int(chinese_chars / 1.5 + other_chars / 4)
```

### 精确计数

使用 `tiktoken` 库（OpenAI 的官方 tokenizer）：

```python
import tiktoken

def count_tokens(text: str, model: str = "gpt-4") -> int:
    """精确计算 token 数"""
    encoding = tiktoken.encoding_for_model(model)
    return len(encoding.encode(text))

# 示例
text = "Hello, how are you?"
tokens = count_tokens(text)
print(f"{text} = {tokens} tokens")
# Hello, how are you? = 6 tokens
```

### 上下文的 Token 预算

```python
class Context:
    def __init__(self, ..., max_tokens: int = 100000):
        self.max_tokens = max_tokens
        # ... 其他代码

    def get_token_count(self) -> int:
        """计算当前上下文的 token 数"""
        total = 0
        for msg in self.messages:
            total += count_tokens(msg.get("content", ""))
        return total

    def add_message(self, ...):
        # ... 添加消息

        # 检查 token 数
        if self.get_token_count() > self.max_tokens:
            self._trim_by_tokens()

    def _trim_by_tokens(self):
        """按 token 数修剪"""
        while self.get_token_count() > self.max_tokens and len(self.messages) > 1:
            # 移除最早的非系统消息
            for i, msg in enumerate(self.messages):
                if msg["role"] != "system":
                    self.messages.pop(i)
                    break
```

## 5.7 实战：添加上下文统计

让我们给 Context 添加一些实用的统计功能：

```python
class Context:
    # ... 之前的代码

    def get_stats(self) -> dict:
        """获取上下文统计信息"""
        stats = {
            "total_messages": len(self.messages),
            "by_role": {},
            "total_tokens": 0,
            "by_role_tokens": {},
        }

        for msg in self.messages:
            role = msg["role"]

            # 统计消息数
            stats["by_role"][role] = stats["by_role"].get(role, 0) + 1

            # 统计 tokens
            tokens = count_tokens(msg.get("content", ""))
            stats["total_tokens"] += tokens
            stats["by_role_tokens"][role] = \
                stats["by_role_tokens"].get(role, 0) + tokens

        return stats

    def print_stats(self):
        """打印统计信息"""
        stats = self.get_stats()

        print("=" * 50)
        print("上下文统计")
        print("=" * 50)
        print(f"总消息数: {stats['total_messages']}")
        print(f"总 Tokens: {stats['total_tokens']:,}")
        print()
        print("按角色分组:")
        for role, count in stats['by_role'].items():
            tokens = stats['by_role_tokens'].get(role, 0)
            print(f"  {role:12s}: {count:3d} 条消息, {tokens:6,} tokens")
        print("=" * 50)
```

使用：

```python
context.print_stats()
```

输出：

```
==================================================
上下文统计
==================================================
总消息数: 25
总 Tokens: 12,458

按角色分组:
  system      :   1 条消息,    156 tokens
  user        :  10 条消息,  2,340 tokens
  assistant   :   8 条消息,  6,892 tokens
  tool        :   6 条消息,  3,070 tokens
==================================================
```

## 5.8 小结

在这一章，我们深入学习了上下文管理：

- ✅ **上下文的重要性**：Agent 的短期记忆
- ✅ **四种角色**：system、user、assistant、tool
- ✅ **持久化**：使用 JSON Lines 格式保存
- ✅ **限制管理**：按消息数或 Token 数修剪
- ✅ **检查点**：支持时间旅行（下一章详解）
- ✅ **统计功能**：监控上下文使用情况

上下文管理看似简单，实则精妙。一个好的上下文管理器能让 Agent：

- 记住对话历史
- 控制成本
- 支持长时间运行
- 提供调试信息

在下一章，我们将学习如何实现各种文件操作工具，让 Agent 真正能够"动手"操作代码！

---

**上一章**：[第 4 章：工具系统设计](./04-tool-system.md) ←
**下一章**：[第 6 章：文件操作工具](./06-file-tools.md) →
