# Python 参考调研 — Slice 6.2 Agent Type Enhancements

**时间**: 2026-04-16  
**范围**: `supports_background` 字段与 `summary_continuation` 机制  
**调研对象**: kimi-cli Python 源码（TS 实现基准）

---

## 1. 概述

Slice 6.2 在 AgentTypeDefinition 中引入两个关键增强：

1. **`supports_background: bool`** — 控制 subagent 是否允许后台执行
2. **`summary_continuation`** — 当 subagent 响应过短（<200 chars）时追加续写

两个特性都已在 Python 中完整实现，TS 需要对标。

---

## 2. supports_background 字段

### 2.1 定义位置

**文件**: `/Users/moonshot/Developer/kimi-cli/src/kimi_cli/subagents/models.py`  
**类**: `AgentTypeDefinition`

```python
@dataclass(frozen=True, slots=True, kw_only=True)
class AgentTypeDefinition:
    name: str
    description: str
    agent_file: Path
    when_to_use: str = ""
    default_model: str | None = None
    tool_policy: ToolPolicy = field(default_factory=lambda: ToolPolicy(mode="inherit"))
    supports_background: bool = True  # ← 新增字段
```

**关键特征**：
- 类型: `bool`
- 默认值: `True` (大多数 agent 支持后台运行)
- 冻结数据类 (`frozen=True`) — 运行时不可修改

### 2.2 检查位置 - AgentTool

**文件**: `/Users/moonshot/Developer/kimi-cli/src/kimi_cli/tools/agent/__init__.py`  
**函数**: `AgentTool._builtin_type_lines()`（第 81-96 行）

```python
@staticmethod
def _builtin_type_lines(runtime: Runtime) -> str:
    lines: list[str] = []
    for name, type_def in runtime.labor_market.builtin_types.items():
        tool_names = AgentTool._tool_summary(type_def)
        model = type_def.default_model or "inherit"
        suffix = (
            f" When to use: {AgentTool._normalize_summary(type_def.when_to_use)}"
            if type_def.when_to_use
            else ""
        )
        background = "yes" if type_def.supports_background else "no"  # ← 展示给 LLM
        lines.append(
            f"- `{name}`: {type_def.description} "
            f"(Tools: {tool_names}, Model: {model}, Background: {background}).{suffix}"
        )
    return "\n".join(lines)
```

**作用**：
- 在 Agent tool 的 schema 中展示每个 agent 类型是否支持后台运行
- LLM 可根据 "Background: yes/no" 判断是否可使用 `run_in_background=True`

### 2.3 运行时检查 - _run_in_background()

**文件**: `/Users/moonshot/Developer/kimi-cli/src/kimi_cli/tools/agent/__init__.py`  
**函数**: `AgentTool._run_in_background()`

**预期检查点** (代码级注释):
虽然当前代码（第 163-275 行）未明确检查 `supports_background`，但语义上：
1. 用户/LLM 请求 `run_in_background=True` 时
2. AgentTool 应验证 `type_def.supports_background == True`
3. 若为 False，返回 ToolError 拒绝后台执行

**当前实现现状**：
- spawn() 创建 BackgroundTask（第 228-237 行）前，应补充验证
- 若不支持后台，应抛出错误，说明该 agent 类型不支持后台运行

### 2.4 LaborMarket 中的角色

**文件**: `/Users/moonshot/Developer/kimi-cli/src/kimi_cli/subagents/registry.py`  
**类**: `LaborMarket`

```python
class LaborMarket:
    """Registry of built-in subagent types."""

    def __init__(self) -> None:
        self._builtin_types: dict[str, AgentTypeDefinition] = {}

    def add_builtin_type(self, type_def: AgentTypeDefinition) -> None:
        self._builtin_types[type_def.name] = type_def

    def get_builtin_type(self, name: str) -> AgentTypeDefinition | None:
        return self._builtin_types.get(name)

    def require_builtin_type(self, name: str) -> AgentTypeDefinition:
        type_def = self.get_builtin_type(name)
        if type_def is None:
            raise KeyError(f"Builtin subagent type not found: {name}")
        return type_def
```

