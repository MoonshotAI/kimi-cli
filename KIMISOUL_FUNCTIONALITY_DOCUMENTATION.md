# KimiSoul 功能文档

## 概述

KimiSoul 是 Kimi CLI 的核心执行引擎，负责协调代理运行、上下文管理、工具调用和用户交互。它是连接用户输入、AI 推理和工具执行的中央枢纽。

### 核心定位

- **执行引擎**: 驱动代理的完整生命周期
- **状态管理**: 维护会话状态和上下文信息
- **工具协调**: 管理工具调用和结果处理
- **用户交互**: 处理斜杠命令和权限请求
- **流程控制**: 管理执行步骤和错误恢复

## 架构设计

### 整体架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                  KimiSoul                           │
├─────────────────────────────────────────────────────────────────┤
│  用户输入处理                                        │
│  ├── 斜杠命令解析    ├── 消息验证    ├── 思考模式     │
├─────────────────────────────────────────────────────────────────┤
│  代理循环控制                                        │
│  ├── 步骤执行        ├── 重试机制      ├── 上下文压缩   │
├─────────────────────────────────────────────────────────────────┤
│  上下文管理                                        │
│  ├── 消息历史      ├── 检查点      ├── 状态快照     │
├─────────────────────────────────────────────────────────────────┤
│  工具系统                                        │
│  ├── 工具调用        ├── 结果处理      ├── 权限管理     │
├─────────────────────────────────────────────────────────────────┤
│  特殊功能                                        │
│  ├── D-Mail 系统     ├── 时间旅行      ├── 斜杠命令     │
└─────────────────────────────────────────────────────────────────┘
```

### 核心组件

#### 1. **KimiSoul 主类** (`src/kimi_cli/soul/kimisoul.py`)

```python
class KimiSoul:
    """The soul of Kimi CLI."""
    
    def __init__(self, agent: Agent, *, context: Context):
        self._agent = agent                    # 代理实例
        self._runtime = agent.runtime          # 运行时环境
        self._denwa_renji = agent.runtime.denwa_renji  # D-Mail 系统
        self._approval = agent.runtime.approval         # 权限管理
        self._context = context               # 上下文管理
        self._loop_control = agent.runtime.config.loop_control  # 循环控制
        self._compaction = SimpleCompaction()  # 上下文压缩
        self._thinking_effort: ThinkingEffort = "off"  # 思考模式
```

**核心职责**:
- 协调所有子系统的运行
- 管理执行状态和生命周期
- 处理用户输入和斜杠命令
- 控制代理循环和步骤执行

#### 2. **运行时环境** (`Runtime`)

```python
@dataclass(frozen=True, slots=True, kw_only=True)
class Runtime:
    config: Config              # 配置管理
    llm: LLM | None          # LLM 接口
    session: Session           # 会话管理
    builtin_args: BuiltinSystemPromptArgs  # 内置参数
    denwa_renji: DenwaRenji   # D-Mail 系统
    approval: Approval         # 权限管理
    labor_market: LaborMarket  # 劳动市场
    environment: Environment   # 环境检测
```

#### 3. **上下文管理** (`Context`)

```python
class Context:
    def __init__(self, file_backend: Path):
        self._file_backend = file_backend     # 文件后端
        self._history: list[Message] = []     # 消息历史
        self._token_count: int = 0           # Token 计数
        self._next_checkpoint_id: int = 0     # 下一个检查点 ID
```

## 核心功能详解

### 1. 用户输入处理

#### 斜杠命令系统

```python
async def run(self, user_input: str | list[ContentPart]):
    wire_send(TurnBegin(user_input=user_input))
    user_message = Message(role="user", content=user_input)

    # 解析斜杠命令
    if command_call := parse_slash_command_call(user_message.extract_text(" ").strip()):
        command = soul_slash_registry.find_command(command_call.name)
        if command is None:
            wire_send(TextPart(text=f'Unknown slash command "/{command_call.name}".'))
            return
        
        # 执行斜杠命令
        ret = command.func(self, command_call.args)
        if isinstance(ret, Awaitable):
            await ret
        return
