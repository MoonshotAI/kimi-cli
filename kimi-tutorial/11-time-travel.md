# 第 11 章：时间旅行

> "如果能回到过去就好了..."

你肯定有过这种想法，特别是当 Agent 做了错误的操作时：

```
Agent: 我已经删除了所有测试文件，因为它们看起来过时了
你: 什么?! 那些测试很重要！
Agent: 呃...我不能撤销 😅
```

**时间旅行（Time Travel）** 让 Agent 能够"回到过去"，撤销错误的决策。

这是 kimi-cli 最酷的特性之一，灵感来自动漫《命运石之门》（Steins;Gate）中的"D-Mail"系统。

## 11.1 核心概念

### 检查点（Checkpoint）

想象对话历史是一条时间线：

```
时间 →
[用户] 读取 config.py
[Agent] [读取文件]
[工具] 文件内容...
[Agent] 这个文件定义了配置
👈 Checkpoint 1

[用户] 修改第 10 行
[Agent] [修改文件]
👈 Checkpoint 2

[用户] 运行测试
[Agent] [运行测试]
[工具] 测试失败！
👈 Checkpoint 3
```

**检查点**是对话历史的"保存点"。我们可以：
- 回到 Checkpoint 2，撤销测试运行
- 回到 Checkpoint 1，撤销文件修改
- 从检查点开始新的时间线

### D-Mail

在《命运石之门》中，D-Mail 是发送到过去的短信，可以改变历史。

在 kimi-cli 中，**D-Mail 是发送到过去检查点的消息**：

```
[Checkpoint 2] Agent 修改了文件

你发送 D-Mail 到 Checkpoint 2:
"不要修改第 10 行，修改第 12 行"

→ 时间线分叉！
→ 新的历史：Agent 修改第 12 行
```

## 11.2 实现检查点系统

### 在 Context 中添加检查点

```python
# context.py（扩展）

class Context:
    def __init__(self, ...):
        # ... 之前的代码
        self._checkpoints: Dict[str, int] = {}  # {checkpoint_id: message_index}

    def create_checkpoint(self, checkpoint_id: str | None = None) -> str:
        """创建检查点

        Args:
            checkpoint_id: 检查点 ID（如果为 None，自动生成）

        Returns:
            检查点 ID
        """
        if checkpoint_id is None:
            # 自动生成 ID
            checkpoint_id = f"cp_{len(self._checkpoints) + 1}"

        # 记录当前位置
        self._checkpoints[checkpoint_id] = len(self.messages)

        # 添加标记到历史
        self.add_message(
            role="system",
            content=f"[CHECKPOINT: {checkpoint_id}]"
        )

        return checkpoint_id

    def get_checkpoint(self, checkpoint_id: str) -> int | None:
        """获取检查点位置"""
        return self._checkpoints.get(checkpoint_id)

    def revert_to_checkpoint(self, checkpoint_id: str) -> bool:
        """回退到检查点

        Args:
            checkpoint_id: 检查点 ID

        Returns:
            True 如果成功，False 如果检查点不存在
        """
        checkpoint_idx = self.get_checkpoint(checkpoint_id)
        if checkpoint_idx is None:
            return False

        # 丢弃检查点之后的消息
        self.messages = self.messages[:checkpoint_idx]

        # 重写历史文件
        with open(self.history_file, 'w', encoding='utf-8') as f:
            for msg in self.messages:
                f.write(json.dumps(msg, ensure_ascii=False) + '\n')

        return True

    def list_checkpoints(self) -> list[tuple[str, int]]:
        """列出所有检查点"""
        return sorted(self._checkpoints.items(), key=lambda x: x[1])
```

### 在 Agent 主循环中创建检查点

```python
# agent.py

class Agent:
    async def run(self, user_input: str) -> str:
        """运行 Agent"""

        # 1. 添加用户输入
        self.context.add_message("user", user_input)

        # 2. 创建检查点（在开始推理前）
        checkpoint_id = self.context.create_checkpoint()
        print(f"[DEBUG] 创建检查点: {checkpoint_id}")

        # 3. 主循环
        while True:
            # LLM 推理
            response = await self.llm.generate(...)

            # 执行工具
            if response.tool_calls:
                ...

            # 如果完成，返回
            if not response.tool_calls:
                return response.content
```

