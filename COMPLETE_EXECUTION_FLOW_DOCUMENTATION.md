# Kimi CLI 完整执行流程详解

## 概述

本文档详细描述了 Kimi CLI 从用户输入到完整执行的整个流程，涵盖所有主要路径和关键决策点。执行流程是一个高度协调的系统，涉及多个组件的精密协作。

## 整体架构图

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    用户输入入口                                  │
├─────────────────────────────────────────────────────────────────────────┤
│  CLI 参数解析 → 模式选择 → 实例创建 → 配置加载          │
├─────────────────────────────────────────────────────────────────────────┤
│                      ↓                                        │
│              ┌────────────────┐                               │
│              │  会话管理   │                               │
│              │   Session   │                               │
│              └────────────────┘                               │
│                      ↓                                        │
│              ┌────────────────┐                               │
│              │ KimiCLI实例 │                               │
│              └────────────────┘                               │
│                      ↓                                        │
│              ┌────────────────┐                               │
│              │  UI层适配   │                               │
│              │ (Shell/Print)│                               │
│              └────────────────┘                               │
│                      ↓                                        │
│              ┌────────────────┐                               │
│              │ KimiSoul引擎 │                               │
│              └────────────────┘                               │
│                      ↓                                        │
│              ┌────────────────┐                               │
│              │  Wire通信层  │                               │
│              └────────────────┘                               │
│                      ↓                                        │
│              ┌────────────────┐                               │
│              │  工具执行层  │                               │
│              └────────────────┘                               │
│                      ↓                                        │
│              ┌────────────────┐                               │
│              │  LLM调用层  │                               │
│              └────────────────┘                               │
└─────────────────────────────────────────────────────────────────────────┘
```

## 第一阶段：用户输入处理和初始化

### 1. CLI 入口点 (`cli.py`)

```python
@cli.callback(invoke_without_command=True)
def kimi(
    # ... 参数解析
    local_work_dir: Path | None = None,
    continue_: bool = False,
    session_id: str | None = None,
    command: str | None = None,
    print_mode: bool = False,
    acp_mode: bool = False,
    wire_mode: bool = False,
    # ... 更多参数
) -> None:
```

**流程步骤**：

1. **参数验证和冲突检测**
```python
# 冲突选项检测
conflict_option_sets = [
    {"--print": print_mode, "--acp": acp_mode, "--wire": wire_mode},
    {"--agent": agent is not None, "--agent-file": agent_file is not None},
    {"--continue": continue_, "--session": session_id is not None},
]
```

2. **UI 模式选择**
```python
ui: UIMode = "shell"  # 默认
if print_mode: ui = "print"
elif acp_mode: ui = "acp"
elif wire_mode: ui = "wire"
```

3. **MCP 配置加载**
```python
file_configs = list(mcp_config_file or [])
raw_mcp_config = list(mcp_config or [])

# 使用默认 MCP 配置文件
if not file_configs:
    default_mcp_file = get_global_mcp_config_file()
    if default_mcp_file.exists():
        file_configs.append(default_mcp_file)
```

### 2. KimiCLI 实例创建 (`app.py`)

```python
async def _run(session_id: str | None) -> bool:
    # 会话创建或恢复
    if session_id is not None:
        session = await Session.find(work_dir, session_id)
        if session is None:
            session = await Session.create(work_dir, session_id)
    elif continue_:
        session = await Session.continue_(work_dir)
    else:
        session = await Session.create(work_dir)

    # KimiCLI 实例创建
    instance = await KimiCLI.create(
        session,
        yolo=yolo or (ui == "print"),
        mcp_configs=mcp_configs,
        model_name=model_name,
        thinking=thinking_mode,
        agent_file=agent_file,
    )