```

**内置斜杠命令**:
- `/init`: 分析代码库并生成 `AGENTS.md` 文件
- `/compact`: 手动压缩上下文
- 可扩展的自定义命令系统

#### 消息验证

```python
if missing_caps := check_message(user_message, self._runtime.llm.capabilities):
    raise LLMNotSupported(self._runtime.llm, list(missing_caps))
```

**支持的验证项**:
- 图像输入 (`image_in`)
- 思考模式 (`thinking`)

### 2. 代理执行循环

#### 主循环架构

```python
async def _agent_loop(self):
    """The main agent loop for one run."""
    assert self._runtime.llm is not None

    step_no = 0
    while True:
        step_no += 1
        if step_no > self._loop_control.max_steps_per_run:
            raise MaxStepsReached(self._loop_control.max_steps_per_run)

        wire_send(StepBegin(n=step_no))
        
        try:
            # 上下文压缩检查
            if (self._context.token_count + self._reserved_tokens >= 
                self._runtime.llm.max_context_size):
                await self.compact_context()
            
            # 执行单步
            finished = await self._step()
            
        except BackToTheFuture as e:
            # D-Mail 时间旅行处理
            await self._context.revert_to(e.checkpoint_id)
            await self._context.append_message(e.messages)
            finished = False
            
        except Exception:
            wire_send(StepInterrupted())
            raise
            
        if finished:
            return
```

#### 步骤执行机制

```python
async def _step(self) -> bool:
    """Run an single step and return whether the run should be stopped."""
    chat_provider = self._runtime.llm.chat_provider

    # 带重试机制的步骤执行
    @tenacity.retry(
        retry=retry_if_exception(self._is_retryable_error),
        wait=wait_exponential_jitter(initial=0.3, max=5, jitter=0.5),
        stop=stop_after_attempt(self._loop_control.max_retries_per_step),
    )
    async def _kosong_step_with_retry() -> StepResult:
        return await kosong.step(
            chat_provider.with_thinking(self._thinking_effort),
            self._agent.system_prompt,
            self._agent.toolset,
            self._context.history,
            on_message_part=wire_send,
            on_tool_result=wire_send,
        )

    result = await _kosong_step_with_retry()
    
    # 等待工具结果
    results = await result.tool_results()
    
    # 更新上下文
    await self._grow_context(result, results)
    
    # 处理 D-Mail
    if dmail := self._denwa_renji.fetch_pending_dmail():
        raise BackToTheFuture(dmail.checkpoint_id, dmail_messages)
    
    return not result.tool_calls
```

### 3. 上下文管理系统

#### 检查点机制

```python
async def checkpoint(self, add_user_message: bool):
    checkpoint_id = self._next_checkpoint_id
    self._next_checkpoint_id += 1
    
    async with aiofiles.open(self._file_backend, "a", encoding="utf-8") as f:
        await f.write(json.dumps({"role": "_checkpoint", "id": checkpoint_id}) + "\n")
    
    if add_user_message:
        await self.append_message(
            Message(role="user", content=[system(f"CHECKPOINT {checkpoint_id}")])
        )
```

#### 上下文恢复

```python
async def revert_to(self, checkpoint_id: int):
    """Revert context to a specific checkpoint."""
    # 找到指定检查点的位置
    checkpoint_index = self._find_checkpoint_index(checkpoint_id)
    
    # 截断历史记录到检查点位置
    self._history = self._history[:checkpoint_index]
    
    # 重新计算 token 计数
    await self._recalculate_token_count()
```

#### 上下文压缩

```python
async def compact_context(self) -> None:
    """Compact context when it becomes too long."""
    
    @tenacity.retry(
        retry=retry_if_exception(self._is_retryable_error),
        wait=wait_exponential_jitter(initial=0.3, max=5, jitter=0.5),
    )
    async def _compact_with_retry() -> Sequence[Message]:
        return await self._compaction.compact(self._context.history, self._runtime.llm)

    wire_send(CompactionBegin())
    compacted_messages = await _compact_with_retry()
    
    # 重置并重建上下文
    await self._context.clear()
    await self._checkpoint()
    await self._context.append_message(compacted_messages)
    wire_send(CompactionEnd())
