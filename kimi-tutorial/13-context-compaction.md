# 第 13 章：上下文压缩

长时间对话后，你会遇到一个问题：

```
Agent: 抱歉，上下文太长了，我必须忘记一些早期的对话...
```

这就是 **上下文窗口限制**。即使是 Claude 的 200K 上下文，也终有用完的一天。

**上下文压缩（Context Compaction）** 是解决方案——智能地压缩历史，保留重要信息。

## 13.1 为什么需要压缩？

### Token 限制

| 模型 | 上下文窗口 | 大约对话轮数 |
|------|-----------|-------------|
| GPT-4 | 8K | ~20 轮 |
| GPT-4-32K | 32K | ~80 轮 |
| Claude 3 Opus | 200K | ~500 轮 |
| Gemini 1.5 Pro | 1M | ~2500 轮 |

看起来很多？但考虑：
- 每次工具调用都会添加消息
- 代码内容占用大量 tokens
- 重复的文件读取

实际上，20-30 轮对话后就可能遇到限制。

### 成本问题

即使不超限，长上下文也很贵：

```
100K tokens × $0.01/1K = $1 每次请求！
```

## 13.2 压缩策略

### 策略 1：滑动窗口（最简单）

保留最近的 N 条消息，丢弃旧的：

```python
def sliding_window(messages: list, window_size: int = 50):
    """滑动窗口"""
    if len(messages) <= window_size:
        return messages

    # 保留 system prompt + 最近的消息
    system_msgs = [m for m in messages if m["role"] == "system"]
    recent_msgs = messages[-window_size:]

    return system_msgs + recent_msgs
```

**优点**：简单
**缺点**：可能丢失重要信息

### 策略 2：重要性评分

根据重要性保留消息：

```python
def score_message(msg: dict) -> float:
    """评估消息重要性（0-1）"""

    score = 0.5  # 基础分

    # 用户消息更重要
    if msg["role"] == "user":
        score += 0.2

    # 包含错误信息很重要
    if "error" in msg.get("content", "").lower():
        score += 0.3

    # 工具调用结果重要
    if msg["role"] == "tool":
        score += 0.1

    # 最近的消息更重要（时间衰减）
    # age = (current_index - msg_index) / total_messages
    # score *= (1 - age * 0.5)

    return min(score, 1.0)

def importance_based_compaction(messages: list, target_size: int):
    """基于重要性压缩"""

    # 评分
    scored = [(msg, score_message(msg)) for msg in messages]

    # 排序（保留最重要的）
    scored.sort(key=lambda x: x[1], reverse=True)

    # 取前 N 个
    kept = scored[:target_size]

    # 恢复原始顺序
    kept.sort(key=lambda x: messages.index(x[0]))

    return [msg for msg, _ in kept]
```

### 策略 3：摘要压缩（最智能）

用 LLM 总结旧对话：

```python
async def summarize_old_messages(messages: list, llm) -> str:
    """总结旧消息"""

    # 将旧消息转换为文本
    text = "\n".join([
        f"{m['role']}: {m.get('content', '')[:200]}"
        for m in messages
    ])

    # 请求 LLM 总结
    summary = await llm.generate(
        messages=[{
            "role": "user",
            "content": f"请简要总结以下对话的关键信息：\n\n{text}"
        }]
    )

    return summary.content

async def summary_based_compaction(
    messages: list,
    llm,
    keep_recent: int = 20
):
    """基于摘要的压缩"""

    if len(messages) <= keep_recent:
        return messages

    # 旧消息 = 需要总结的
    old_messages = messages[:-keep_recent]
    recent_messages = messages[-keep_recent:]

    # 总结旧消息
    summary = await summarize_old_messages(old_messages, llm)

    # 构建新的上下文
    return [
        {"role": "system", "content": f"对话摘要：\n{summary}"},
        *recent_messages
    ]
```

## 13.3 实现智能压缩器

