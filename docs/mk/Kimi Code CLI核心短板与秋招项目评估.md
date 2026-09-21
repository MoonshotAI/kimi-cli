# Kimi Code CLI 核心短板与秋招项目评估

本文基于当前仓库源码评估五项能力。结论中的“存在”指生产级能力确实缺失，而不是项目完全没有相关基础设施。

## 结论概览

| 问题 | 判断 | 当前基础 |
| --- | --- | --- |
| 无持久化跨会话记忆 | 存在，但已有单会话持久化 | 会话和子 Agent 上下文可落盘、恢复 |
| 无 OS 级沙箱 | 明确存在 | 只有审批和提示词约束 |
| 子 Agent 不支持嵌套或递归 | 明确存在 | Root Agent 可创建和恢复子 Agent |
| 无多 Agent 协作编排 | 部分存在 | 支持多个后台 Agent 并发，但缺少编排层 |
| 缺少 repo map 级代码理解 | 明确存在 | 依赖目录、Git 信息、`Glob`、`Grep` 和文件读取 |

## 1. 持久化跨会话记忆

**是否存在及现状：存在，但需要区分“会话恢复”和“跨会话记忆”。** 当前 `Session` 将消息历史、Wire 日志和状态写入特定 `session_id` 的目录，可以恢复原会话；子 Agent 也在当前会话下保存独立的 `context.jsonl`。但是，新会话不会自动检索其他会话中的用户偏好、项目知识、历史决策或失败经验。仓库中也没有长期记忆模型、检索策略、向量或关键词索引以及记忆淘汰机制。

**生产影响：** 长期项目中，Agent 会重复探索仓库、重复询问约束，并可能做出与历史决策冲突的修改。直接把全部历史会话塞入上下文又会增加 Token 成本、隐私暴露和错误召回风险，因此生产实现必须包含作用域、来源、过期、删除和可解释引用，而不只是增加一个数据库。