**职责**：
- 存储所有 builtin agent 类型定义
- 提供查询接口（get/require）
- AgentTool 通过 `runtime.labor_market.require_builtin_type(name)` 取得 type_def，进而访问 `supports_background`

---

## 3. Summary Continuation 机制

### 3.1 基础常数

**文件**: `/Users/moonshot/Developer/kimi-cli/src/kimi_cli/subagents/runner.py`  
**位置**: 第 40-48 行

```python
SUMMARY_MIN_LENGTH = 200
SUMMARY_CONTINUATION_ATTEMPTS = 1
SUMMARY_CONTINUATION_PROMPT = """
Your previous response was too brief. Please provide a more comprehensive summary that includes:

1. Specific technical details and implementations
2. Detailed findings and analysis
3. All important information that the parent agent should know
""".strip()
```

**含义**：
- **SUMMARY_MIN_LENGTH**: 200 字符 — 响应必须超过此阈值才算"完整"
- **SUMMARY_CONTINUATION_ATTEMPTS**: 最多续写 **1 次** (循环次数)
- **SUMMARY_CONTINUATION_PROMPT**: 续写提示词 — 要求"comprehensive summary"，强调技术细节、findings、重要信息

### 3.2 运行时流程 - run_with_summary_continuation()

**文件**: `/Users/moonshot/Developer/kimi-cli/src/kimi_cli/subagents/runner.py`  
**函数**: `run_with_summary_continuation()`（第 142-173 行）

```python
async def run_with_summary_continuation(
    soul: KimiSoul,
    prompt: str,
    ui_loop_fn: UILoopFn,
    wire_path: Path,
) -> tuple[str | None, SoulRunFailure | None]:
    """Run soul, then optionally extend the summary if it is too short.

    Returns ``(final_response, failure)``.  On success ``failure`` is
    ``None`` and ``final_response`` contains the agent's output text.
    On failure ``final_response`` is ``None``.
    """
    failure = await run_soul_checked(soul, prompt, ui_loop_fn, wire_path, "running agent")
    if failure is not None:
        return None, failure

    final_response = soul.context.history[-1].extract_text(sep="\n")
    remaining = SUMMARY_CONTINUATION_ATTEMPTS
    while remaining > 0 and len(final_response) < SUMMARY_MIN_LENGTH:
        remaining -= 1
        failure = await run_soul_checked(
            soul,
            SUMMARY_CONTINUATION_PROMPT,
            ui_loop_fn,
            wire_path,
            "continuing the agent summary",
        )
        if failure is not None:
            return None, failure
        final_response = soul.context.history[-1].extract_text(sep="\n")

    return final_response, None
```

**流程分析**:

1. **第一轮**: 执行初始 soul run（用户的原始 prompt）
   - 若失败，返回 (None, failure)
   - 成功则提取响应文本: `final_response = soul.context.history[-1].extract_text(sep="\n")`

2. **续写循环**: 
   - 初始化 `remaining = 1` (最多再续写 1 次)
   - 条件: `remaining > 0 AND len(final_response) < 200`
   - 若满足，执行续写 soul run：
     - 新 prompt = SUMMARY_CONTINUATION_PROMPT
     - phase = "continuing the agent summary"
     - 提取新响应: `final_response = soul.context.history[-1].extract_text(sep="\n")`
   - 若续写失败，返回 (None, failure)
   - 若续写成功，`remaining` 递减，回到条件检查

3. **退出条件**:
   - `remaining == 0` (已使用完 1 次续写配额), 或
   - `len(final_response) >= 200` (响应长度达标)

4. **返回**: (final_response, None) — 最终响应（可能经过续写）

### 3.3 集成点 - ForegroundSubagentRunner.run()

