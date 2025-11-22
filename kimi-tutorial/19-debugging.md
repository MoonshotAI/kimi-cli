# 第 19 章：调试技巧

Agent 不按预期工作？让我们调试它！

## 19.1 启用调试日志

```python
import logging

logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

logger = logging.getLogger(__name__)

class Agent:
    async def run(self, user_input):
        logger.debug(f"用户输入: {user_input}")

        response = await self.llm.generate(...)
        logger.debug(f"LLM 响应: {response}")

        # ...
```

## 19.2 查看上下文历史

```python
# 显示对话历史
agent.context.print_history()

# 保存到文件
agent.context.save_debug_log("debug.txt")
```

## 19.3 单步执行

添加断点模式：

```python
class Agent:
    def __init__(self, debug_mode=False):
        self.debug_mode = debug_mode

    async def run(self, user_input):
        if self.debug_mode:
            input("按 Enter 继续...")  # 断点

        # 执行...
```

## 19.4 常见问题

### 问题 1：Agent 陷入循环

**症状**：重复调用相同工具

**解决**：
```python
# 检测循环
class LoopDetector:
    def __init__(self, max_repeats=3):
        self.history = []
        self.max_repeats = max_repeats

    def check(self, tool_name, params):
        signature = (tool_name, str(params))
        self.history.append(signature)

        # 检查最近的调用
        recent = self.history[-self.max_repeats:]
        if len(recent) == self.max_repeats and len(set(recent)) == 1:
            raise LoopDetected(f"检测到循环: {tool_name}")
```

### 问题 2：工具执行失败

**症状**：工具返回错误

**调试**：
```python
# 详细的错误日志
try:
    result = await tool.execute(params)
except Exception as e:
    logger.error(f"工具 {tool.name} 失败")
    logger.error(f"参数: {params}")
    logger.error(f"错误: {e}", exc_info=True)  # 包含堆栈跟踪
    raise
```

---

**上一章**：[第 18 章：测试策略](./18-testing.md) ←
**下一章**：[第 20 章：部署和分发](./20-deployment.md) →