```

**KimiCLI 创建过程**：

```python
@staticmethod
async def create(
    session: Session,
    *,
    yolo: bool = False,
    mcp_configs: list[MCPConfig | dict[str, Any]] | None = None,
    config_file: Path | None = None,
    model_name: str | None = None,
    thinking: bool = False,
    agent_file: Path | None = None,
) -> KimiCLI:
    # 1. 配置加载
    config = load_config(config_file)
    
    # 2. LLM 配置
    model: LLMModel | None = None
    provider: LLMProvider | None = None
    
    # 尝试使用配置文件
    if not model_name and config.default_model:
        model = config.models[config.default_model]
        provider = config.providers[model.provider]
    
    # 环境变量覆盖
    if model_name and model_name in config.models:
        model = config.models[model_name]
        provider = config.providers[model.provider]
    
    # 3. LLM 实例创建
    if not model:
        model = LLMModel(provider="", model="", max_context_size=100_000)
        provider = LLMProvider(type="kimi", base_url="", api_key=SecretStr(""))
    
    # 4. 运行时创建
    runtime = await Runtime.create(config, llm, session, yolo)
    
    # 5. 代理加载
    agent_file = agent_file or DEFAULT_AGENT_FILE
    agent = await load_agent(agent_file, runtime, mcp_configs=mcp_configs or [])
    
    # 6. 上下文恢复
    context = Context(session.context_file)
    await context.restore()
    
    # 7. KimiSoul 创建
    soul = KimiSoul(agent, context=context)
    soul.set_thinking(thinking)
    
    return KimiCLI(soul, runtime, env_overrides)
```

## 第二阶段：UI 模式分发

### 1. Shell 模式执行 (`ui/shell/__init__.py`)

```python
async def run_shell(self, command: str | None = None) -> bool:
    # 欢迎信息准备
    welcome_info = [
        WelcomeInfoItem(name="Directory", value=str(shorten_home(work_dir))),
        WelcomeInfoItem(name="Session", value=session.id),
        # API 配置状态显示
        # 模型信息显示
    ]
    
    # Shell 实例创建和运行
    async with self._env():
        shell = Shell(self._soul, welcome_info=welcome_info)
        return await shell.run(command)
```

### 2. Print 模式执行

```python
async def run_print(
    self,
    input_format: InputFormat,
    output_format: OutputFormat,
    command: str | None = None,
) -> bool:
    async with self._env():
        print_ = Print(
            self._soul,
            input_format,
            output_format,
            self._runtime.session.context_file,
        )
        return await print_.run(command)
```

### 3. ACP 模式执行

```python
async def run_acp(self) -> None:
    async with self._env():
        acp = ACP(self._soul)
        await acp.run()
```

## 第三阶段：Shell 模式详细流程

### 1. Shell 初始化和欢迎

```python
class Shell:
    async def run(self, command: str | None = None) -> bool:
        if command is not None:
            # 单命令模式
            return await self._run_soul_command(command)
        
        # 显示欢迎信息
        _print_welcome_info(self.soul.name or "Kimi CLI", self._welcome_info)
        
        # 历史记录重放
        if isinstance(self.soul, KimiSoul):
            await replay_recent_history(
                self.soul.context.history,
                wire_file=self.soul.wire_file,
            )
```

### 2. 交互式主循环

```python
with CustomPromptSession(
    status_provider=lambda: self.soul.status,
    model_capabilities=self.soul.model_capabilities or set(),
    initial_thinking=isinstance(self.soul, KimiSoul) and self.soul.thinking,
    available_slash_commands=list(self._available_slash_commands.values()),
) as prompt_session:
    while True:
        try:
            # 1. 获取用户输入
            ensure_new_line()
            user_input = await prompt_session.prompt()
            
        except KeyboardInterrupt:
            # Ctrl-C 处理
            console.print("Tip: press Ctrl-D or send 'exit' to quit")
            continue
            
        except EOFError:
            # Ctrl-D 处理
            console.print("Bye!")
            break
        
        # 2. 空输入跳过
        if not user_input:
            continue
            
        # 3. 退出命令处理
        if user_input.command in ["exit", "quit", "/exit", "/quit"]:
            console.print("Bye!")
            break
        
        # 4. Shell 模式命令
        if user_input.mode == PromptMode.SHELL:
            await self._run_shell_command(user_input.command)
            continue
        
        # 5. 斜杠命令处理
        if slash_cmd_call := parse_slash_command_call(user_input.command):
            await self._run_slash_command(slash_cmd_call)
            continue
        
        # 6. Soul 命令执行
        await self._run_soul_command(user_input.content, user_input.thinking)
