# 第 18 章：测试策略

Agent 很复杂，如何测试？

## 18.1 测试层次

```
┌─────────────────────┐
│   E2E 测试          │  完整的 Agent 对话
├─────────────────────┤
│   集成测试          │  工具 + LLM 交互
├─────────────────────┤
│   单元测试          │  单个工具、函数
└─────────────────────┘
```

## 18.2 单元测试

测试单个工具：

```python
# tests/test_tools.py

import pytest
from tools.read_file import ReadFileTool

def test_read_file():
    """测试文件读取"""
    tool = ReadFileTool(work_dir=Path("/tmp"))

    # 创建测试文件
    test_file = Path("/tmp/test.txt")
    test_file.write_text("Hello")

    # 执行工具
    result = await tool.execute({"path": "test.txt"})

    # 验证
    assert "Hello" in result
```

## 18.3 Mock LLM

测试时不想真的调用 LLM（贵！）：

```python
class MockLLM:
    """Mock LLM"""

    async def generate(self, messages):
        # 返回预设的响应
        return Response(
            content="Mock response",
            tool_calls=[]
        )

# 在测试中使用
def test_agent():
    agent = Agent(llm=MockLLM())
    result = await agent.run("test")
    assert result is not None
```

## 18.4 集成测试

测试 Agent 的完整流程：

```python
@pytest.mark.asyncio
async def test_agent_workflow():
    """测试 Agent 完整工作流"""

    # 准备
    work_dir = Path("/tmp/test_project")
    work_dir.mkdir(exist_ok=True)

    # 创建 Agent
    agent = Agent(
        work_dir=work_dir,
        llm=MockLLM()  # 使用 Mock
    )

    # 执行任务
    result = await agent.run("创建一个 hello.py 文件")

    # 验证
    assert (work_dir / "hello.py").exists()
```

---

**上一章**：[第 17 章：KAOS 抽象](./17-kaos-abstraction.md) ←
**下一章**：[第 19 章：调试技巧](./19-debugging.md) →
