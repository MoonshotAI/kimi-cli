# Kimi Code CLI 秋招简历项目说明

> 使用说明：本文给出可直接用于秋招简历、项目介绍和面试陈述的文本。当前仓库已经具备 CLI Agent 主循环、会话持久化、子 Agent、后台任务、审批和 Wire 事件系统；“项目知识层”和“Agent Teams”属于本次拟开发能力。未完成开发和评测前，不要把规划写成已上线成果。

## 1. 项目定位

### 推荐项目名

**Kimi Code CLI：具备持久化项目知识与多 Agent Teams 编排能力的开源 Coding Agent**

英文可写：

**Kimi Code CLI — Coding Agent with Persistent Project Knowledge and Multi-Agent Team Orchestration**

### 一句话介绍

基于 Python、asyncio 和事件驱动架构，为开源 Coding Agent 构建项目级知识层与多 Agent Teams 编排运行时，使 Agent 能够复用跨会话工程知识，并以可恢复、可观测、受预算约束的方式协同完成复杂仓库任务。

### 项目价值

这个项目解决两类互相放大的问题：

- Coding Agent 每次进入仓库都要重复搜索代码，且难以复用历史架构决策；
- 多个 Agent 虽然可以并发执行，但缺少依赖、消息、共享工件、冲突控制和失败恢复。

项目将二者组合为一条完整主线：知识层负责提供“代码现在是什么样、过去为什么这样设计”，Agent Teams 负责把复杂目标拆成有依赖的任务并组织多个 Agent 消费同一份可信知识。

```text
项目知识层：Repo Intelligence + Persistent Memory
                         ↓ Context Pack
协作执行层：Team Lead + Teammates + Task DAG + Mailbox
                         ↓
运行时基础：Session + Subagent + Background + Approval + Wire
```

## 2. 简历可直接使用版本

### 2.1 开发完成后的推荐版本

**Kimi Code CLI｜开源 Coding Agent 项目｜核心开发者**  
`Python` `asyncio` `Pydantic` `SQLite/FTS5` `Tree-sitter` `Typer` `Git` `pytest`

- 面向大型代码仓库设计并实现统一项目知识层，使用 Tree-sitter 构建 Python 符号、引用与模块依赖的增量索引，以 SQLite/FTS5 持久化架构决策、工程约束和验证经验，并通过 Git commit、blob hash 与符号存在性完成记忆失效检测。
- 在 Agent 推理前实现知识查询编排与临时 Context Pack 注入，支持代码事实和历史记忆的并行召回、去重、冲突标记、来源追踪及 Token 预算控制，避免将易过期 Repo 快照永久写入会话历史。
- 基于现有 Subagent、BackgroundTaskManager、ApprovalRuntime 和 Wire 事件协议实现 Agent Teams，建立 Team/Member/Task DAG、Mailbox、Artifact、预算与取消传播模型，支持并行只读探索、依赖就绪调度、成员间消息和会话级崩溃恢复。
- 建立可重复的 baseline/candidate 评测集，围绕首次代码定位耗时、探索工具调用次数、输入 Token、任务成功率、记忆误用率和并发冲突率进行对比；将实测结果填写为“定位耗时下降 **[X%]**、工具调用下降 **[Y%]**、Token 下降 **[Z%]**、成功率提升 **[N] 个百分点**”。

> 方括号中的指标必须来自固定任务集的实际实验，不可用预期值代替。

### 2.2 MVP 完成、尚未完成完整评测时

**Kimi Code CLI｜开源 Coding Agent 项目｜核心开发者**  
`Python` `asyncio` `SQLite/FTS5` `Tree-sitter` `Multi-Agent` `pytest`

- 基于 Kimi Code CLI 的 Runtime、Session 和 KimiSoul 主循环，落地项目级 Repo Intelligence 与 Persistent Memory 原型，实现 Python 符号增量索引、四类工程记忆及带来源的上下文召回。
- 设计 Agent Teams 领域模型和持久化状态机，复用现有子 Agent、后台任务、审批与 Wire 基础设施，实现任务依赖调度、成员消息、共享工件索引、预算限制和取消传播。
- 针对分支切换、代码删除、过期记忆、Agent 异常退出、依赖失败和并发写冲突补充单元与端到端测试，并建设可复现的效果评测脚本。

### 2.3 目前仅完成方案设计时

如果代码尚未实现，只能使用以下表述：

**Kimi Code CLI｜开源 Coding Agent 架构研究与功能设计**

- 阅读并梳理约 6.6 万行 Python 运行时代码与约 6.4 万行测试代码，完成 CLI 入口、Agent 主循环、上下文持久化、子 Agent、后台任务、审批和 Wire 事件链路的代码级调研。
- 针对跨会话知识缺失和多 Agent 协作编排不足，设计“Repo Intelligence + Persistent Memory + Agent Teams”方案，给出数据模型、接入点、状态机、测试矩阵、评测指标和分阶段开发计划。