```

## 第四阶段：Soul 引擎执行流程

### 1. Soul 运行入口 (`kimisoul.py`)

```python
async def run(self, user_input: str | list[ContentPart]):
    # 1. 发送轮次开始事件
    wire_send(TurnBegin(user_input=user_input))
    user_message = Message(role="user", content=user_input)
    
    # 2. 斜杠命令解析和执行
    if command_call := parse_slash_command_call(user_message.extract_text(" ").strip()):
        command = soul_slash_registry.find_command(command_call.name)
        if command is None:
            wire_send(TextPart(text=f'Unknown slash command "/{command_call.name}".'))
            return
        
        ret = command.func(self, command_call.args)
        if isinstance(ret, Awaitable):
            await ret
        return
    
    # 3. LLM 检查
    if self._runtime.llm is None:
        raise LLMNotSet()
    
    # 4. 消息能力验证
    if missing_caps := check_message(user_message, self._runtime.llm.capabilities):
        raise LLMNotSupported(self._runtime.llm, list(missing_caps))
    
    # 5. 上下文检查点创建
    await self._checkpoint()
    await self._context.append_message(user_message)
    
    # 6. 启动代理循环
    await self._agent_loop()
```

### 2. 代理主循环 (`_agent_loop`)

```python
async def _agent_loop(self):
    step_no = 0
    while True:
        step_no += 1
        
        # 1. 步数限制检查
        if step_no > self._loop_control.max_steps_per_run:
            raise MaxStepsReached(self._loop_control.max_steps_per_run)
        
        # 2. 发送步骤开始事件
        wire_send(StepBegin(n=step_no))
        
        # 3. 启动权限管道任务
        approval_task = asyncio.create_task(_pipe_approval_to_wire())
        
        try:
            # 4. 上下文压缩检查
            if (self._context.token_count + self._reserved_tokens >= 
                self._runtime.llm.max_context_size):
                logger.info("Context too long, compacting...")
                await self.compact_context()
            
            # 5. 执行单步
            await self._checkpoint()
            self._denwa_renji.set_n_checkpoints(self._context.n_checkpoints)
            finished = await self._step()
            
        except BackToTheFuture as e:
            # 6. D-Mail 时间旅行处理
            await self._context.revert_to(e.checkpoint_id)
            await self._checkpoint()
            await self._context.append_message(e.messages)
            finished = False
            
        except Exception:
            # 7. 异常处理
            wire_send(StepInterrupted())
            raise
            
        finally:
            # 8. 清理权限任务
            approval_task.cancel()
            with suppress(asyncio.CancelledError):
                try:
                    await approval_task
                except Exception:
                    logger.exception("Approval piping task failed")
        
        # 9. 检查是否完成
        if finished:
            return
```

### 3. 单步执行 (`_step`)

```python
async def _step(self) -> bool:
    chat_provider = self._runtime.llm.chat_provider
    
    # 1. 带重试的 LLM 调用
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
    
    # 2. 状态更新
    status_update = StatusUpdate(token_usage=result.usage, message_id=result.id)
    if result.usage is not None:
        await self._context.update_token_count(result.usage.input)
        status_update.context_usage = self.status.context_usage
    wire_send(status_update)
    
    # 3. 等待工具结果
    results = await result.tool_results()
    
    # 4. 上下文增长（屏蔽中断）
    await asyncio.shield(self._grow_context(result, results))
    
    # 5. 工具拒绝检查
    rejected = any(isinstance(result.return_value, ToolRejectedError) for result in results)
    if rejected:
        _ = self._denwa_renji.fetch_pending_dmail()
        return True
    
    # 6. D-Mail 处理
    if dmail := self._denwa_renji.fetch_pending_dmail():
        raise BackToTheFuture(
            dmail.checkpoint_id,
            [Message(role="user", content=[system(f"D-Mail content:\n\n{dmail.message.strip()}")])],
        )
    
    # 7. 返回是否继续
    return not result.tool_calls
