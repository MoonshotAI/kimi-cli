# AgentLens：面向 Coding Agent 的可观测、诊断与评测平台

> 文档定位：秋招项目立项与开发执行方案；基础项目：Kimi Code CLI；建议周期：8 周，单人每周
> 投入 15～25 小时；项目关键词：AI Agent、可观测性、事件驱动、异步系统、故障诊断、评测平台。

## 1. 项目摘要

AgentLens 不是再实现一个聊天界面，也不是简单统计 Token。它要解决的是 Coding Agent
在真实软件工程任务中“失败过程不可解释、优化效果不可量化”的问题。

用户运行 Coding Agent 后，通常只能看到最终成功或失败，却难以回答以下问题：

- 失败最早发生在哪一步？
- 是模型决策错误、工具错误、环境错误，还是上下文退化？
- Agent 为什么重复读取文件、重复运行命令或持续无效重试？
- 某次 Prompt、模型或运行时改造究竟提高了成功率，还是仅增加了 Token 消耗？
- 不同版本的 Agent 在相同任务上的执行路径有什么差异？

AgentLens 将一次 Agent 任务建模为包含 Turn、Step、Model Request、Tool Call、Approval、
Compaction 和 Subagent 的层级 Trace，在本地持久化完整执行数据，通过确定性规则识别常见
失败模式，并使用可重复的数据集运行 A/B 评测。最终形成以下闭环：

```text
执行任务 -> 采集 Trace -> 自动诊断 -> 定位根因 -> 修改 Agent -> 回归评测 -> 对比收益
```

### 1.1 与仓库现有能力的关系

仓库已经存在技术预览版 `kimi vis`，支持：

- 浏览 `wire.jsonl` 事件时间线；
- 查看 `context.jsonl` 上下文；
- 展示 Token、工具次数、错误数等基础统计；
- 浏览主 Agent 和子 Agent；
- 导入、导出历史会话。

因此，AgentLens 不应重新制作一个“日志查看器”。它应在现有 Visualizer 上增加当前缺失的
能力：

| 能力 | 当前基线 | AgentLens 目标 |
|---|---|---|
| 执行记录 | 扁平 Wire 事件 | 具有父子关系的结构化 Span |
| 耗时分析 | 根据相邻事件时间推算 | 精确记录模型、工具、审批、压缩耗时 |
| 错误展示 | 显示错误事件 | 自动归类失败模式并给出证据 |
| 历史查询 | 每次扫描 JSONL | SQLite 索引、筛选和聚合 |
| 版本比较 | 无 | 相同任务的成对 Trace Diff |
| 评测 | 无 | 数据集适配、隔离运行、评分和报告 |
| 隐私 | 会话文件包含原始内容 | 默认脱敏、字段白名单和保留策略 |
| 优化闭环 | 依赖人工观察 | 诊断规则与评测指标关联 |

## 2. 解决的问题与预期效果

### 2.1 问题一：执行链路缺少统一因果关系

目前 `wire.jsonl` 能记录发生了什么，但 Turn、Step、LLM 请求、并行 Tool Call 和 Subagent
之间没有统一的父子 Span 模型。并行工具调用时，仅依靠相邻时间戳无法可靠计算耗时和关键
路径。

AgentLens 为每个事件增加 `trace_id`、`span_id`、`parent_span_id`、开始/结束时间、状态和
结构化属性，使一次任务可以还原为调用树，并计算关键路径、并行度和各阶段耗时占比。

预期效果：开发者能从失败任务直接跳转到最早异常 Span，明确其上游决策和下游影响。

### 2.2 问题二：错误信息存在，但根因仍依赖人工阅读

工具返回错误不一定是根因。例如，测试失败可能源于错误修改，错误修改可能源于读取了过期
上下文；反过来，一次可恢复的命令失败也不应直接判定整个任务失败。

AgentLens 首期使用可解释的确定性规则检测：

- `RepeatedToolLoop`：相同工具与参数跨 Step 重复，且没有产生新状态；
- `RetryStorm`：短时间内对同一模型请求或命令多次失败重试；
- `ToolFailureCascade`：某个工具错误后触发多个下游错误；
- `NoProgress`：连续多个 Step 没有文件变化、测试状态变化或新证据；
- `ContextPressure`：上下文持续接近上限，压缩后又快速膨胀；
- `CompactionRegression`：压缩后丢失约束，出现重复探索或行为反转；
- `ApprovalBottleneck`：审批等待占任务耗时比例过高；
- `SlowOperation`：模型或工具耗时超过动态分位数阈值；
- `PrematureStop`：Agent 结束任务，但验收测试未通过或工作区仍存在明确失败；
- `SubagentWaste`：子 Agent 结果未被消费，或多个子 Agent 重复完成相同探索。

每条诊断必须输出严重级别、置信度、涉及 Span、触发证据和建议动作。第一阶段不使用 LLM
直接判定根因，避免诊断器本身不可复现；LLM 只能作为可选的自然语言总结层。

预期效果：将“翻阅完整日志”转变为“先查看 1～3 个高优先级 Finding，再验证证据”。

### 2.3 问题三：Agent 改造缺少同条件对比

模型输出具有随机性，只比较两个成功 Demo 没有意义。AgentLens 的 Eval Runner 固定数据集、
模型、Token 预算、超时、工具权限和环境镜像，对 baseline 与 candidate 进行成对实验，并保存
每次运行的补丁、测试结果和 Trace。