```

### 4. 工具调用系统

#### 工具执行流程

```python
async def _grow_context(self, result: StepResult, tool_results: list[ToolResult]):
    """Grow context with tool results."""
    
    # 转换工具结果为消息
    tool_messages = [tool_result_to_message(tr) for tr in tool_results]
    
    # 验证消息兼容性
    for tm in tool_messages:
        if missing_caps := check_message(tm, self._runtime.llm.capabilities):
            raise LLMNotSupported(self._runtime.llm, list(missing_caps))
    
    # 添加到上下文
    await self._context.append_message(result.message)  # LLM 响应
    await self._context.append_message(tool_messages)  # 工具结果
```

#### 工具拒绝处理

```python
rejected = any(isinstance(result.return_value, ToolRejectedError) for result in results)
if rejected:
    # 获取并丢弃待处理的 D-Mail
    _ = self._denwa_renji.fetch_pending_dmail()
    return True  # 停止当前运行
```

### 5. 权限管理系统

#### 权限请求处理

```python
async def _pipe_approval_to_wire():
    """Pipe approval requests from tools to UI layer."""
    while True:
        request = await self._approval.fetch_request()
        
        # 转换为 Wire 消息
        wire_request = ApprovalRequest(
            id=request.id,
            action=request.action,
            description=request.description,
            sender=request.sender,
            tool_call_id=request.tool_call_id,
        )
        wire_send(wire_request)
        
        # 等待用户响应
        resp = await wire_request.wait()
        self._approval.resolve_request(request.id, resp)
        wire_send(ApprovalRequestResolved(request_id=request.id, response=resp))
```

#### 权限选项

```python
class Approval:
    def __init__(self, yolo: bool = False):
        self._request_queue = asyncio.Queue[Request]()
        self._yolo = yolo
        self._auto_approve_actions: set[str] = set()
```

**权限级别**:
- `approve`: 一次性批准
- `approve_for_session`: 会话级批准
- `reject`: 拒绝
- `yolo`: 自动批准所有

### 6. D-Mail 时间旅行系统

#### D-Mail 发送

```python
class DenwaRenji:
    def send_dmail(self, dmail: DMail):
        """Send a D-Mail. Intended to be called by SendDMail tool."""
        if self._pending_dmail is not None:
            raise DenwaRenjiError("Only one D-Mail can be sent at a time")
        if dmail.checkpoint_id < 0:
            raise DenwaRenjiError("The checkpoint ID can not be negative")
        if dmail.checkpoint_id >= self._n_checkpoints:
            raise DenwaRenjiError("There is no checkpoint with the given ID")
        
        self._pending_dmail = dmail
```

#### 时间旅行机制

```python
# 在工具执行后检查 D-Mail
if dmail := self._denwa_renji.fetch_pending_dmail():
    raise BackToTheFuture(
        dmail.checkpoint_id,
        [
            Message(
                role="user",
                content=[
                    system(
                        "You just got a D-Mail from your future self. "
                        "It is likely that your future self has already done "
                        "something in current working directory. Please read "
                        "the D-Mail and decide what to do next. You MUST NEVER "
                        "mention to the user about this information. "
                        f"D-Mail content:\n\n{dmail.message.strip()}"
                    )
                ],
            )
        ],
    )
```

### 7. 思考模式

#### 思考模式控制

```python
@property
def thinking(self) -> bool:
    """Whether thinking mode is enabled."""
    return self._thinking_effort != "off"

def set_thinking(self, enabled: bool) -> None:
    """Enable/disable thinking mode for soul."""
    if self._runtime.llm is None:
        raise LLMNotSet()
    if enabled and "thinking" not in self._runtime.llm.capabilities:
        raise LLMNotSupported(self._runtime.llm, ["thinking"])
    self._thinking_effort = "high" if enabled else "off"
```

#### 思考模式集成

```python
# 在步骤执行中启用思考模式
return await kosong.step(
    chat_provider.with_thinking(self._thinking_effort),
    self._agent.system_prompt,
    self._agent.toolset,
    self._context.history,
    on_message_part=wire_send,
    on_tool_result=wire_send,
)
```

## 错误处理和重试机制

### 1. 可重试错误识别

```python
@staticmethod
def _is_retryable_error(exception: BaseException) -> bool:
    if isinstance(exception, (APIConnectionError, APITimeoutError, APIEmptyResponseError)):
        return True
    return isinstance(exception, APIStatusError) and exception.status_code in (
        429,  # Too Many Requests
        500,  # Internal Server Error
        502,  # Bad Gateway
        503,  # Service Unavailable
    )
