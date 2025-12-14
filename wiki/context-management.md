# 上下文管理

本文档介绍 Kimi CLI 的上下文管理（Context Management）系统设计与实现。

## 设计理念

Kimi CLI 采用 **以 Session 为中心** 的上下文管理设计。每个 Session 是一个独立的会话容器，内部通过单一的 `context.jsonl` 文件存储所有上下文数据。

### 层级结构

```
~/.config/kimi/sessions/
  └── {work_dir_hash}/              # 工作目录（按路径 hash 区分）
        ├── {session_id_1}/         # Session 1 (UUID)
        │     └── context.jsonl     # 该 Session 的全部上下文
        └── {session_id_2}/         # Session 2 (UUID)
              └── context.jsonl
```

### context.jsonl 内容结构

每个 `context.jsonl` 文件以 JSONL 格式存储三类记录：

```jsonl
{"role": "user", "content": [...]}           # 用户消息
{"role": "assistant", "content": [...]}      # 助手回复
{"role": "tool", "content": [...]}           # 工具结果
{"role": "_checkpoint", "id": 0}             # 检查点标记
{"role": "_usage", "token_count": 12345}     # Token 累积统计
```

这种设计的优点：
- **简单**：一个 Session 对应一个文件，无需复杂的数据库
- **可靠**：JSONL 格式每行独立，追加写入不会破坏已有数据
- **可调试**：文件内容人类可读，便于排查问题

## 核心模块

### Session 类

**文件路径：** `src/kimi_cli/session.py`

Session 是会话的顶层容器，管理会话的生命周期。

```python
@dataclass(frozen=True, slots=True, kw_only=True)
class Session:
    id: str                          # 会话唯一 ID (UUID)
    work_dir: KaosPath               # 工作目录
    work_dir_meta: WorkDirMeta       # 工作目录元数据
    context_file: Path               # context.jsonl 文件路径
    title: str                       # 会话标题
    updated_at: float                # 最后更新时间戳
```

**核心方法：**

| 方法 | 功能 |
|------|------|
| `Session.create()` | 创建新会话，生成 UUID，创建 context.jsonl |
| `Session.find()` | 根据 session_id 查找已有会话 |
| `Session.list()` | 列出工作目录下的所有会话 |
| `Session.continue_()` | 恢复最后一个会话 |

### Context 类

**文件路径：** `src/kimi_cli/soul/context.py`

Context 是 `context.jsonl` 文件的操作封装，负责消息的读写和状态管理。

```python
class Context:
    def __init__(self, file_backend: Path):
        self._file_backend = file_backend      # context.jsonl 路径
        self._history: list[Message] = []      # 内存中的消息历史
        self._token_count: int = 0             # 累积的 token 计数
        self._next_checkpoint_id: int = 0      # 下一个 checkpoint ID
```

**核心方法：**

| 方法 | 功能 |
|------|------|
| `restore()` | 从 JSONL 文件恢复消息、token 计数、checkpoint |
| `append_message()` | 追加消息到内存和文件 |
| `update_token_count()` | 更新 token 计数并写入 `_usage` 记录 |
| `checkpoint()` | 创建检查点，写入 `_checkpoint` 记录 |
| `revert_to()` | 回溯到指定 checkpoint |
| `clear()` | 清空上下文（轮转旧文件） |

### 两者的关系

```
Session (容器)
    │
    ├── 持有 context_file 路径
    │
    └── Context (操作封装)
            │
            └── 读写 context.jsonl
                    │
                    ├── 消息 (user/assistant/tool)
                    ├── _checkpoint 标记
                    └── _usage 统计
```

## 持久化机制

### 消息追加

每条消息立即持久化，确保数据安全：

```python
async def append_message(self, message: Message | Sequence[Message]):
    # 1. 添加到内存
    self._history.extend(messages)

    # 2. 追加到文件
    async with aiofiles.open(self._file_backend, "a", encoding="utf-8") as f:
        for message in messages:
            await f.write(message.model_dump_json(exclude_none=True) + "\n")
```