## 11.3 实现 D-Mail 工具

现在让我们实现一个工具，允许 Agent（或用户）发送 D-Mail：

```python
# tools/dmail.py

from pydantic import BaseModel, Field

class DMail Params(BaseModel):
    checkpoint_id: str = Field(description="目标检查点 ID")
    message: str = Field(description="要发送的消息")

class DMailTool:
    """D-Mail 工具（时间旅行）"""

    name = "send_dmail"
    description = """发送消息到过去的检查点，改变时间线。

    用途：
    - 撤销错误的决策
    - 尝试不同的方法
    - 修正误解

    注意：这会丢弃检查点之后的所有历史！
    """

    def __init__(self, context: Context, agent: Agent):
        """
        Args:
            context: 上下文管理器
            agent: Agent 实例（用于重新运行）
        """
        self.context = context
        self.agent = agent

    async def execute(self, params: DMailParams) -> str:
        """执行 D-Mail"""

        # 1. 检查检查点是否存在
        if params.checkpoint_id not in self.context._checkpoints:
            available = ", ".join(self.context._checkpoints.keys())
            return f"❌ 检查点不存在: {params.checkpoint_id}\n" \
                   f"可用的检查点: {available}"

        # 2. 保存当前状态（以防后悔）
        backup_checkpoint = self.context.create_checkpoint("before_dmail")

        # 3. 回退到目标检查点
        self.context.revert_to_checkpoint(params.checkpoint_id)

        # 4. 添加 D-Mail 消息
        self.context.add_message(
            role="user",
            content=f"[D-MAIL] {params.message}"
        )

        return f"✅ 已发送 D-Mail 到 {params.checkpoint_id}\n" \
               f"时间线已改变。备份检查点: {backup_checkpoint}\n\n" \
               f"Agent 将根据新的指示重新运行。"
```

## 11.4 使用时间旅行

### 场景 1：撤销错误操作

```python
# 对话过程
用户: "删除所有 .pyc 文件"
Agent: [创建 checkpoint_1]
Agent: [执行 shell("find . -name '*.pyc' -delete")]
Agent: "已删除 42 个 .pyc 文件"

# 糟糕！用户发现误删了重要文件

用户: "等等，你也删除了 important.pyc！"

# 使用 D-Mail 回退
agent.send_dmail(
    checkpoint_id="checkpoint_1",
    message="只删除 __pycache__ 目录下的 .pyc 文件"
)

# 新的时间线
Agent: [从 checkpoint_1 重新开始]
Agent: [执行 shell("find __pycache__ -name '*.pyc' -delete")]
Agent: "已删除 38 个 .pyc 文件（仅 __pycache__）"
```

### 场景 2：探索不同方案

```python
# 时间线 A：使用方案 1
用户: "优化这个函数"
Agent: [checkpoint_main]
Agent: [使用列表推导式重写]
用户: "性能提升不明显"

# 回到过去，尝试方案 2
send_dmail(
    checkpoint_id="checkpoint_main",
    message="使用生成器而不是列表推导式"
)

# 时间线 B：使用方案 2
Agent: [从 checkpoint_main 重新开始]
Agent: [使用生成器重写]
用户: "好多了！性能提升 60%"
```

## 11.5 时间线可视化

为了帮助用户理解时间旅行，我们可以可视化时间线：

```python
# tools/timeline.py

class TimelineVisualizer:
    """时间线可视化"""

    def visualize(self, context: Context) -> str:
        """生成时间线图"""

        output = "时间线:\n\n"

        for i, msg in enumerate(context.messages):
            role = msg["role"]
            content = msg.get("content", "")[:50]

            # 检查点标记
            checkpoint_marker = ""
            for cp_id, cp_idx in context._checkpoints.items():
                if cp_idx == i:
                    checkpoint_marker = f" 👈 {cp_id}"

            # D-Mail 标记
            dmail_marker = ""
            if "[D-MAIL]" in content:
                dmail_marker = " ⏰"

            output += f"{i:3d}. [{role:10s}] {content}{checkpoint_marker}{dmail_marker}\n"

        return output
```