```

## 第五阶段：Wire 通信和可视化

### 1. Wire 消息流 (`wire/__init__.py`)

```python
class Wire:
    """A spmc channel for communication between soul and UI during a soul run."""
    
    def __init__(self, *, file_backend: Path | None = None):
        self._raw_queue = WireMessageQueue()      # 原始消息队列
        self._merged_queue = WireMessageQueue()    # 合并消息队列
        
        # Soul 侧通信
        self._soul_side = WireSoulSide(self._raw_queue, self._merged_queue)
        
        # 可选的文件记录器
        if file_backend is not None:
            self._recorder = _WireRecorder(file_backend, self._merged_queue.subscribe())
        else:
            self._recorder = None
```

### 2. 消息发送机制

```python
def wire_send(msg: WireMessage) -> None:
    """Send a wire message to current wire."""
    wire = get_wire_or_none()
    assert wire is not None, "Wire is expected to be set when soul is running"
    wire.soul_side.send(msg)
```

### 3. 可视化循环 (`ui/shell/visualize.py`)

```python
async def visualize(
    wire: WireUISide,
    *,
    initial_status: StatusUpdate,
    cancel_event: asyncio.Event | None = None,
):
    view = _LiveView(initial_status, cancel_event)
    await view.visualize_loop(wire)

class _LiveView:
    def __init__(self, initial_status: StatusUpdate, cancel_event):
        self.content_blocks = {
            "thinking": _ContentBlock(is_think=True),
            "assistant": _ContentBlock(is_think=False),
        }
        self.current_step: StepInfo | None = None
        self.approval_requests: dict[str, ApprovalRequestInfo] = {}
        
    async def visualize_loop(self, wire: WireUISide):
        async for msg in wire.subscribe():
            await self._handle_message(msg)
```

### 4. 消息类型处理

```python
async def _handle_message(self, msg: WireMessage):
    match msg:
        case TurnBegin():
            # 新轮次开始
            self._reset_content()
            
        case StepBegin():
            # 步骤开始
            self.current_step = StepInfo(n=msg.n)
            self._show_step_start()
            
        case ThinkPart(think=think):
            # 思考内容
            self.content_blocks["thinking"].append(think)
            self._update_live()
            
        case TextPart(text=text):
            # 助手回复
            self.content_blocks["assistant"].append(text)
            self._update_live()
            
        case ToolCall():
            # 工具调用开始
            await self._handle_tool_call_start(msg)
            
        case ToolCallPart():
            # 工具调用流式更新
            await self._handle_tool_call_part(msg)
            
        case ToolResult():
            # 工具调用结果
            await self._handle_tool_result(msg)
            
        case ApprovalRequest():
            # 权限请求
            self.approval_requests[msg.id] = ApprovalRequestInfo(
                request=msg,
                future=asyncio.Future(),
            )
            await self._show_approval_request(msg)
            
        case ApprovalRequestResolved():
            # 权限请求解决
            info = self.approval_requests.pop(msg.request_id, None)
            if info:
                info.future.set_result(msg.response)
            
        case StatusUpdate():
            # 状态更新
            if msg.context_usage is not None:
                self.progress = f"{msg.context_usage:.1%}"
            self._update_live()
