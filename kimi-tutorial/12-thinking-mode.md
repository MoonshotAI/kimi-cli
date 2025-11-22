# 第 12 章：思维模式

你有没有注意到，当面对复杂问题时，ChatGPT 会"思考"一会儿？

那不是延迟——那是 **Extended Thinking（扩展思维）**，LLM 的一种特殊能力。

在这一章，我们将学习如何在 Agent 中启用思维模式，让它能够更深入地推理。

## 12.1 什么是思维模式？

### 普通模式 vs 思维模式

**普通模式**：LLM 直接生成答案

```
用户: 这个算法的时间复杂度是多少？

LLM 思考过程: (不可见)

LLM 回复: "O(n²)"
```

**思维模式**：LLM 先"思考"，然后回答

```
用户: 这个算法的时间复杂度是多少？

LLM 思考过程: (可见！)
<thinking>
让我分析这个算法...
外层循环：n 次迭代
内层循环：每次 n 次迭代
所以总共 n × n = n²
</thinking>

LLM 回复: "O(n²)"
```

### 为什么需要思维模式？

对于复杂任务，思维模式能帮助 LLM：

- 🧮 **分解问题**：一步一步推理
- 🔍 **发现错误**：自我纠正
- 📊 **权衡方案**：比较多个选项
- 🎯 **提高准确性**：更仔细的推理

## 12.2 OpenAI 的实现：o1 模型

OpenAI 的 o1 模型原生支持思维模式：

```python
response = await client.chat.completions.create(
    model="o1-preview",  # 思维模型
    messages=[
        {"role": "user", "content": "解决这个数学题..."}
    ]
)

# 响应包含思维过程
print(response.choices[0].message.reasoning)
# "让我先分析题目...然后..."

print(response.choices[0].message.content)
# "答案是 42"
```

## 12.3 其他模型的实现：Thinking Block

对于不原生支持的模型（如 GPT-4、Claude），我们可以通过**提示词工程**实现：

### 系统提示词增强

```markdown
<!-- system.md -->

You are a helpful assistant.

## Thinking Mode

When facing complex problems, use thinking blocks to reason through them:

\`\`\`thinking
[Your step-by-step reasoning here]
1. First, I need to...
2. Then, I should consider...
3. Therefore...
\`\`\`

After thinking, provide your final answer.

Example:
User: "What's 15% of 240?"

\`\`\`thinking
- 15% = 15/100 = 0.15
- 240 × 0.15 = ?
- 240 × 0.15 = 24 × 1.5 = 36
\`\`\`

Answer: 36
```

### 解析思维块

```python
# thinking_parser.py

import re

def parse_thinking(response: str) -> tuple[str | None, str]:
    """解析响应中的思维块

    Args:
        response: LLM 的完整响应

    Returns:
        (思维内容, 最终答案)
    """

    # 查找思维块
    thinking_pattern = r'```thinking\n(.*?)\n```'
    match = re.search(thinking_pattern, response, re.DOTALL)

    if match:
        thinking = match.group(1).strip()
        # 移除思维块，剩下的就是答案
        answer = re.sub(thinking_pattern, '', response, flags=re.DOTALL).strip()
        return thinking, answer
    else:
        # 没有思维块
        return None, response
```

## 12.4 在 Agent 中集成思维模式

### 添加思维模式开关

```python
# agent.py

class Agent:
    def __init__(
        self,
        ...,
        thinking_enabled: bool = False
    ):
        self.thinking_enabled = thinking_enabled

    async def run(self, user_input: str) -> str:
        """运行 Agent"""

        # 添加用户输入
        self.context.add_message("user", user_input)

        # 调用 LLM
        response = await self.llm.generate(
            messages=self.context.get_messages(),
            # 如果启用思维模式，提示 LLM 使用思维块
            thinking=self.thinking_enabled
        )

        # 解析响应
        if self.thinking_enabled:
            thinking, answer = parse_thinking(response.content)

            if thinking:
                # 显示思维过程
                self._display_thinking(thinking)

            # 只将最终答案添加到上下文
            self.context.add_message("assistant", answer)

            return answer
        else:
            # 普通模式
            self.context.add_message("assistant", response.content)
            return response.content

    def _display_thinking(self, thinking: str):
        """显示思维过程"""
        from rich.console import Console
        from rich.panel import Panel

        console = Console()
        console.print(Panel(
            thinking,
            title="🧠 Agent 正在思考...",
            border_style="cyan",
            padding=(1, 2)
        ))
```

### 使用示例

```python
# 创建启用思维模式的 Agent
agent = Agent(thinking_enabled=True)

# 提问
response = await agent.run("如何优化这个函数？")
```

输出：