预期效果：能够回答以下工程问题：

- 新的重复调用保护是否减少了工具调用，同时没有降低成功率？
- 新的压缩策略是否节省 Token，但导致关键约束遗忘？
- 某类任务成功率下降，是模型变化还是环境失败造成的？

### 2.4 问题四：原始轨迹包含隐私和存储风险

Agent 轨迹可能包含代码、路径、Prompt、Shell 输出和密钥。AgentLens 采用本地优先设计：

- 默认只持久化诊断所需的元数据和经过脱敏的内容；
- 对文件路径、URL、环境变量、Token 形态应用脱敏器；
- 原始 Prompt、工具参数和输出采用显式 opt-in；
- 支持按天数、数据库大小或项目范围清理；
- 导出时再次执行脱敏检查并输出隐私清单；
- 不复用远程 Telemetry 作为详细 Trace 存储。

### 2.5 开发前如何验证这是真实痛点

在写代码前访谈 8～12 名使用过 Cursor、Claude Code、Codex 或其他 Coding Agent 的开发者，
不要直接询问“你是否需要可观测平台”，而是让他们回忆最近一次失败任务：当时如何发现失败、
看了哪些信息、花了多久、最后是否定位成功。争取收集至少 30 条匿名失败案例，按“模型决策、
工具、环境、上下文、权限、任务验收”编码。

立项继续条件建议设为：超过一半受访者在过去一个月遇到过无法快速解释的 Agent 失败，且原始
日志定位的中位耗时超过 10 分钟。若真实反馈集中在模型效果而非诊断困难，则应缩小 AgentLens
范围，把重点转为 Eval Runner 和版本对比，不应为了既定方案忽略调研结论。

## 3. 产品范围

### 3.1 MVP 必须完成

1. 本地层级 Trace：Turn、Step、模型调用、工具调用、审批和压缩。
2. SQLite TraceStore：支持按会话、任务、模型、状态和时间查询。
3. 至少 6 条确定性诊断规则，能够展示证据 Span。
4. `kimi lens show`、`kimi lens diagnose`、`kimi lens compare` 三个 CLI 命令。
5. 在现有 `kimi vis` 中加入 Trace Tree、Findings 和 Compare 页面。
6. Eval Runner：能够运行自建任务集和一个公开数据集适配器。
7. 自动生成 JSON 与 HTML 评测报告。
8. 完成基线实验、消融实验和性能开销测试。

### 3.2 加分项

- OpenTelemetry JSON/OTLP 导出；
- 跨主 Agent、子 Agent 的关键路径分析；
- 实时 WebSocket Trace 更新；
- 基于历史分位数的异常阈值；
- 对失败轨迹生成可分享的脱敏复现包；
- CI 中对关键 Agent 任务做小规模回归。

### 3.3 首期不做

- 不实现通用云端日志平台；
- 不存储或展示模型隐藏推理；
- 不承诺对真实 Shell 副作用进行任意重放；
- 不以另一个 LLM 的主观打分代替可执行测试；
- 不在第一版引入复杂向量数据库或训练分类模型；
- 不同时改造 Agent 决策、上下文策略、安全策略和多 Agent 调度。

这里的“Replay”默认指确定性回放已有事件和离线重新诊断。真正重新执行任务只允许发生在
Eval Runner 创建的隔离环境中，避免重复发送网络请求或执行破坏性命令。

## 4. 总体架构

```text
KimiSoul / Toolset / Approval / Compaction / Subagent
                       |
                       v
              Local Observability Bus
                |               |
                v               v
         JSONL compatibility   Trace Recorder
                                      |
                                      v
                              SQLite TraceStore
                               |      |      |
                               v      v      v
                           Query   Analyzer  Exporter
                               \      |      /
                                \     |     /
                                  CLI + Vis
                                      |
                                      v
                          Eval Runner / Compare Report
```

设计原则：

- 核心运行路径只负责发出事件，不执行复杂分析；
- 写入采用有界队列和批处理，不阻塞 Agent 主循环；
- 诊断器只依赖稳定的 Trace 模型，不直接解析 UI 数据；
- 旧 `wire.jsonl` 可以离线导入，保证历史会话可用；
- Schema 带版本号，新增字段保持向后兼容；
- 同一个 Agent 执行与评测逻辑共用一套采集链路。

## 5. 数据模型

### 5.1 Trace 与 Span

建议定义以下核心模型：

```python
class SpanKind(StrEnum):
    TURN = "turn"
    STEP = "step"
    MODEL = "model"
    TOOL = "tool"
    APPROVAL = "approval"
    COMPACTION = "compaction"
    SUBAGENT = "subagent"

class SpanStatus(StrEnum):
    RUNNING = "running"
    OK = "ok"
    ERROR = "error"
    CANCELLED = "cancelled"

class TraceSpan(BaseModel):
    schema_version: int
    trace_id: str
    span_id: str
    parent_span_id: str | None
    session_id: str
    task_id: str | None
    kind: SpanKind
    name: str
    started_at_ns: int
    ended_at_ns: int | None
    status: SpanStatus
    attributes: dict[str, JsonValue]
```

时间使用 wall clock 与 monotonic duration 分开记录：wall clock 用于跨事件展示，monotonic
用于精确计算进程内耗时，避免系统时间调整导致负数。

### 5.2 SQLite 表

建议使用 Python 内置 `sqlite3`，减少生产依赖：