**文件**: `/Users/moonshot/Developer/kimi-cli/src/kimi_cli/subagents/runner.py`  
**函数**: `ForegroundSubagentRunner.run()`（第 283-288 行）

```python
output_writer.stage("run_soul_start")
final_response, failure = await run_with_summary_continuation(
    soul,
    prompt,
    ui_loop_fn,
    self._store.wire_path(agent_id),
)
if failure is not None:
    self._store.update_instance(agent_id, status="failed")
    output_writer.stage(f"failed: {failure.brief}")
    return ToolError(message=failure.message, brief=failure.brief)
output_writer.stage("run_soul_finished")
```

**特性**:
- 用 `run_with_summary_continuation()` 替代直接 `run_soul_checked()`
- 自动处理续写逻辑（对调用方透明）
- 返回的 `final_response` 已自动补全

### 3.4 响应长度计算

**关键**: `soul.context.history[-1].extract_text(sep="\n")`

- 取最后一条 assistant 消息
- 通过 `extract_text()` 方法，以 `\n` 分隔各段文本
- 返回纯文本字符串
- **字符数计算**: Python 的 `len()` 函数（Unicode 字符计数）

---

## 4. TS 现状对标

### 4.1 AgentTypeDefinition 缺口

**TS 文件**: `/Users/moonshot/Developer/kimi-cli-ts/ts/packages/kimi-core/src/soul-plus/agent-type-registry.ts`

```typescript
export interface AgentTypeDefinition {
  name: string;
  description: string;
  whenToUse: string;
  systemPromptSuffix: string;
  allowedTools: string[] | null;
  excludeTools: string[];
  defaultModel: string | null;
  // ❌ 缺少: supportsBackground: boolean;
}
```

**需补充**:
- 新增字段: `supportsBackground: boolean = true`
- 类型: 可选（默认 true），可选：`supportsBackground?: boolean`

### 4.2 AgentTypeRegistry 缺口

**TS 文件**: `/Users/moonshot/Developer/kimi-cli-ts/ts/packages/kimi-core/src/soul-plus/agent-type-registry.ts`

`buildTypeDescriptions()` 当前未展示 Background 状态（与 Python 对应的 _builtin_type_lines() 差异）

```typescript
buildTypeDescriptions(): string {
  const lines: string[] = [];
  for (const def of this.types.values()) {
    lines.push(`- ${def.name}: ${def.description}`);
    if (def.whenToUse) {
      lines.push(`  When to use: ${def.whenToUse.trim()}`);
    }
  }
  return lines.join('\n');
  // ❌ 缺少: Background: yes/no 展示
}
```

**需补充**:
- 在构建类型描述时包含 `Background: ${def.supportsBackground ? 'yes' : 'no'}`

### 4.3 AgentTool 缺口

**TS 文件**: `/Users/moonshot/Developer/kimi-cli-ts/ts/packages/kimi-core/src/tools/agent.ts`

```typescript
async execute(
  toolCallId: string,
  args: AgentToolInput,
  signal: AbortSignal,
  _onUpdate?: (update: ToolUpdate) => void,
): Promise<ToolResult> {
  try {
    const request: SpawnRequest = { /* ... */ };
    const handle = await this.subagentHost.spawn(request);

    if (args.runInBackground) {
      // ❌ 缺少: 检查 supportsBackground
      // 应在此处验证 agent type 是否支持后台运行
    }
    // ...
  }
}
```

**需补充**:
- 在 `runInBackground === true` 时，查询 agent type 定义
- 验证 `typeDef.supportsBackground === true`
- 若为 false，返回错误

### 4.4 SubagentRunner 缺口

**TS 文件**: `/Users/moonshot/Developer/kimi-cli-ts/ts/packages/kimi-core/src/soul-plus/subagent-runner.ts`

**缺失特性**: Summary continuation 机制完全未实现