```
┌─────── 🧠 Agent 正在思考... ───────┐
│                                    │
│  让我分析这个函数:                  │
│                                    │
│  1. 当前实现使用嵌套循环，O(n²)     │
│  2. 可以用哈希表优化到 O(n)         │
│  3. 需要权衡空间复杂度              │
│  4. 对于这个用例，空间换时间值得     │
│                                    │
└────────────────────────────────────┘

我建议使用哈希表来优化这个函数。具体来说...
```

## 12.5 思维的可视化

对于复杂的思维过程，我们可以用树状图可视化：

```python
# thinking_tree.py

from rich.tree import Tree
from rich.console import Console

class ThinkingTree:
    """思维树可视化"""

    def __init__(self):
        self.console = Console()

    def visualize(self, thinking: str):
        """将思维过程可视化为树"""

        # 创建根节点
        tree = Tree("🧠 思维过程")

        # 解析思维内容（假设用缩进表示层次）
        lines = thinking.split('\n')
        stack = [tree]  # 节点栈

        for line in lines:
            if not line.strip():
                continue

            # 计算缩进级别
            indent = len(line) - len(line.lstrip())
            level = indent // 2

            # 调整栈深度
            while len(stack) > level + 1:
                stack.pop()

            # 添加节点
            node = stack[-1].add(line.strip())
            stack.append(node)

        self.console.print(tree)
```

使用：

```python
thinking = """
分析问题
  识别瓶颈
    循环嵌套
    重复计算
  评估影响
    性能下降 60%
制定方案
  方案 A: 哈希表
    优点: O(n)
    缺点: 需要额外空间
  方案 B: 排序
    优点: 不需额外空间
    缺点: O(n log n)
选择方案 A
  因为性能更重要
"""

visualizer = ThinkingTree()
visualizer.visualize(thinking)
```

输出：

```
🧠 思维过程
├── 分析问题
│   ├── 识别瓶颈
│   │   ├── 循环嵌套
│   │   └── 重复计算
│   └── 评估影响
│       └── 性能下降 60%
├── 制定方案
│   ├── 方案 A: 哈希表
│   │   ├── 优点: O(n)
│   │   └── 缺点: 需要额外空间
│   └── 方案 B: 排序
│       ├── 优点: 不需额外空间
│       └── 缺点: O(n log n)
└── 选择方案 A
    └── 因为性能更重要
```

## 12.6 何时使用思维模式？

### 适合使用的场景

- ✅ **复杂推理**：需要多步推导
- ✅ **代码重构**：需要分析权衡
- ✅ **调试**：需要系统排查
- ✅ **架构设计**：需要评估方案

### 不适合的场景

- ❌ **简单问题**："现在几点？"（浪费 tokens）
- ❌ **紧急操作**：思维模式会慢一些
- ❌ **成本敏感**：思维会增加 token 消耗

### 智能切换

```python
class Agent:
    def should_use_thinking(self, user_input: str) -> bool:
        """判断是否应该使用思维模式"""

        # 关键词匹配
        complex_keywords = [
            "为什么", "如何", "分析", "比较",
            "优化", "重构", "设计", "解释"
        ]

        for keyword in complex_keywords:
            if keyword in user_input:
                return True

        # 输入长度（长输入通常更复杂）
        if len(user_input) > 100:
            return True

        return False

    async def run(self, user_input: str) -> str:
        # 自动决定是否使用思维模式
        use_thinking = (
            self.thinking_enabled and
            self.should_use_thinking(user_input)
        )

        # ... 执行
```

## 12.7 与 Claude 的结合

Claude 3.5 Sonnet 有一个特殊的"Extended Thinking"能力：

```python
# 使用 Claude 的扩展思维
response = await anthropic.messages.create(
    model="claude-3-5-sonnet-20241022",
    messages=[{"role": "user", "content": "..."}],
    thinking={
        "type": "enabled",
        "budget_tokens": 10000  # 思维预算
    }
)

# Claude 的思维是单独返回的
for block in response.content:
    if block.type == "thinking":
        print(f"思考: {block.thinking}")
    elif block.type == "text":
        print(f"回答: {block.text}")
```

## 12.8 小结

思维模式让 Agent 能够：

- ✅ **深度推理**：系统性地分析问题
- ✅ **可解释性**：展示思维过程
- ✅ **提高准确性**：减少冲动回答
- ✅ **自我纠正**：在思考中发现错误

记住：**思维不是银弹**。对于简单任务，普通模式更快更便宜。但对于复杂问题，花时间思考绝对值得。

正如《思考，快与慢》一书所说：有些问题需要"慢思考"。

---

**上一章**：[第 11 章：时间旅行](./11-time-travel.md) ←
**下一章**：[第 13 章：上下文压缩](./13-context-compaction.md) →