| 表 | 作用 | 关键字段 |
|---|---|---|
| `trace_runs` | 一次 Agent 任务 | run_id、session_id、model、git_sha、status |
| `spans` | 层级执行单元 | span_id、parent_span_id、kind、duration、status |
| `span_events` | Span 内瞬时事件 | event_id、span_id、name、timestamp、attributes |
| `findings` | 自动诊断结果 | rule_id、severity、confidence、evidence_span_ids |
| `eval_cases` | 评测任务定义 | dataset、case_id、repo、base_commit |
| `eval_attempts` | 单次评测运行 | variant、seed、resolved、tokens、duration、patch |
| `schema_meta` | 数据库迁移版本 | schema_version、migrated_at |

数据库启用 WAL 模式；Span 和 Event 通过异步队列批量写入。大段文本不直接进入常用索引表，
而是存入受保留策略管理的 blob 表或会话附件，数据库只保留摘要、Hash 和引用。

## 6. 详细开发流程与代码改造点

### 阶段 0：冻结基线与隔离开发环境

当前工作区已经存在未提交修改。正式开发时应先保护这些改动，再建立独立分支或 worktree，
不要把 AgentLens 与现有环境变量相关修改混在同一个提交中。

建议分支：`codex/agentlens`。

先记录以下基线：

- `make check`、`make test` 当前结果；
- `kimi vis` 当前页面截图和功能清单；
- 10 个固定任务上的成功率、Token、工具调用数和耗时；
- 一个包含工具错误、重复调用、压缩和子 Agent 的样例会话。

交付物：`docs/agentlens/baseline.md` 和可重复运行的 baseline 配置。

### 阶段 1：定义稳定 Trace Schema

新增目录：

```text
src/kimi_cli/observability/
├── __init__.py
├── models.py
├── context.py
├── bus.py
├── recorder.py
├── redaction.py
└── schema.py
```

具体工作：

1. `models.py` 定义 Trace、Span、Event 和 Finding 的 Pydantic 模型。
2. `context.py` 使用 `ContextVar` 保存当前 trace/span，使并发工具和子 Agent 自动继承父上下文。
3. `bus.py` 提供轻量 `emit()` 接口和有界 `asyncio.Queue`。
4. `recorder.py` 批量消费队列并写入 TraceStore。
5. `redaction.py` 对密钥、Authorization、Cookie、环境变量、用户目录和 URL 参数脱敏。
6. `schema.py` 声明 Schema 版本和迁移策略。

不要直接扩展现有 `telemetry.track()` 来存详细 Trace。现有 Telemetry 的属性被限制为标量，且
其设计目标是远程、匿名的产品统计；AgentLens 需要本地、层级、可查询的丰富事件。两者可以在
同一调用点分别发事件，但必须保持数据边界清晰。

测试文件：

```text
tests/observability/test_models.py
tests/observability/test_context.py
tests/observability/test_bus.py
tests/observability/test_redaction.py
```

验收标准：并发创建 1 万个事件不出现 ID 冲突；队列满时有明确的 drop 计数；敏感样例不落盘。

### 阶段 2：实现本地 TraceStore

新增：

```text
src/kimi_cli/observability/store.py
src/kimi_cli/observability/migrations/
tests/observability/test_store.py
tests/observability/test_migrations.py
```

需要实现：

- 数据库首次初始化；
- WAL、busy timeout 和事务批量写；
- Span 开始与结束的幂等 upsert；
- 按 run、session、kind、status、时间范围查询；
- 数据库损坏时降级，不影响 Agent 主任务；
- 数据保留与 vacuum；
- 从旧 `wire.jsonl` 导入历史会话；
- Trace 导出为脱敏 JSON。

建议数据库位置为 `~/.kimi/agentlens/traces.db`，测试必须通过依赖注入使用临时目录，不能读写
真实用户数据。

验收标准：异常退出后已完成批次仍可查询；重复导入同一会话不产生重复记录；10 万 Span 查询
P95 小于 200 ms。

### 阶段 3：插桩核心执行链路

#### `src/kimi_cli/app.py`

- 创建并启动 Recorder；
- 将 Recorder 注入 Runtime；
- 进程退出时限时 flush；
- 配置关闭 AgentLens 时不产生额外数据库文件。

#### `src/kimi_cli/soul/kimisoul.py`

- `_turn()`：创建 Turn Span；
- `_agent_loop()`：每个 Step 创建子 Span；
- `_step()`：创建 Model Span，记录模型名、请求轮次、首 Token 延迟、总耗时和 TokenUsage；
- 重试路径：记录 attempt、wait、错误类型和状态码；
- 强制停止、用户中断、最大步数等写入结束原因；
- `compact_context()`：记录压缩前后 Token、耗时和压缩率。

禁止记录模型隐藏推理。Prompt 内容默认只保存长度、消息数、角色分布和稳定 Hash；只有用户
显式开启 `capture_content` 后才保存脱敏内容。

#### `src/kimi_cli/soul/toolset.py`

- 为每次真实 Tool Call 创建 Tool Span；
- 记录工具名、参数 Hash、参数大小、结果大小、状态与精确耗时；
- 记录 same-step dedup、cross-step repeat、hook block 和 cancellation；
- 并行工具调用分别创建子 Span，不能用单一全局变量关联；
- 结果内容默认仅保留类型、大小、Hash 和截断后的脱敏预览。