**代码证据：** [`Session.dir`](../../src/kimi_cli/session.py#L48) 将数据限定在当前会话目录，[`Session.find`](../../src/kimi_cli/session.py#L183) 也要求使用明确的 `session_id` 恢复；[`SubagentStore.root`](../../src/kimi_cli/subagents/store.py#L68) 位于 `session.dir/subagents`。这些代码证明已有持久化，但其边界仍是单个会话。

## 2. OS 级沙箱

**是否存在及现状：明确存在。** 默认系统提示词直接声明运行环境不在沙箱中，文件和 Shell 操作会立即影响用户系统。当前安全边界主要由提示词、工作区路径检查和审批流程组成，它们属于应用层策略，不等价于进程、文件系统、网络或系统调用隔离。

**生产影响：** Prompt injection、模型误判或工具缺陷都可能造成越权读写、凭据泄漏、依赖投毒和破坏性命令执行。审批能够降低风险，但用户可能误批，高频审批也容易导致“审批疲劳”。面向不可信仓库或自动化执行时，没有 OS 级隔离会显著限制产品可部署范围。

**代码证据：** 默认提示词明确写有 `The operating environment is not in a sandbox`，见 [`system.md`](../../src/kimi_cli/agents/default/system.md#L73)。后台 Shell 任务通过本机 `subprocess.Popen` 启动，见 [`BackgroundTaskManager._launch_worker`](../../src/kimi_cli/background/manager.py#L125)，未建立容器、namespace、seccomp 或同类隔离边界。

## 3. 子 Agent 嵌套与递归

**是否存在及现状：明确存在，而且是主动设置的硬限制。** 只有 Root Agent 能调用 `Agent` 工具；子 Agent 调用时会直接返回错误。默认 `coder`、`explore` 等子 Agent 规格也排除了 `Agent` 工具，并将 `subagents` 配置留空。

**生产影响：** Root Agent 必须承担所有任务拆分和结果汇总，复杂任务无法形成“负责人 → 专项 Agent → 执行 Agent”的层级，Root 的上下文和调度压力会快速增大。不过，该限制也避免无限递归、资源失控和审批来源混乱；解除限制时必须同时加入最大深度、总并发、Token/时间预算、父子取消传播和权限继承规则。

**代码证据：** [`AgentTool.__call__`](../../src/kimi_cli/tools/agent/__init__.py#L119) 检查 `runtime.role != "root"` 后返回 `Subagents cannot launch other subagents.`；[`coder.yaml`](../../src/kimi_cli/agents/default/coder.yaml#L19) 明确排除 `kimi_cli.tools.agent:Agent`。

## 4. 多 Agent 协作编排

**是否存在及现状：部分存在。** Root Agent 可以创建多个前台或后台子 Agent，系统默认允许最多 4 个后台任务，并支持查询、停止和完成通知。因此“完全没有多 Agent”并不准确。真正缺少的是独立编排运行时：任务模型没有依赖边、优先级、共享工件、Agent 间消息、自动重试、汇总节点或一致的预算调度，协作主要依赖 Root LLM 临时发起任务并人工式消费结果。

**生产影响：** 简单并发可以加快搜索，但复杂工作流难以保证执行顺序、故障恢复和结果收敛。多个 Agent 可能重复读取或同时修改同一文件；Root 中断后，未消费结果、资源泄漏和状态不一致也更难处理。缺少结构化编排还会降低可观测性，使成功率和成本难以稳定评测。

**代码证据：** [`TaskSpec`](../../src/kimi_cli/background/models.py#L28) 只记录任务类型、状态、所有者和负载，没有依赖或协作关系；[`create_agent_task`](../../src/kimi_cli/background/manager.py#L209) 直接使用 `asyncio.create_task` 启动独立 Agent；[`BackgroundConfig`](../../src/kimi_cli/config.py#L99) 只提供并发数、超时和轮询等运行限制。这是一套后台任务管理能力，而不是 DAG 或工作流编排器。

## 5. Repo map 级代码理解

**是否存在及现状：明确存在。** 当前 Agent 依靠启动时目录列表、`Glob`、`Grep`、`ReadFile` 和探索型子 Agent 按需理解代码。Explore Agent 额外获得远端、分支、脏文件和最近提交等 Git 上下文，但没有增量 AST 索引、符号表、引用/调用关系图或面向仓库的摘要 map。

**生产影响：** 在大型仓库中，Agent 需要反复搜索和读取文件，导致首轮定位变慢、Token 消耗升高，并更容易漏掉动态入口、跨语言引用和间接调用。代码变化后若没有增量更新和失效策略，即使增加索引也可能向模型提供过期事实，因此生产实现还需评测索引延迟、召回率和更新成本。

**代码证据：** [`collect_git_context`](../../src/kimi_cli/subagents/git_context.py#L18) 只采集仓库元信息；[`explore.yaml`](../../src/kimi_cli/agents/default/explore.yaml) 提供的是 Shell、文件搜索和读取工具。虽然 `uv.lock` 中存在 `tree-sitter`，但它来自 Python 3.14+ 的 [`batrachian-toad`](../../pyproject.toml#L30) 终端依赖链；在 `src/`、`packages/` 和 `tests/` 中没有 `tree_sitter` 导入或 repo map 实现。

## 秋招项目质量判断

**选题合格，而且上限很高；但“同时补上五个功能”本身不能证明项目质量。** 五项能力横跨安全、分布式调度、知识检索和程序分析，单人短周期全部实现容易形成五个浅 Demo，反而暴露范围控制和工程完成度不足。

更适合作为秋招项目的方式，是选择一条完整主线：例如实现“安全多 Agent 运行时”，以受控递归、任务 DAG 和预算/取消传播为核心，再增加一种本地沙箱后端；或者实现“仓库智能层”，以 Tree-sitter 增量 repo map 为核心，并用跨会话记忆保存经过验证的项目决策。其余能力只做接口预留。

达到“质量合格”至少应满足：

- 接入现有 `Runtime`、`Session`、审批、Wire 和子 Agent 生命周期，而不是旁路脚本；
- 有单元测试、端到端测试以及崩溃恢复、并发冲突、越权或索引失效测试；
- 有量化对比，例如任务成功率、Token、定位耗时、沙箱逃逸面或调度吞吐；
- 有架构说明、威胁模型、数据迁移和兼容策略，并能演示真实失败场景。

如果只添加 API、数据表和演示页面，质量不合格；如果完整解决其中一个困难问题并给出可靠评测，已经是合格且有辨识度的秋招项目；若能完成同一主线下两个相互支撑的能力并形成可合并的上游改动，则可以达到优秀水平。