```

## 第六阶段：工具调用和执行

### 1. 工具调用开始处理

```python
async def _handle_tool_call_start(self, tool_call: ToolCall):
    # 提取关键参数用于显示
    subtitle = extract_key_argument(tool_call.function.arguments or "", tool_call.function.name)
    title = f"{tool_call.function.name}: {subtitle}" if subtitle else tool_call.function.name
    
    # 创建工具调用信息
    self.current_tool_calls[tool_call.id] = ToolCallInfo(
        tool_call=tool_call,
        title=title,
        parts=[],
        status="in_progress",
    )
    
    self._update_live()
```

### 2. 工具调用流式更新

```python
async def _handle_tool_call_part(self, part: ToolCallPart):
    if not self.current_tool_calls:
        return
        
    tool_call_id = part.tool_call_id
    if tool_call_id not in self.current_tool_calls:
        return
        
    info = self.current_tool_calls[tool_call_id]
    info.parts.append(part.arguments_part)
    
    # 更新标题（如果有新的关键参数）
    lexer = streamingjson.Lexer()
    lexer.append_string(info.tool_call.function.arguments or "")
    lexer.append_string(part.arguments_part)
    
    subtitle = extract_key_argument(lexer.complete_json(), info.tool_call.function.name)
    info.title = f"{info.tool_call.function.name}: {subtitle}" if subtitle else info.tool_call.function.name
    
    self._update_live()
```

### 3. 工具结果处理

```python
async def _handle_tool_result(self, result: ToolResult):
    tool_call_id = result.tool_call_id
    if tool_call_id not in self.current_tool_calls:
        return
        
    info = self.current_tool_calls.pop(tool_call_id)
    
    # 判断成功或失败
    if isinstance(result.return_value, ToolError):
        info.status = "failed"
        info.error = result.return_value.message
    else:
        info.status = "completed"
        
    # 处理输出内容
    if result.return_value.output:
        info.output = result.return_value.output
        
    self._update_live()
    
    # 如果工具调用过多，移除最早的
    if len(self.current_tool_calls) > MAX_SUBAGENT_TOOL_CALLS_TO_SHOW:
        oldest_id = min(self.current_tool_calls.keys())
        del self.current_tool_calls[oldest_id]
```

## 第七阶段：权限管理和用户交互

### 1. 权限请求流程 (`soul/approval.py`)

```python
class Approval:
    def __init__(self, yolo: bool = False):
        self._request_queue = asyncio.Queue[Request]()
        self._requests: dict[str, tuple[Request, asyncio.Future[bool]]] = {}
        self._yolo = yolo
        self._auto_approve_actions: set[str] = set()
    
    async def request(self, sender: str, action: str, description: str) -> bool:
        tool_call = get_current_tool_call_or_none()
        if tool_call is None:
            raise RuntimeError("Approval must be requested from a tool call.")
        
        # YOLO 模式直接批准
        if self._yolo or action in self._auto_approve_actions:
            return True
        
        # 创建请求
        request = Request(
            id=str(uuid.uuid4()),
            tool_call_id=tool_call.id,
            sender=sender,
            action=action,
            description=description,
        )
        
        # 等待响应
        future = asyncio.Future[bool]()
        self._requests[request.id] = (request, future)
        
        # 通过 Wire 发送请求
        self._request_queue.put_nowait(request)
        
        return await future
```

### 2. 权限管道处理 (`kimisoul.py`)

```python
async def _pipe_approval_to_wire():
    while True:
        # 从工具获取请求
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

### 3. 权限响应处理 (`visualize.py`)

```python
async def _show_approval_request(self, request: ApprovalRequest):
    # 创建权限选项
    options = [
        ("1", "Approve once", "allow_once"),
        ("2", "Approve for this session", "allow_always"),
        ("3", "Reject", "reject_once"),
    ]
    
    # 显示请求详情
    console.print(Panel(
        f"[bold]{request.action}[/bold]\n{request.description}",
        title="🔐 Permission Required",
        border_style="yellow",
    ))
    
    # 等待用户选择
    choice = await self._get_user_choice(options)
    
    # 解析响应
    choice_map = {"1": "approve", "2": "approve_for_session", "3": "reject"}
    response = choice_map.get(choice, "reject")
    
    # 设置 Future 结果
    info = self.approval_requests[request.id]
    info.future.set_result(response)
```