当前 `runSubagentTurn()`:
```typescript
// 7. Extract result and update status
const resultText = contentCollector.join('');
const usage = turnResult.usage;

// ❌ 直接返回，未检查长度或续写
await store.updateInstance(agentId, { status: 'completed' });

return { result: resultText, usage };
```

**需补充**:
1. 定义常数:
   ```typescript
   const SUMMARY_MIN_LENGTH = 200;
   const SUMMARY_CONTINUATION_ATTEMPTS = 1;
   const SUMMARY_CONTINUATION_PROMPT = "Your previous response was too brief...";
   ```

2. 实现续写函数（类似 Python 的 `run_with_summary_continuation()`）:
   - 检查 `resultText.length < 200`
   - 若是，发起续写 soul turn（使用 continuation prompt）
   - 最多续写 1 次
   - 返回最终文本

---

## 5. 详细实现指导

### 5.1 supports_background 检查流程

**在 AgentTool.execute() 中**:

```typescript
if (args.runInBackground) {
  // 1. 获取 agent type 定义
  const typeDef = this.subagentHost.typeRegistry.resolve(args.agentName ?? 'coder');
  
  // 2. 检查是否支持后台
  if (!typeDef.supportsBackground) {
    return {
      content: `Agent type "${args.agentName}" does not support background execution.`,
      isError: true,
    };
  }
  
  // 3. 继续后台执行逻辑
  const handle = await this.subagentHost.spawn(request);
  // ...
}
```

### 5.2 Summary Continuation 实现

**在 SubagentRunner 中新增函数**:

```typescript
const SUMMARY_MIN_LENGTH = 200;
const SUMMARY_CONTINUATION_ATTEMPTS = 1;
const SUMMARY_CONTINUATION_PROMPT = `
Your previous response was too brief. Please provide a more comprehensive summary that includes:

1. Specific technical details and implementations
2. Detailed findings and analysis
3. All important information that the parent agent should know
`.trim();

async function runWithSummaryContinuation(
  parentSink: EventSink,
  agentId: string,
  agentName: string,
  parentToolCallId: string,
  childConfig: SoulConfig,
  childContext: ContextState,
  childRuntime: Runtime,
  signal: AbortSignal,
  initialPrompt: string,
): Promise<string> {
  // 1. 首次运行
  const contentCollector: string[] = [];
  const childSink = createBubblingSink(
    parentSink,
    agentId,
    agentName,
    parentToolCallId,
    contentCollector,
  );
  
  let turnResult = await runSoulTurn(
    { text: initialPrompt },
    childConfig,
    childContext,
    childRuntime,
    childSink,
    signal,
  );
  
  let finalResponse = contentCollector.join('');
  
  // 2. 续写循环
  let remaining = SUMMARY_CONTINUATION_ATTEMPTS;
  while (remaining > 0 && finalResponse.length < SUMMARY_MIN_LENGTH) {
    remaining--;
    
    // 清空 collector 以收集续写文本
    contentCollector.length = 0;
    
    await childContext.appendUserMessage({ text: SUMMARY_CONTINUATION_PROMPT });
    
    turnResult = await runSoulTurn(
      { text: SUMMARY_CONTINUATION_PROMPT },
      childConfig,
      childContext,
      childRuntime,
      childSink,
      signal,
    );
    
    finalResponse = contentCollector.join('');
  }
  
  return finalResponse;
}
```

### 5.3 集成到 runSubagentTurn()

```typescript
export async function runSubagentTurn(
  // ... 参数
): Promise<AgentResult> {
  // ... 前置步骤 (1-4) ...
  
  // 5. 运行包含续写的 soul turn
  let resultText: string;
  try {
    resultText = await runWithSummaryContinuation(
      parentSink,
      agentId,
      request.agentName,
      request.parentToolCallId,
      childConfig,
      childContext,
      childRuntime,
      signal,
      prompt,
    );
  } catch (error) {
    // ... error handling ...
  }
  
  // 6. 后续处理
  const usage = turnResult.usage;
  await store.updateInstance(agentId, { status: 'completed' });
  
  return { result: resultText, usage };
}
```