这一版本可以说明分析与设计能力，但含金量明显低于可运行实现。秋招前应至少完成知识层闭环或 Agent Teams 闭环中的一个，并给出真实评测。

## 3. 个人贡献应该怎样讲

推荐把个人贡献归纳为三个层次，而不是罗列功能名。

### 3.1 架构层：建立“知识平面 + 协作平面”

- 知识平面把当前代码事实与历史工程决策分开存储，通过统一编排器合并；
- 协作平面把多个独立子 Agent 升级为有任务依赖、消息和共享工件的团队；
- 两个平面共同接入既有 Runtime、Session、Approval 和 Wire，不另建旁路 Agent 系统。

可用于面试的核心表达：

> 我没有简单加入向量数据库或批量启动多个 Agent，而是先划清事实、记忆、编排和执行的边界。代码索引只保存可验证的当前事实，长期记忆保存决策和经验，Team Scheduler 只处理任务状态与资源约束，LLM 负责语义判断但不充当唯一状态机。

### 3.2 工程层：解决可恢复性和一致性

- 通过内容 hash、Git blob 和符号引用判断索引与记忆是否过期；
- 通过 SQLite 事务或原子写避免并发状态损坏；
- 通过显式任务状态机、租约和取消传播处理成员异常；
- 通过单写者策略或隔离 worktree 避免多个写 Agent 直接竞争同一文件；
- 通过审批来源绑定将高风险操作追溯到具体 team、task 和 agent。

### 3.3 效果层：用实验回答“是否真的更好”

不要只展示功能可以运行。应在固定仓库、固定任务、固定模型和固定预算下，对比：

| 指标 | Baseline | Candidate | 目标解释 |
| --- | ---: | ---: | --- |
| 首次定位正确文件耗时 | `[ ]` | `[ ]` | 知识层是否减少盲目探索 |
| Grep/ReadFile 调用数 | `[ ]` | `[ ]` | Repo map 是否减少重复读取 |
| 输入 Token | `[ ]` | `[ ]` | Context Pack 是否节省上下文 |
| 最终任务成功率 | `[ ]` | `[ ]` | 优化不能只降低成本 |
| 过期记忆误用率 | `[ ]` | `[ ]` | 失效机制是否可靠 |
| Team 关键路径耗时 | `[ ]` | `[ ]` | 并行是否真正缩短交付时间 |
| 重复工作率 | `[ ]` | `[ ]` | 消息和任务分配是否有效 |
| 并发写冲突率 | `[ ]` | `[ ]` | 协作安全性是否达标 |

## 4. 技术亮点与证据

| 简历亮点 | 当前可复用基础 | 拟开发成果的证据位置 |
| --- | --- | --- |
| 异步 Agent 运行时 | `src/kimi_cli/soul/kimisoul.py` | 新增知识召回和 Team Scheduler 的集成测试 |
| 会话与子 Agent 持久化 | `src/kimi_cli/session.py`、`src/kimi_cli/subagents/store.py` | 项目知识数据库、team 状态与恢复测试 |
| 多 Agent 执行 | `src/kimi_cli/tools/agent/`、`src/kimi_cli/background/` | DAG 调度、消息、预算和取消传播测试 |
| 安全审批 | `src/kimi_cli/approval_runtime/` | team/task/agent 来源追踪和权限收敛测试 |
| 事件驱动 UI | `src/kimi_cli/wire/`、`src/kimi_cli/ui/` | Team/Knowledge Wire 事件与回放兼容测试 |
| Repo Intelligence | 当前仅有 `src/kimi_cli/subagents/git_context.py` | Tree-sitter 索引、增量更新、查询正确性测试 |
| 动态上下文 | `src/kimi_cli/soul/dynamic_injection.py` | 临时注入语义、Token 预算和恢复不重复测试 |

仓库规模仅可作为复杂度背景，不应作为个人成果。截至本文调研快照，`src/` 与 `packages/` 中 Python 代码约 6.6 万行，`tests/` 与 `tests_ai/` 中 Python 测试约 6.4 万行；简历中应明确自己修改的模块、提交或 PR，而不是暗示整个仓库由个人完成。

## 5. 30 秒与 2 分钟面试介绍

### 30 秒版本

> 我在 Kimi Code CLI 上做的是面向长期仓库任务的知识与协作增强。现有系统能恢复单次会话，也能并发启动子 Agent，但新会话不会复用项目决策，多个 Agent 之间也没有结构化协作。我设计并实现项目知识层，用 Tree-sitter、SQLite FTS5 和 Git 版本信息提供可追溯、可失效的 Context Pack；同时在现有子 Agent、后台任务、审批和 Wire 之上增加 Agent Teams 的任务 DAG、消息、工件和预算调度。最后用固定任务集比较成功率、Token、定位耗时和冲突率，而不是只做功能 Demo。

### 2 分钟版本