### 恢复机制

启动时从 JSONL 文件逐行恢复：

```python
async def restore(self) -> bool:
    async for line in f:
        line_json = json.loads(line)

        if line_json["role"] == "_usage":
            self._token_count = line_json["token_count"]
        elif line_json["role"] == "_checkpoint":
            self._next_checkpoint_id = line_json["id"] + 1
        else:
            message = Message.model_validate(line_json)
            self._history.append(message)
```

## Token 管理

### 上下文窗口配置

```python
@dataclass(slots=True)
class LLM:
    max_context_size: int          # 最大 context 大小（token 数）
```

### 压缩触发条件

```python
RESERVED_TOKENS = 50_000  # 保留 50K tokens 用于回复

if token_count + RESERVED_TOKENS >= max_context_size:
    await compact_context()
```

## 上下文压缩

**文件路径：** `src/kimi_cli/soul/compaction.py`

Kimi CLI 使用 **LLM-based summarization** 方式进行上下文压缩，比简单截断更智能，能保留关键信息。

### 压缩流程概览

```
原始消息: [M1, M2, M3, M4, M5, M6, M7, M8]
                    ↓ prepare (分割)
           to_compact: [M1-M6]    to_preserve: [M7, M8]
                    ↓ LLM 压缩
           [压缩摘要]             [M7, M8]
                    ↓ 组装
最终结果: [压缩摘要, M7, M8]
```

### Step 1: 分割消息 (`prepare` 方法)

从后往前扫描，保留最近的 N 个 user/assistant 消息（默认 2 个）：

```python
def prepare(self, messages: Sequence[Message]) -> PrepareResult:
    # 从后往前找，保留最后 N 个 user/assistant 消息
    for index in range(len(history) - 1, -1, -1):
        if history[index].role in {"user", "assistant"}:
            n_preserved += 1
            if n_preserved == self.max_preserved_messages:
                preserve_start_index = index
                break

    to_compact = history[:preserve_start_index]   # 需要压缩的旧消息
    to_preserve = history[preserve_start_index:]  # 保留的最近消息
```

### Step 2: 构造压缩输入

将需要压缩的消息格式化，并附加压缩指令：

```python
compact_message = Message(role="user", content=[])
for i, msg in enumerate(to_compact):
    compact_message.content.append(
        TextPart(text=f"## Message {i + 1}\nRole: {msg.role}\nContent:\n")
    )
    compact_message.content.extend(msg.content)
compact_message.content.append(TextPart(text="\n" + prompts.COMPACT))
```

生成的输入格式：

```
## Message 1
Role: user
Content: ...

## Message 2
Role: assistant
Content: ...

---
The above is a list of messages... (压缩指令)
```

### Step 3: 调用 LLM 压缩

```python
result = await kosong.step(
    chat_provider=llm.chat_provider,
    system_prompt="You are a helpful assistant that compacts conversation context.",
    toolset=EmptyToolset(),
    history=[compact_message],
)
```

### Step 4: 组装结果

```python
compacted_messages = [
    Message(role="user", content=[
        system("Previous context has been compacted. Here is the compaction output:"),
        *result.message.content  # LLM 生成的压缩摘要（去掉 ThinkPart）
    ])
]
compacted_messages.extend(to_preserve)  # 加上保留的最近消息
```

### 压缩 Prompt 详解

**文件路径：** `src/kimi_cli/prompts/compact.md`

#### 压缩优先级（按重要性排序）

1. **当前任务状态** - 正在做什么
2. **错误与解决方案** - 所有遇到的错误及其解决方法
3. **代码演变** - 只保留最终工作版本，删除中间尝试
4. **系统上下文** - 项目结构、依赖、环境配置
5. **设计决策** - 架构选择及其理由
6. **TODO 事项** - 未完成任务和已知问题