现有代码已经采集 `tool_call`、`tool_call_repeat` 和 `tool_call_dedup_detected` Telemetry，
AgentLens 应复用同一业务判断，避免在两个模块分别实现重复检测。

#### `src/kimi_cli/soul/approval.py`

- 创建 Approval Span；
- 记录等待耗时、审批结果、审批模式和操作类型；
- 不记录可能包含路径或命令全文的 description，除非经过脱敏。

#### `src/kimi_cli/subagents/runner.py` 与 `src/kimi_cli/background/`

- 子 Agent 使用独立 span_id，但共享根 trace_id；
- parent_span_id 指向创建它的 Tool 或 Step；
- 记录排队、启动、完成、失败、取消和结果是否被主 Agent 消费；
- 后台任务必须能跨 asyncio Task 传播 Trace Context。

#### `src/kimi_cli/wire/file.py`

- 保持现有 Wire 协议兼容；
- 为离线适配器提供稳定读取接口；
- 不把 AgentLens 私有字段强塞进所有公开 Wire 消息；
- 如果确实新增 Wire 类型，需要同步协议版本、序列化和客户端兼容测试。

测试重点：正常结束、异常、取消、并行工具、重试、压缩、子 Agent 和进程退出 flush。

### 阶段 4：实现自动诊断引擎

新增：

```text
src/kimi_cli/observability/analysis/
├── base.py
├── engine.py
├── progress.py
└── rules/
    ├── repeated_tool_loop.py
    ├── retry_storm.py
    ├── tool_failure_cascade.py
    ├── no_progress.py
    ├── context_pressure.py
    ├── approval_bottleneck.py
    ├── slow_operation.py
    └── premature_stop.py
```

统一规则接口：

```python
class DiagnosticRule(Protocol):
    rule_id: str
    version: str

    def analyze(self, trace: TraceView) -> list[Finding]: ...
```

其中“进展”不能只等同于文件发生变化。建议综合以下信号：

- Git diff 指纹是否变化；
- 测试失败集合是否缩小；
- Agent 是否获得新文件、符号或错误信息；
- Todo/Plan 状态是否推进；
- 最终验收命令是否改善。

诊断规则需要版本化。评测报告必须记录 rule version，否则同一条历史 Trace 在未来可能得到
不同结果而无法解释。

验收标准：每条规则至少包含正常、边界、阳性和组合场景测试；Finding 能定位到具体证据 Span。

### 阶段 5：增加 CLI 查询与比较

新增 `src/kimi_cli/cli/lens.py`，并在懒加载命令表中注册：

```text
kimi lens list
kimi lens show <run-id>
kimi lens diagnose <run-id>
kimi lens compare <baseline-run> <candidate-run>
kimi lens export <run-id> --redacted
kimi lens gc --keep-days 30
```

建议输出：

- 任务状态和结束原因；
- 总耗时、关键路径耗时、模型/工具/等待占比；
- Token、Step、Tool Call、Retry、Compaction；
- Top Findings；
- 与另一个运行相比的绝对值和百分比变化。

CLI 首先完成，因为它容易测试，也能让后端能力不依赖前端进度。

### 阶段 6：升级现有 Visualizer

后端新增：

```text
src/kimi_cli/vis/api/traces.py
src/kimi_cli/vis/api/findings.py
src/kimi_cli/vis/api/comparisons.py
src/kimi_cli/vis/api/evaluations.py
```

前端新增：

```text
vis/src/features/trace-tree/
vis/src/features/findings/
vis/src/features/run-compare/
vis/src/features/evaluations/
```

页面设计：

1. **Trace Overview**：状态、耗时分解、Token、关键路径和失败阶段。
2. **Span Tree**：可折叠的父子调用树，并与现有 Wire 时间线互相跳转。
3. **Findings**：按严重级别排序，展示规则、证据、影响和建议。
4. **Compare**：左右 Trace 对齐，比较 Step、工具序列、Token 和最终补丁。
5. **Evaluations**：数据集、variant、成功率、成本和失败类型分布。

前端不重复计算核心诊断指标。指标应由 Python 后端统一生成，React 仅负责展示，避免 CLI、
API 和页面出现三套口径。

### 阶段 7：实现 Eval Runner

新增：

```text
src/kimi_cli/evaluation/
├── models.py
├── runner.py
├── sandbox.py
├── scorer.py
├── report.py
└── adapters/
    ├── local.py
    ├── swe_bench.py
    └── harbor.py

evals/
├── agentlens-dev.yaml
├── fault-injection/
└── expected/
```

单个 Case 至少包含：

- `case_id`、数据集和仓库；
- base commit 或容器镜像；
- 用户任务描述；
- 安装和测试命令；
- 超时、Token 和 Step 预算；
- 成功判定；
- 可选故障标签。

Runner 流程：

```text
准备隔离环境 -> 校验基线测试 -> 启动 Agent -> 收集 Trace
-> 获取 Git diff -> 执行验收测试 -> 评分 -> 保存产物 -> 清理环境
```

每个任务至少保存：运行配置、stdout/stderr、生成补丁、测试报告、Trace、Finding 和资源消耗。
环境准备失败必须标记为 `infra_error`，不能记为 Agent 失败。

### 6.8 代码改动总表

