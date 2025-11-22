# 附录 B：常用 API 参考

> 快速查找 kimi-cli 的常用 API

## Agent 相关

### 加载 Agent

```python
from kimi_cli.soul.agent import load_agent

agent = load_agent(
    config_path=Path("agent.yaml"),
    runtime=runtime,
    llm=llm
)
```

## Tool 相关

### 定义工具

```python
from kosong import CallableTool2
from pydantic import BaseModel

class MyToolParams(BaseModel):
    arg1: str
    arg2: int

class MyTool(CallableTool2[MyToolParams]):
    name = "my_tool"
    description = "工具描述"
    params = MyToolParams

    async def __call__(self, params: MyToolParams):
        return ToolOk(output="结果")
```

## Context 相关

### 创建上下文

```python
from kimi_cli.soul.context import Context

context = Context(history_file=Path("history.jsonl"))
context.append({"role": "user", "content": "Hello"})
```

---

**返回**：[README](./README.md)