---

## 6. 验证清单

### 6.1 supports_background

- [ ] AgentTypeDefinition 新增 `supportsBackground: boolean` 字段
- [ ] 默认值: `true`
- [ ] AgentTypeRegistry.buildTypeDescriptions() 包含 Background 状态
- [ ] AgentTool.execute() 在 `runInBackground=true` 时验证支持性
- [ ] 验证失败时返回清晰的错误信息

### 6.2 Summary Continuation

- [ ] 定义三个常数 (MIN_LENGTH=200, ATTEMPTS=1, PROMPT)
- [ ] 实现 `runWithSummaryContinuation()` 函数
- [ ] 首轮运行后检查长度
- [ ] 若 < 200 chars，执行续写循环
- [ ] 最多续写 1 次
- [ ] 正确处理错误（续写失败应返回 None 或抛出）

### 6.3 文本长度计算

- [ ] 使用 `.length` 计算字符数（JavaScript 字符计数）
- [ ] 确保与 Python 的 `len()` 语义一致

---

## 7. 关键差异与注意事项

### 7.1 字符计数

**Python**: `len(str)` — 返回 Unicode 字符数  
**TS/JavaScript**: `str.length` — 同样返回字符计数（对 ASCII/CJK 一致）

### 7.2 续写 Prompt 集成

**Python**: 通过 `soul.context.history[-1]` 取最后响应，直接传给 `run_soul_checked()`  
**TS**: 需确保 continuation prompt 被正确追加到 `childContext` 消息历史，使得下一轮 runSoulTurn 看到对话流

### 7.3 Error Handling

**Python**: `run_soul_checked()` 返回 `SoulRunFailure | None`；续写失败时返回整个 tuple  
**TS**: 考虑是否在 continuation 失败时：
- 返回首轮响应（降级）, 或
- 抛出错误（中止）

建议: **返回首轮响应** (降级策略) — 至少保证有可用的输出，而非完全失败

---

## 8. Python 源码引用

### 文件列表

1. **models.py** (第 19-34 行)
   - AgentTypeDefinition 定义
   - 包含 `supports_background` 字段

2. **registry.py** (全文)
   - LaborMarket 类
   - builtin type 存储与查询

3. **agent/__init__.py** (第 65-278 行)
   - AgentTool 类
   - 第 81-96: _builtin_type_lines() — supports_background 展示
   - 第 119-162: __call__() 主流程
   - 第 163-275: _run_in_background() — 后台执行检查点

4. **runner.py** (第 40-173 行)
   - SUMMARY_MIN_LENGTH, SUMMARY_CONTINUATION_ATTEMPTS, SUMMARY_CONTINUATION_PROMPT
   - run_with_summary_continuation() 实现
   - ForegroundSubagentRunner.run() 集成点 (第 283-288)

---

## 9. 总结

| 特性 | 定义位置 | 检查位置 | TS 状态 | 优先级 |
|------|--------|--------|--------|--------|
| **supports_background** | AgentTypeDefinition | AgentTool._run_in_background() | ❌ 缺少字段 + 检查 | 高 |
| **background 展示** | LaborMarket | AgentTool._builtin_type_lines() | ❌ buildTypeDescriptions() 未包含 | 中 |
| **summary continuation** | runner.py | ForegroundSubagentRunner.run() | ❌ 完全未实现 | 高 |

**TS 实现的关键里程碑**:
1. 在 AgentTypeDefinition 中新增 `supportsBackground` 字段
2. 在 AgentTypeRegistry.buildTypeDescriptions() 中展示该状态
3. 在 AgentTool.execute() 中验证后台运行权限
4. 在 subagent-runner.ts 中实现完整的 summary continuation 流程