#### 压缩规则

| 规则 | 说明 |
|------|------|
| **必须保留** | 错误信息、堆栈跟踪、解决方案、当前任务 |
| **合并** | 相似讨论合并为单个摘要点 |
| **删除** | 冗余解释、失败尝试（但保留教训）、冗长注释 |
| **精简** | 长代码块只保留签名 + 关键逻辑 |

#### 特殊处理

- **代码**：< 20 行保留全部，否则只保留签名 + 关键逻辑
- **错误**：保留完整错误信息 + 最终解决方案
- **讨论**：只提取决策和行动项

#### 输出结构

LLM 按以下结构输出压缩结果：

```xml
<current_focus>
当前正在做的事情
</current_focus>

<environment>
- 关键配置点
</environment>

<completed_tasks>
- [任务]: [简要结果]
</completed_tasks>

<active_issues>
- [问题]: [状态/下一步]
</active_issues>

<code_state>
<file>
[文件名]

**Summary:** 这个文件做什么
**Key elements:** 重要函数/类
**Latest version:** 关键代码片段
</file>
</code_state>

<important_context>
- 其他重要信息
</important_context>
```

### SimpleCompaction 类

```python
class SimpleCompaction:
    def __init__(self, max_preserved_messages: int = 2):
        self.max_preserved_messages = max_preserved_messages
```

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `max_preserved_messages` | 2 | 保留最近的 N 个 user/assistant 消息不压缩 |

## Checkpoint 与回溯

### Checkpoint 机制

Checkpoint 是上下文的快照点，记录在 `context.jsonl` 中。

**创建时机：** 每次 LLM 步骤之前

```jsonl
{"role": "_checkpoint", "id": 0}
{"role": "user", "content": [...]}
{"role": "assistant", "content": [...]}
{"role": "_checkpoint", "id": 1}
{"role": "user", "content": [...]}
...
```

### 回溯实现

```python
async def revert_to(self, checkpoint_id: int):
    # 1. 轮转当前文件（保留旧数据）
    rotated_file = await next_available_rotation(self._file_backend)
    await aiofiles.os.replace(self._file_backend, rotated_file)

    # 2. 从旧文件复制到目标 checkpoint
    async for line in old_file:
        if line_json["role"] == "_checkpoint" and line_json["id"] == checkpoint_id:
            break
        await new_file.write(line)
```

### D-Mail 工具

允许 LLM 发送消息回到过去的 checkpoint：

```python
class DMail(BaseModel):
    message: str
    checkpoint_id: int
```

## 用户命令

| 命令 | 功能 |
|------|------|
| `/clear` | 清空整个上下文 |
| `/compact` | 手动压缩上下文 |

## 生命周期流程

### 初始化

```
KimiCLI.create()
  ├─ Session.find() / Session.create()  # 获取或创建 Session
  ├─ Context(session.context_file)      # 用 context_file 创建 Context
  ├─ await context.restore()            # 从 JSONL 恢复状态
  └─ KimiSoul(context=context)          # 创建 Soul
```

### 运行循环

```
KimiSoul.run()
  ├─ await _checkpoint()                 # 创建 checkpoint
  ├─ await _context.append_message()     # 添加用户消息
  └─ while True:
      ├─ 检查是否需要压缩
      ├─ await _checkpoint()
      ├─ LLM 调用
      ├─ await _context.update_token_count()
      ├─ await _context.append_message()
      └─ 检查是否完成或收到 D-Mail
```

## 设计总结

| 层级 | 职责 |
|------|------|
| **Session** | 会话容器，管理生命周期，持有 context_file 路径 |
| **Context** | 文件操作封装，管理消息/checkpoint/token 的读写 |
| **context.jsonl** | 持久化存储，JSONL 格式，包含所有上下文数据 |

这种以 Session 为中心的扁平设计，避免了复杂的数据库依赖，同时通过 JSONL 格式保证了数据的可靠性和可调试性。