> 我先从源码确认了两个边界。第一，Session 和 SubagentStore 虽然会保存 context.jsonl，但存储范围仍是单个会话，新会话无法检索历史决策。第二，Root Agent 可以启动多个前台或后台子 Agent，但 BackgroundTaskManager 管理的是独立任务，没有依赖图、成员消息、共享工件和一致的预算调度。
>
> 因此我把改造分成两个平面。知识平面中，Repo Intelligence 保存由 Tree-sitter 提取的符号和模块关系，Persistent Memory 保存决策、约束、偏好和验证经验，Knowledge Orchestrator 根据任务并行召回并检查 Git blob 和符号是否仍有效。协作平面中，Team Scheduler 管理 Team、Member 和 Task DAG，Mailbox 负责 Agent 间的结构化消息，Artifact Index 只保存工件元数据和引用，审批及取消继续复用原运行时。
>
> 最关键的工程取舍是没有把动态 Repo 信息永久写进会话，也没有一开始开放无限递归和多写者。首期采用临时 Context Pack、固定最大团队规模和单写者策略，先确保可恢复、可解释和可评测，再逐步增加向量召回或 worktree 隔离。

## 6. 高频追问与回答要点

### 为什么不用向量数据库？

MVP 的决策、约束和符号名称对关键词检索较友好，SQLite/FTS5 部署成本低、可离线、易迁移和调试。先建立召回基线，只有当真实任务证明语义召回不足时再引入 embedding，避免为了技术栈而增加复杂度。

### 为什么知识注入不能直接追加到 Context？

Repo 快照随 HEAD 和工作区变化。若永久追加到 `context.jsonl`，恢复会话时会重复加载旧快照，压缩后也难以判断哪些内容已失效。正确做法是在请求模型时临时合成 effective history，原始会话只保存用户、模型和工具的真实交互，另以 Wire 事件记录召回来源和成本。

### Agent Teams 与“并发启动多个子 Agent”有什么区别？

并发只解决同时运行；Teams 还要解决谁做什么、任务何时就绪、结果交给谁、失败如何传播、共享什么工件、谁可以写文件、预算是否超限以及重启后如何恢复。它本质上是一个受 LLM 驱动但由确定性状态机约束的协作运行时。

### 为什么首期不开放子 Agent 递归创建？

当前代码明确限制只有 Root Agent 能调用 `Agent`。直接取消限制会引入无限递归、并发爆炸、权限来源混乱和取消泄漏。首期由 Team Scheduler 统一创建成员，成员只能提交状态、消息和工件；等深度、配额和权限继承规则稳定后，再评估受控嵌套。

### 多个 Agent 同时修改文件怎么办？

MVP 使用单写者策略：探索和评审成员可并行，只有一个 coder 持有写租约。后续若需要多写者，使用独立 git worktree 执行，再由集成任务合并补丁；仅依靠提示词约定不能保证没有冲突。

### 记忆错误或过期怎么办？

每条代码相关记忆必须保存来源、commit、blob、符号和验证方式。召回时根据当前代码将其标为 valid、possibly_stale、stale 或 conflicted；低置信度和冲突记忆只能作为候选背景，不能成为强约束。

## 7. 项目展示建议

演示应选择一个真实仓库任务，展示同一任务的 baseline 与 candidate：

1. 第一次运行定位目标模块并完成修改，测试通过后沉淀一条架构决策；
2. 新会话再次提出相关任务，展示知识来源、代码引用和更少的探索调用；
3. 修改或删除被引用符号，展示旧记忆自动降级而不是继续误导 Agent；
4. 创建一个由 explore、coder、reviewer 组成的 team，展示任务依赖、消息、审批和工件；
5. 人为终止一个成员或制造写冲突，展示恢复、失败传播和诊断信息；
6. 输出前后指标报告和可复现命令。

最有说服力的材料包括：架构图、一次完整 Trace、SQLite schema、失败恢复测试、评测报告、提交记录和 PR 链接。

## 8. 简历真实性检查清单

提交简历前逐项确认：

- [ ] “实现”“优化”“提升”等动词均有代码、测试或实验结果支撑；
- [ ] 规划中的模块没有写成已经上线；
- [ ] 百分比使用固定任务集重复实验得到，并保留原始结果；
- [ ] 能指出每条简历 bullet 对应的源码路径、测试和提交；
- [ ] 能解释至少一个失败案例和一次设计取舍；
- [ ] 没有把整个开源仓库的代码量或 star 数当作个人贡献；
- [ ] 没有把应用层审批描述为 OS 级沙箱；
- [ ] 没有把现有独立后台 Agent 描述成已经具备完整 Teams 编排。

## 9. 推荐最终关键词

`Coding Agent`、`Multi-Agent System`、`Agent Orchestration`、`asyncio`、`Event-Driven Architecture`、`Tree-sitter`、`SQLite FTS5`、`Incremental Indexing`、`Persistent Memory`、`DAG Scheduling`、`Failure Recovery`、`Token Budget`、`Git-aware Invalidation`、`pytest`