| 类型 | 文件或目录 | 改动目的 |
|---|---|---|
| 修改 | `src/kimi_cli/app.py` | 初始化、注入并关闭本地 Recorder |
| 修改 | `src/kimi_cli/soul/kimisoul.py` | Turn、Step、Model、Retry、Compaction 插桩 |
| 修改 | `src/kimi_cli/soul/toolset.py` | Tool Span、重复调用和错误属性 |
| 修改 | `src/kimi_cli/soul/approval.py` | 审批等待时间和结果 Span |
| 修改 | `src/kimi_cli/subagents/runner.py` | 主子 Agent Trace 关联 |
| 修改 | `src/kimi_cli/background/` | 后台任务的上下文传播和状态事件 |
| 修改 | `src/kimi_cli/wire/file.py` | 历史 Wire 导入所需的稳定读取能力 |
| 修改 | `src/kimi_cli/cli/_lazy_group.py` | 懒加载 `lens` 与 `eval` 子命令 |
| 新增 | `src/kimi_cli/cli/lens.py` | Trace 查询、诊断、比较、导出和清理 |
| 新增 | `src/kimi_cli/cli/eval.py` | 数据集运行和报告命令 |
| 新增 | `src/kimi_cli/observability/` | Schema、Bus、Recorder、Store、脱敏和诊断 |
| 新增 | `src/kimi_cli/evaluation/` | Sandbox、Runner、Scorer、Adapter 和报告 |
| 修改 | `src/kimi_cli/vis/app.py`、`vis/api/__init__.py` | 注册 AgentLens API |
| 新增 | `src/kimi_cli/vis/api/` 下的 Trace API | 查询 Span、Finding、Compare 和 Eval |
| 修改 | `vis/src/App.tsx`、`vis/src/lib/api.ts` | 新页面入口和 API 类型 |
| 新增 | `vis/src/features/` 下的 AgentLens 页面 | Trace Tree、Findings、Compare、Evaluations |
| 新增 | `tests/observability/`、`tests/evaluation/` | 单元、集成、迁移和性能测试 |
| 新增 | `evals/` | 固定任务配置、故障注入和预期标签 |
| 修改 | `docs/zh/reference/kimi-vis.md` 等 | CLI、隐私选项和评测使用说明 |

每个阶段单独提交，提交信息遵循 Conventional Commits，例如
`feat(observability): add local trace recorder`。不要在一个提交中同时加入底层 Schema、前端页面
和 Benchmark 结果，否则评审与回滚都会困难。

## 7. 评测数据集方案

AgentLens 需要评测两类对象：一类是 Coding Agent 的任务完成能力，另一类是 AgentLens 自身的
采集与诊断能力。只跑 SWE-bench 成功率，无法证明诊断器有效；只做故障注入，又无法证明对
真实任务有价值。

### 7.1 AgentLens-Fault：自建可控故障集，必须做

目标：评价根因分类和故障 Span 定位。

构造 100～150 条轨迹，覆盖以下类别：

- 重复读取、重复命令和跨 Step 循环；
- 工具 JSON 参数错误、工具不存在和权限拒绝；
- 网络超时、429、5xx 和重试耗尽；
- 测试持续失败但 Agent 提前结束；
- 上下文接近上限、压缩后重复探索；
- 用户拒绝审批导致路径中断；
- 并行工具中一个失败引发级联；
- 子 Agent 重复工作或结果未消费；
- 正常但耗时较长的负样本。

每条样本由注入器确定 ground truth：`fault_type`、`root_span_id`、`injected_at` 和预期 Finding。
训练、调参、测试应按任务或仓库切分，不能把同一任务的不同轨迹放入不同集合。

核心指标：

- 分类 Precision、Recall、Macro-F1；
- 根因 Span Top-1、Top-3 命中率；
- 首个有效 Finding 的平均排名；
- 正常轨迹误报率；
- 不同规则组合的消融结果。

### 7.2 SWE-bench Verified：主要真实任务集