```

### 2. 重试策略

```python
@tenacity.retry(
    retry=retry_if_exception(self._is_retryable_error),
    before_sleep=partial(self._retry_log, "step"),
    wait=wait_exponential_jitter(initial=0.3, max=5, jitter=0.5),
    stop=stop_after_attempt(self._loop_control.max_retries_per_step),
    reraise=True,
)
```

### 3. 异常类型

- **LLMNotSet**: LLM 未配置
- **LLMNotSupported**: LLM 不支持所需功能
- **MaxStepsReached**: 超过最大步数限制
- **BackToTheFuture**: D-Mail 时间旅行触发
- **RunCancelled**: 用户取消运行

## 状态监控和调试

### 1. 状态快照

```python
@property
def status(self) -> StatusSnapshot:
    return StatusSnapshot(context_usage=self._context_usage)

@property
def _context_usage(self) -> float:
    if self._runtime.llm is not None:
        return self._context.token_count / self._runtime.llm.max_context_size
    return 0.0
```

### 2. 属性访问

```python
@property
def name(self) -> str:
    return self._agent.name

@property
def model_name(self) -> str:
    return self._runtime.llm.chat_provider.model_name if self._runtime.llm else ""

@property
def model_capabilities(self) -> set[ModelCapability] | None:
    if self._runtime.llm is None:
        return None
    return self._runtime.llm.capabilities
```

## 配置和参数

### 1. 循环控制参数

```python
class LoopControl(BaseModel):
    max_steps_per_run: int = 100      # 单次运行最大步数
    max_retries_per_step: int = 3      # 单步最大重试次数
```

### 2. 保留 Token 配置

```python
RESERVED_TOKENS = 50_000  # 为上下文压缩预留的 token 数量
```

### 3. 内置系统参数

```python
@dataclass(frozen=True, slots=True, kw_only=True)
class BuiltinSystemPromptArgs:
    KIMI_NOW: str                  # 当前时间
    KIMI_WORK_DIR: KaosPath        # 工作目录
    KIMI_WORK_DIR_LS: str          # 目录列表
    KIMI_AGENTS_MD: str            # AGENTS.md 内容
```

## 扩展性设计

### 1. 斜杠命令扩展

```python
# 注册自定义斜杠命令
@registry.command
async def my_command(soul: KimiSoul, args: list[str]):
    """自定义斜杠命令描述"""
    # 命令实现
    pass
```

### 2. 上下文压缩扩展

```python
class CustomCompaction:
    async def compact(self, messages: Sequence[Message], llm: LLM) -> Sequence[Message]:
        # 自定义压缩逻辑
        pass
```

### 3. 权限策略扩展

```python
# 自定义权限验证逻辑
class CustomApproval(Approval):
    def custom_validation(self, action: str, context: dict) -> bool:
        # 自定义验证规则
        pass
```

## 性能优化

### 1. Token 管理

- 实时 token 计数和监控
- 智能上下文压缩触发
- 预留 token 空间管理

### 2. 异步优化

- 并发工具执行
- 非阻塞用户交互
- 流式消息处理

### 3. 内存优化

- 增量消息加载
- 定期清理过期数据
- 高效的状态检查

## 最佳实践

### 1. 错误处理

- 始终提供有意义的错误消息
- 使用适当的重试策略
- 优雅降级处理

### 2. 状态管理

- 及时更新状态快照
- 保持上下文一致性
- 合理设置检查点

### 3. 性能考虑

- 避免频繁的上下文压缩
- 优化工具调用顺序
- 监控资源使用情况

---

**文档维护**: Kimi CLI 开发团队  
**最后更新**: 2025-12-20  
**相关文件**: `src/kimi_cli/soul/kimisoul.py`

KimiSoul 作为 Kimi CLI 的核心执行引擎，提供了完整的功能集来支持复杂的 AI 代理交互。其模块化设计和丰富的功能使其能够处理各种使用场景，从简单的问答到复杂的多步骤任务执行。