## 第八阶段：上下文管理和持久化

### 1. 上下文检查点 (`soul/context.py`)

```python
async def checkpoint(self, add_user_message: bool):
    checkpoint_id = self._next_checkpoint_id
    self._next_checkpoint_id += 1
    
    # 写入检查点标记
    async with aiofiles.open(self._file_backend, "a", encoding="utf-8") as f:
        await f.write(json.dumps({"role": "_checkpoint", "id": checkpoint_id}) + "\n")
    
    # 可选添加用户消息
    if add_user_message:
        await self.append_message(
            Message(role="user", content=[system(f"CHECKPOINT {checkpoint_id}")])
        )
```

### 2. 上下文恢复

```python
async def restore(self) -> bool:
    if self._history:
        raise RuntimeError("The context storage is already modified")
    if not self._file_backend.exists():
        return False  # 没有历史文件
        
    async with aiofiles.open(self._file_backend, encoding="utf-8") as f:
        async for line in f:
            if not line.strip():
                continue
            line_json = json.loads(line)
            
            if line_json["role"] == "_usage":
                self._token_count = line_json["token_count"]
            elif line_json["role"] == "_checkpoint":
                self._next_checkpoint_id = line_json["id"] + 1
            else:
                message = Message.model_validate(line_json)
                self._history.append(message)
    
    return True
```

### 3. 上下文压缩 (`soul/compaction.py`)

```python
class SimpleCompaction:
    def __init__(self, max_preserved_messages: int = 2) -> None:
        self.max_preserved_messages = max_preserved_messages
    
    async def compact(self, messages: Sequence[Message], llm: LLM) -> Sequence[Message]:
        compact_message, to_preserve = self.prepare(messages)
        if compact_message is None:
            return to_preserve
        
        # 调用 LLM 进行压缩
        logger.debug("Compacting context...")
        result = await kosong.step(
            chat_provider=llm.chat_provider,
            system_prompt="You are a helpful assistant that compacts conversation context.",
            toolset=EmptyToolset(),
            history=[compact_message],
        )
        
        # 返回压缩后的历史
        return to_preserve + [result.message]
```

## 第九阶段：D-Mail 时间旅行系统

### 1. D-Mail 发送 (`soul/denwarenji.py`)

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

### 2. D-Mail 接收和处理

```python
# 在 _step 方法中的 D-Mail 处理
if dmail := self._denwa_renji.fetch_pending_dmail():
    assert dmail.checkpoint_id >= 0, "DenwaRenji guarantees checkpoint_id >= 0"
    assert dmail.checkpoint_id < self._context.n_checkpoints, "DenwaRenji guarantees checkpoint_id < n_checkpoints"
    
    # 抛出时间旅行异常
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

### 3. 时间旅行异常处理

```python
class BackToTheFuture(Exception):
    """Raise when we need to revert the context to a previous checkpoint."""
    
    def __init__(self, checkpoint_id: int, messages: Sequence[Message]):
        self.checkpoint_id = checkpoint_id
        self.messages = messages

# 在代理循环中的处理
except BackToTheFuture as e:
    await self._context.revert_to(e.checkpoint_id)
    await self._checkpoint()
    await self._context.append_message(e.messages)
    finished = False
```

## 第十阶段：错误处理和恢复

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
async def _kosong_step_with_retry() -> StepResult:
    return await kosong.step(...)
```

### 3. 异常类型和处理