```python
# compactor.py

class ContextCompactor:
    """上下文压缩器"""

    def __init__(
        self,
        max_tokens: int = 100_000,
        strategy: str = "hybrid"
    ):
        self.max_tokens = max_tokens
        self.strategy = strategy

    async def compact(
        self,
        messages: list,
        llm=None
    ) -> list:
        """压缩上下文"""

        # 检查是否需要压缩
        current_tokens = self._estimate_tokens(messages)

        if current_tokens <= self.max_tokens:
            return messages  # 不需要压缩

        # 根据策略压缩
        if self.strategy == "sliding":
            return self._sliding_window(messages)
        elif self.strategy == "importance":
            return self._importance_based(messages)
        elif self.strategy == "summary" and llm:
            return await self._summary_based(messages, llm)
        elif self.strategy == "hybrid":
            return await self._hybrid(messages, llm)
        else:
            return self._sliding_window(messages)  # 默认

    def _estimate_tokens(self, messages: list) -> int:
        """估算 token 数"""
        total = 0
        for msg in messages:
            content = msg.get("content", "")
            # 粗略估算：4 字符 ≈ 1 token
            total += len(content) // 4
        return total

    def _sliding_window(self, messages: list) -> list:
        """滑动窗口压缩"""
        target_size = int(len(messages) * 0.7)  # 保留 70%
        return messages[-target_size:]

    def _importance_based(self, messages: list) -> list:
        """基于重要性的压缩"""
        # ... 实现如上

    async def _summary_based(self, messages: list, llm) -> list:
        """基于摘要的压缩"""
        # ... 实现如上

    async def _hybrid(self, messages: list, llm) -> list:
        """混合策略"""

        # 1. 先用重要性过滤掉明显不重要的
        important = self._importance_based(messages)

        # 2. 如果还是太长，摘要最旧的部分
        if self._estimate_tokens(important) > self.max_tokens:
            return await self._summary_based(important, llm)

        return important
```

## 13.4 在 Agent 中使用

```python
class Agent:
    def __init__(self, ..., compactor: ContextCompactor):
        self.compactor = compactor

    async def run(self, user_input: str) -> str:
        # 添加用户输入
        self.context.add_message("user", user_input)

        # 检查是否需要压缩
        if self.compactor.should_compact(self.context.messages):
            print("[压缩] 上下文太长，正在压缩...")

            compressed = await self.compactor.compact(
                self.context.messages,
                llm=self.llm
            )

            self.context.messages = compressed
            print(f"[压缩] 完成！{len(self.context.messages)} 条消息")

        # 继续正常流程
        response = await self.llm.generate(...)
        ...
```

## 13.5 压缩的注意事项

### 1. 不要压缩太频繁

```python
# ❌ 每次都压缩（太频繁）
await compactor.compact(messages)

# ✅ 仅当接近限制时压缩
if estimate_tokens(messages) > max_tokens * 0.9:
    await compactor.compact(messages)
```

### 2. 保护关键消息

```python
# 永远不压缩的消息
PROTECTED_ROLES = ["system"]  # 系统提示词
PROTECTED_MARKERS = ["IMPORTANT", "KEEP"]  # 标记的重要消息

def is_protected(msg: dict) -> bool:
    if msg["role"] in PROTECTED_ROLES:
        return True

    content = msg.get("content", "")
    return any(marker in content for marker in PROTECTED_MARKERS)
```

### 3. 记录压缩历史

```python
class ContextCompactor:
    def __init__(self):
        self.compression_log = []

    async def compact(self, messages):
        original_count = len(messages)
        original_tokens = self._estimate_tokens(messages)

        compressed = await self._do_compact(messages)

        # 记录
        self.compression_log.append({
            "timestamp": datetime.now(),
            "original_count": original_count,
            "original_tokens": original_tokens,
            "compressed_count": len(compressed),
            "compressed_tokens": self._estimate_tokens(compressed),
            "ratio": len(compressed) / original_count
        })

        return compressed
```

## 13.6 小结

上下文压缩让 Agent 能够进行长时间对话：

- ✅ **滑动窗口**：简单但可能丢信息
- ✅ **重要性评分**：智能保留关键信息
- ✅ **摘要压缩**：最智能，成本略高
- ✅ **混合策略**：结合多种方法

选择策略取决于你的需求：
- 成本敏感 → 滑动窗口
- 信息敏感 → 重要性评分
- 长期对话 → 摘要压缩

记住：**压缩是权衡，不是银弹**。最好的方案是设计 Agent 不需要超长上下文！

---

**上一章**：[第 12 章：思维模式](./12-thinking-mode.md) ←
**下一章**：[第 14 章：UI 模式](./14-ui-modes.md) →