[SWE-bench Verified](https://www.swebench.com/SWE-bench/faq/) 包含 500 个经过工程师验证、可解决的
真实 GitHub issue。官方 Harness 会在 Docker 环境中应用补丁并运行测试，适合评价端到端软件
工程任务。

建议使用方式：

- 开发期：固定抽取 30 个任务，按仓库和难度分层；
- 中期：扩展到 100 个任务；
- 最终：预算允许则跑完整 500 个，否则明确报告分层 100 子集；
- baseline 与 candidate 使用相同模型、参数、预算和任务顺序；
- 每个任务建议重复 3 次，至少报告 pass@1 和平均资源消耗。

官方文档提示本地 Harness 建议至少 120 GB 存储、16 GB 内存和 8 核 CPU，并优先使用 x86_64；
因此 Apple Silicon 笔记本不适合作为完整评测环境。可以使用远程 x86_64 主机或官方支持的云端
流程，具体要求见 [SWE-bench Harness](https://www.swebench.com/SWE-bench/reference/harness/)。

主要指标：Resolved Rate、测试通过率、Token/Resolved、秒/Resolved、工具调用/Resolved、
Finding 类型分布和 `infra_error` 比例。

### 7.3 SWE-bench Lite：开发期回归

[SWE-bench Lite](https://github.com/SWE-bench/SWE-bench/blob/main/docs/guides/quickstart.md) 是成本更低的
子集，适合验证适配器、容器、报告和小规模回归。它不应替代 Verified 作为唯一最终结论。

建议每个 PR 只运行固定 10～20 个 smoke cases，每周运行 50 个固定 cases。这样可以控制模型
费用和执行时间，同时保持结果可比较。

### 7.4 SWE-bench 公共轨迹：离线真实失败分析

[SWE-bench experiments](https://github.com/swe-bench/experiments) 公开了部分提交的 predictions、
执行日志、轨迹和评测结果。为常见轨迹格式编写 adapter，将其导入 AgentLens，人工标注其中
100～200 条失败轨迹，可用于评价诊断规则在非本项目 Agent 上的泛化能力。

注意：公开轨迹格式和记录完整性并不统一，因此它适合作为外部验证集，不适合作为唯一 ground
truth。人工标注时应由两人独立标注一部分重叠样本，并报告一致性；如果只能单人完成，应在
报告中明确限制。

### 7.5 Terminal-Bench 2.0：终端任务泛化测试

[Terminal-Bench 2.0](https://www.harborframework.com/docs/tutorials/running-terminal-bench) 通过官方
Harbor Harness 在隔离终端环境运行真实工作流。其[论文](https://arxiv.org/abs/2601.11868)描述的
数据集包含 89 个高难度任务，
不仅限于代码补丁，因此适合验证 Tool、Shell、Retry 和 NoProgress 诊断能否泛化。

建议最终选择 15～20 个覆盖不同工具模式的任务；算力和预算足够时再运行全部任务。它不是
AgentLens 第一阶段的阻塞项。

### 7.6 Aider Polyglot：低成本编辑链路测试，可选

[Aider Polyglot](https://aider.chat/docs/leaderboards/) 包含 225 个来自 Exercism 的编程练习，覆盖
C++、Go、Java、JavaScript、Python 和 Rust。它适合快速检查编辑格式、测试执行和多语言统计，
但任务规模较小、仓库探索较弱，不能代替 SWE-bench。

建议只抽取 Python 和另一种语言各 10～20 个任务作为 Runner 冒烟测试。

### 7.7 推荐的最终组合

| 层级 | 数据集 | 建议规模 | 用途 |
|---|---|---:|---|
| 单元级 | AgentLens-Fault | 100～150 轨迹 | 诊断分类与根因定位 |
| 快速回归 | SWE-bench Lite | 10～50 任务 | CI、适配器和成本回归 |
| 主实验 | SWE-bench Verified | 100 或 500 任务 | 真实软件工程能力 |
| 外部轨迹 | SWE-bench experiments | 100～200 轨迹 | 跨 Agent 泛化 |
| 泛化实验 | Terminal-Bench 2.0 | 15～89 任务 | Shell 与长任务诊断 |
| 可选冒烟 | Aider Polyglot | 20～40 任务 | 多语言编辑链路 |

## 8. 指标与实验设计

### 8.1 采集系统指标

| 指标 | 计算方式 | MVP 验收目标 |
|---|---|---:|
| Event completeness | 实际落盘事件 / 预期事件 | ≥ 99% |
| Span closure rate | 正确结束的 Span / 已创建 Span | ≥ 99% |
| ID collision | 重复 span_id 数 | 0 |
| 运行耗时开销 | 开启与关闭 AgentLens 的耗时差 | P50 < 2%，P95 < 5% |
| 内存开销 | 稳态 RSS 增量 | < 50 MB |
| 写入可靠性 | 故障注入后可恢复记录比例 | ≥ 99% |
| 脱敏泄漏率 | 敏感测试样本中未脱敏比例 | 0 |

这些数字是设计目标，不是可以直接写进简历的最终结果。

### 8.2 诊断质量指标

- Macro-F1：防止高频故障类别掩盖低频类别；
- Top-1/Top-3 root-span accuracy：诊断是否定位到真正起点；
- false positives per successful run：正常任务被误报多少次；
- evidence coverage：Finding 是否包含可验证证据；
- diagnosis latency：任务结束到完成诊断的耗时。

建议目标：Macro-F1 ≥ 0.80、Top-3 根因命中率 ≥ 0.85、正常轨迹严重误报率 < 5%。这些值
必须在冻结的测试集上得到后才能用于对外文案。

### 8.3 人效指标

邀请 6～10 名有 Coding Agent 使用经验的同学，对相同失败轨迹进行交叉实验：

- A 组只使用原始 `kimi vis`；
- B 组使用 AgentLens Findings 和 Span Tree；
- 记录定位根因耗时、答案正确率和主观信心；
- 交换工具后再做第二批任务，降低参与者能力差异影响。

核心指标是 Time-to-Root-Cause 和诊断正确率。若样本较少，报告中展示原始分布和中位数，
不要只给平均值。

### 8.4 Agent 优化收益

AgentLens 本身不会自动让模型变聪明。应选择诊断发现的一个高频问题，例如重复工具调用或
重试风暴，修改 Agent 后再证明闭环价值。

建议实验：

1. baseline：原始 Agent；
2. candidate：增加基于 Finding 发现的改造；
3. 固定模型、温度、任务、Token、超时和权限；
4. 每个任务成对运行；
5. 报告成功率、Token、工具调用和耗时；
6. 使用 bootstrap 计算 95% 置信区间；
7. 对成对成功/失败结果可补充 McNemar 检验。

建议目标是 Token 或无效工具调用降低 10%～20%，且 Resolved Rate 不下降；如果成功率还能
获得 3～8 个百分点的提升，则是额外收益。最终按真实数据陈述，不要反向选择最好的一次运行。

## 9. 测试策略

### 9.1 单元测试

- 模型校验和 Schema 升级；
- Trace Context 跨 await、Task 和子 Agent 传播；
- 批量写、幂等、事务失败和数据库锁；
- 每条诊断规则的正负样本；
- 脱敏器对 Token、路径、URL、Header 和环境变量的覆盖；
- 指标计算和成对比较。

### 9.2 集成测试

- 一次完整 Turn 生成正确 Span 树；
- 并行工具调用的父子关系和耗时正确；
- 模型重试与最终成功/失败状态正确；
- Compaction 前后指标完整；
- 主 Agent 与子 Agent 共享 trace_id；
- 旧 `wire.jsonl` 可以导入；
- CLI、API 和 Web 显示相同统计结果。

### 9.3 端到端测试

- 使用本地 fake provider 和确定性工具完成一个成功任务；
- 注入工具失败并确认 Finding；
- 强制杀死进程后验证已落盘 Span；
- 在临时 Git 仓库运行 Eval Case、应用修改并执行测试；
- 生成 HTML 报告并检查关键字段。

### 9.4 性能测试

- 1 万、10 万、100 万 Span 的写入吞吐和查询延迟；
- 1、8、32 个并发工具任务；
- Recorder 队列积压和丢弃策略；
- 开关 AgentLens 的 A/B 运行开销。

## 10. 八周里程碑

| 周次 | 工作内容 | 可演示结果 |
|---|---|---|
| 第 1 周 | 基线、需求、Trace Schema、隐私模型 | 架构文档与基线报告 |
| 第 2 周 | Bus、Context、Recorder、SQLite | CLI 查询一条结构化 Trace |
| 第 3 周 | Turn/Step/Model/Tool 插桩 | 完整 Span Tree |
| 第 4 周 | Approval、Compaction、Subagent、历史导入 | 跨 Agent Trace 与旧会话导入 |
| 第 5 周 | 6～8 条诊断规则、故障注入集 | 自动 Findings 与规则评测 |
| 第 6 周 | CLI Compare、Vis 页面 | 两次运行可视化对比 |
| 第 7 周 | Eval Runner、SWE-bench 适配、报告 | 固定子集 A/B 报告 |
| 第 8 周 | 性能优化、用户实验、文档与 Demo | 最终数据、视频和简历材料 |

如果时间只有 4 周，应砍掉 Terminal-Bench、OTLP、实时更新和复杂前端，保留 TraceStore、6 条
规则、CLI Compare、30 个 SWE-bench 任务以及完整实验报告。

## 11. 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| 已有 Vis 让项目显得只是改 UI | 项目创新性不足 | 核心放在层级 Span、自动诊断与评测闭环 |
| 模型费用过高 | 无法重复实验 | 固定小型开发集，最终阶段再扩大 |
| Docker/ARM 环境不稳定 | 大量 infra error | 远程 x86_64、缓存镜像、单独统计基础设施失败 |
| 规则只适配 Kimi CLI | 泛化性差 | 导入公共 SWE-bench 轨迹和 Terminal-Bench 验证 |
| 诊断没有可靠标签 | F1 不可信 | 故障注入提供精确标签，真实轨迹人工双标一部分 |
| 采集影响主循环 | 用户体验下降 | 有界队列、批量异步写、失败降级、性能验收 |
| 原始轨迹泄漏代码或密钥 | 安全风险 | 默认元数据模式、脱敏、opt-in 内容采集 |
| 同时改太多 Agent 能力 | 无法归因收益 | 每次实验只改变一个变量，保存完整运行配置 |

## 12. 最终交付物

- 可运行的 AgentLens 代码和自动化测试；
- Trace Schema 与隐私设计文档；
- `kimi lens` CLI；
- 集成进 `kimi vis` 的诊断和对比页面；
- AgentLens-Fault 数据集及生成脚本；
- 至少一个公开 Benchmark 适配器；
- baseline/candidate 的可复现实验配置；
- JSON、HTML 实验报告；
- 2～3 分钟演示视频；
- 一篇技术文章和一张架构图；
- 简历文案中的所有数字对应到公开报告或脚本输出。

## 13. 秋招项目描述文案

### 13.1 项目名称

**AgentLens — 面向 Coding Agent 的本地可观测、故障诊断与评测平台**

英文可写：

**AgentLens — A Local-first Observability, Diagnosis and Evaluation Platform for Coding Agents**

### 13.2 一句话介绍

基于开源 Coding Agent Runtime，设计层级 Trace、自动失败归因和可重复评测系统，帮助开发者
定位模型与工具执行链路中的失败根因，并量化 Agent 优化对成功率、Token 和耗时的影响。

### 13.3 开发中可使用的简历版本

> 独立设计并开发 AgentLens，在 Kimi Code CLI 的 Agent 主循环、工具执行、上下文压缩、审批
> 与子 Agent 链路中引入本地层级 Trace；基于 SQLite 构建异步批量存储与查询，并实现重复工具
> 调用、重试风暴、无进展循环等可解释诊断规则。搭建隔离式 Eval Runner，对接 SWE-bench，
> 支持同任务多版本 Agent 的成功率、Token、耗时和执行路径对比。

这个版本不包含未验证的数字，适合项目仍在开发时使用。

### 13.4 完成实验后的量化简历模板

只能把方括号替换为真实实验结果：

- 基于 Kimi Code CLI 构建 Coding Agent 可观测平台，统一采集 Turn、LLM、Tool、Approval、
  Compaction 与 Subagent 的父子 Span；采用 `asyncio.Queue + SQLite WAL` 批量落盘，在
  `[N]` 万 Span 压测下实现 P95 查询延迟 `[X] ms`，主任务额外耗时低于 `[Y]%`。
- 设计 `[N]` 类确定性故障规则和 `[M]` 条可控故障轨迹，在冻结测试集上实现 Macro-F1
  `[X]`、根因 Span Top-3 命中率 `[Y]%`，将用户实验中的中位故障定位时间降低 `[Z]%`。
- 搭建基于容器隔离的 Agent Eval Runner，对接 SWE-bench `[Lite/Verified]`，支持 baseline 与
  candidate 成对实验及 HTML 报告；根据诊断结果优化 `[重复调用/重试/上下文]` 策略，使无效
  工具调用降低 `[X]%`、Token 消耗降低 `[Y]%`，任务成功率 `[保持不降/提升 Z 个百分点]`。
- 实现默认脱敏与可配置数据保留机制，对 Prompt、工具参数、路径和凭证进行字段级保护；通过
  `[N]` 类敏感信息测试，原始敏感内容落盘泄漏率为 `0`。

### 13.5 面试时的 60 秒介绍

> 我做的项目叫 AgentLens，解决 Coding Agent 失败后难以定位和难以量化优化效果的问题。
> 原项目已经能展示 Wire 日志，但它是扁平事件，无法准确表达模型请求、并行工具和子 Agent
> 之间的因果关系，也没有自动诊断和同任务对比。我设计了一套本地层级 Trace，把 Turn、Step、
> LLM、Tool、Approval 和 Compaction 建模成父子 Span，通过异步队列批量写入 SQLite，再用
> 可解释规则识别重复调用、重试风暴和无进展循环。之后我做了隔离式 Eval Runner，在固定
> SWE-bench 子集上成对运行改造前后的 Agent，不只比较成功率，还比较 Token、工具调用和关键
> 路径。项目最重要的点是形成了“发现问题—修改策略—回归验证”的完整工程闭环。

### 13.6 STAR 表达

**Situation**：Coding Agent 执行真实代码任务时会经历多轮模型请求、工具调用和上下文压缩，
失败轨迹长且具有随机性，仅凭终端日志难以复现和定位。

**Task**：建立低侵入、可解释、可量化的观测与评测系统，既不能显著拖慢 Agent，也不能泄漏
用户代码和凭证。

**Action**：设计 ContextVar 传播的层级 Span；使用有界异步队列和 SQLite WAL 批量持久化；
实现规则化失败诊断、Trace Diff 和数据集 Runner；使用故障注入集评价诊断准确率，并在公开
软件工程任务上进行成对 A/B 实验。

**Result**：填写最终测得的性能开销、诊断 F1、定位时间下降、Token/工具调用下降及成功率变化。

### 13.7 高频追问准备

**为什么不用现有日志？**

日志面向人阅读，缺少稳定 Schema 和父子关系；并行任务中相邻日志不等于调用关系。Span
模型可以稳定计算耗时、关键路径和上下游影响，并支持机器分析。

**为什么不直接接 OpenTelemetry？**

OpenTelemetry 适合传输和通用 Trace 语义，但 Coding Agent 还需要 Token、Compaction、Tool
Result、任务补丁和评测结果等领域模型。AgentLens 先定义领域 Schema，之后可以导出 OTLP，
而不是让通用标准决定所有内部模型。

**为什么选 SQLite？**

项目是单机 CLI，本地优先且写入主体通常只有一个进程。SQLite 无需部署、支持事务和索引，
WAL 可兼顾写入与查询，复杂度低于引入独立数据库。若未来变成团队服务，再抽象 Store 接口。

**如何判断 NoProgress？**

不只看文件是否变化，而是组合 Git diff 指纹、测试失败集合、新证据、计划状态和验收结果。
阈值由冻结开发集调整，并在独立测试集报告误报率。

**为什么诊断规则不用 LLM？**

首期目标是可复现和可验证。确定性规则能给出明确证据，也便于计算 Precision/Recall。LLM
可以总结 Finding，但不作为唯一裁判；复杂语义诊断可在后续作为对照实验。

**如何证明 AgentLens 真的有用？**

分三层证明：采集完整性和性能开销；带 ground truth 的诊断准确率；真实用户定位根因的耗时。
最后再根据诊断结果优化一个 Agent 策略，在相同公开任务上做成对实验验证闭环。

**怎样处理 Agent 随机性？**

固定模型版本、Prompt、预算、工具和环境；任务顺序随机化；每个 Case 重复运行；报告置信区间
和完整失败分布，不用单次 Demo 代替统计结果。

## 14. 推荐实施顺序

如果立刻开始，最优先的第一条纵向链路是：

1. 为 Turn、Step、Model 和 Tool 建立 Span；
2. 写入 SQLite；
3. 用 CLI 展示一棵 Trace Tree；
4. 实现 `RepeatedToolLoop` 一条规则；
5. 注入一个重复调用故障并自动定位；
6. 在现有 Vis 中展示该 Finding。

这条链路完成后，项目就已经有一个可演示的最小闭环。后续再横向扩展更多 Span、规则和数据集，
不会出现“做了很多底层模块，但直到最后都无法演示”的问题。