```python
# 在 _run_soul_command 中的异常处理
try:
    await run_soul(self.soul, user_input, ui_loop_fn, cancel_event, wire_file)
except LLMNotSet:
    console.print('[red]LLM not set, send "/setup" to configure[/red]')
except LLMNotSupported as e:
    console.print(f"[red]{e}[/red]")
except ChatProviderError as e:
    if isinstance(e, APIStatusError):
        if e.status_code == 401:
            console.print("[red]Authorization failed, please check your API key[/red]")
        elif e.status_code == 402:
            console.print("[red]Membership expired, please renew your plan[/red]")
        elif e.status_code == 403:
            console.print("[red]Quota exceeded, please upgrade your plan or retry later[/red]")
    else:
        console.print(f"[red]LLM provider error: {e}[/red]")
except MaxStepsReached as e:
    console.print(f"[yellow]{e}[/yellow]")
except RunCancelled:
    console.print("[red]Interrupted by user[/red]")
```

## 第十一阶段：状态更新和元数据管理

### 1. 会话状态跟踪

```python
# 在成功运行后的状态更新
if succeeded:
    metadata = load_metadata()
    
    # 更新工作目录元数据
    work_dir_meta = metadata.get_work_dir_meta(session.work_dir)
    if work_dir_meta is None:
        work_dir_meta = metadata.new_work_dir_meta(session.work_dir)
    
    if session.is_empty():
        # 删除空会话
        await session.delete()
        if work_dir_meta.last_session_id == session.id:
            work_dir_meta.last_session_id = None
    else:
        # 更新最后会话 ID
        work_dir_meta.last_session_id = session.id
    
    # 更新思考模式设置
    metadata.thinking = instance.soul.thinking
    
    # 保存元数据
    save_metadata(metadata)
```

### 2. Token 使用统计

```python
@property
def _context_usage(self) -> float:
    if self._runtime.llm is not None:
        return self._context.token_count / self._runtime.llm.max_context_size
    return 0.0

# 在状态更新中发送
status_update = StatusUpdate(
    token_usage=result.usage,
    message_id=result.id,
    context_usage=self._context_usage,
)
wire_send(status_update)
```

### 3. 实时状态监控

```python
class StatusSnapshot:
    context_usage: float
    """The usage of context, in percentage."""

@property
def status(self) -> StatusSnapshot:
    return StatusSnapshot(context_usage=self._context_usage)
```

## 执行流程总结

### 完整流程图

```
用户输入
    ↓
[CLI 参数解析]
    ↓
[配置加载和验证]
    ↓
[会话管理]
    ↓
[UI 模式选择]
    ↓
[Shell/Print/ACP 模式]
    ↓
[用户输入循环]
    ↓
[斜杠命令检查] ──→─ [斜杠命令执行]
    ↓
[Soul 引擎调用]
    ↓
[消息验证]
    ↓
[上下文检查点]
    ↓
[代理循环开始]
    ↓
[步骤执行循环]
    ├── [上下文压缩检查]
    ├── [LLM 调用]
    ├── [工具调用]
    ├── [权限请求]
    ├── [D-Mail 处理]
    └── [状态更新]
    ↓
[结果返回给用户]
    ↓
[状态持久化]
```

### 关键设计决策

1. **异步优先**: 所有关键操作都是异步的
2. **事件驱动**: 基于 Wire 消息的事件系统
3. **状态隔离**: 每个组件维护自己的状态
4. **错误恢复**: 多层次的错误处理和重试机制
5. **资源管理**: 自动的上下文压缩和清理
6. **用户控制**: 灵活的权限管理和中断机制

### 性能优化点

1. **流式处理**: 实时显示工具调用进度
2. **智能压缩**: 基于使用量的上下文压缩
3. **缓存机制**: 会话状态和配置缓存
4. **并发控制**: 工具调用的并发执行
5. **资源限制**: 最大步数和重试次数限制

---

**文档维护**: Kimi CLI 开发团队  
**最后更新**: 2025-12-20  
**版本**: v0.66

这份文档详细描述了 Kimi CLI 的完整执行流程，从用户输入到最终结果返回的每一个环节。这个高度协调的系统确保了可靠性、性能和用户体验的平衡。