输出示例：

```
时间线:

  0. [system    ] You are a helpful assistant...
  1. [user      ] 读取 config.py
  2. [assistant ] [tool call]
  3. [tool      ] 文件内容...
  4. [assistant ] 这个文件定义了配置 👈 cp_1
  5. [user      ] 修改第 10 行 ⏰
  6. [assistant ] [tool call]
  7. [tool      ] 已修改
  8. [assistant ] 修改完成 👈 cp_2
```

## 11.6 高级特性：时间线分支

有时你想保留多个时间线分支：

```python
class BranchingContext:
    """支持分支的上下文"""

    def __init__(self, ...):
        self.branches = {
            "main": []  # 主时间线
        }
        self.current_branch = "main"

    def create_branch(self, branch_name: str, from_checkpoint: str):
        """从检查点创建新分支"""

        checkpoint_idx = self.get_checkpoint(from_checkpoint)
        if checkpoint_idx is None:
            raise ValueError(f"检查点不存在: {from_checkpoint}")

        # 复制到新分支
        self.branches[branch_name] = self.messages[:checkpoint_idx].copy()

    def switch_branch(self, branch_name: str):
        """切换分支"""

        if branch_name not in self.branches:
            raise ValueError(f"分支不存在: {branch_name}")

        # 保存当前分支
        self.branches[self.current_branch] = self.messages

        # 切换到新分支
        self.messages = self.branches[branch_name]
        self.current_branch = branch_name

    def merge_branch(self, branch_name: str):
        """合并分支（简单版：追加消息）"""

        if branch_name not in self.branches:
            raise ValueError(f"分支不存在: {branch_name}")

        # 追加分支的新消息
        branch_messages = self.branches[branch_name]
        self.messages.extend(branch_messages)
```

使用：

```python
# 创建实验分支
context.create_branch("experiment", from_checkpoint="cp_1")
context.switch_branch("experiment")

# 在实验分支上尝试
agent.run("尝试激进的优化")

# 如果成功，合并到主分支
context.switch_branch("main")
context.merge_branch("experiment")
```

## 11.7 安全考虑

时间旅行很强大，但也有风险：

### 问题 1：无限循环

```python
# Agent 可能陷入循环
while True:
    result = try_something()
    if not good(result):
        send_dmail(checkpoint, "try differently")
        # 回到过去，再次尝试...永远循环！
```

**解决方案**：限制 D-Mail 次数

```python
class DMailTool:
    def __init__(self, ..., max_dmails: int = 5):
        self.max_dmails = max_dmails
        self.dmail_count = 0

    async def execute(self, params):
        if self.dmail_count >= self.max_dmails:
            return "❌ 已达到 D-Mail 次数上限"

        self.dmail_count += 1
        # ... 执行 D-Mail
```

### 问题 2：状态不一致

如果 Agent 在时间旅行前已经修改了文件系统，回退上下文不会撤销这些修改！

**解决方案**：事务性操作

```python
class TransactionalFileSystem:
    """事务性文件系统"""

    def begin_transaction(self):
        """开始事务（记录当前状态）"""
        self.snapshot = self._create_snapshot()

    def commit_transaction(self):
        """提交事务"""
        self.snapshot = None

    def rollback_transaction(self):
        """回滚事务（恢复快照）"""
        if self.snapshot:
            self._restore_snapshot(self.snapshot)
```

## 11.8 小结

时间旅行是一个强大的 debugging 和探索工具：

- ✅ **检查点系统**：保存对话状态
- ✅ **D-Mail**：发送消息到过去
- ✅ **时间线可视化**：理解历史
- ✅ **分支管理**：探索多个可能性
- ⚠️ **安全限制**：避免无限循环和状态不一致

时间旅行让 Agent 能够"从错误中学习"，尝试不同的方法，最终找到最佳解决方案。

这正是《命运石之门》的主题：改变过去，创造更好的未来！

---

**上一章**：[第 10 章：多代理系统](./10-multiagent.md) ←
**下一章**：[第 12 章：思维模式](./12-thinking-mode.md) →
