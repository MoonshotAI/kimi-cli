# Kimi Code CLI — 秋招项目简历

> **项目名称**：Kimi Code CLI：具备持久化项目知识与多 Agent Teams 编排能力的开源 Coding Agent  
> **角色**：核心开发者  
> **时间**：2025.06 — 至今  
> **关键词**：`Python` `asyncio` `SQLite/FTS5` `Tree-sitter` `Pydantic` `Typer` `Git` `pytest` `Multi-Agent` `Event-Driven`

---

## S — 背景 Situation

Kimi Code CLI 是一个终端里的 AI Coding Agent，具备异步主循环、会话持久化、子 Agent、后台任务、审批和事件驱动 UI 等能力。但在大型仓库长期开发场景中暴露出两个瓶颈：

- **知识断层**：每个新会话都要重新搜索代码，历史架构决策、工程约束和踩坑经验无法跨会话复用。
- **协作缺失**：虽能并发启动子 Agent，但缺乏任务依赖、消息通信、共享工件和失败恢复机制，多 Agent 各自为战。

> 📐 **代码规模背景**：运行时 Python ~6.6 万行，测试 ~6.4 万行（来自仓库调研快照，非个人产出）

---

## T — 任务 Task

在不另建旁路 Agent 系统的前提下，基于现有 Runtime 和 Session 基础设施，完成两项核心改造：

| 知识平面 | 协作平面 |
|----------|----------|
| 设计并实现统一项目知识层，让 Agent 能够增量索引代码结构、持久化工程记忆，并在推理前注入经过时效性校验的 Context Pack | 在现有子 Agent 和后台任务之上构建 Agent Teams 协作运行时，实现任务 DAG 编排、成员消息、共享工件、预算调度和崩溃恢复 |

---

## A — 行动 Action

### Phase 1：代码级调研与架构设计

- 阅读并梳理全部运行时代码（CLI 入口 → Agent 主循环 → Session 持久化 → 子 Agent → 后台任务 → 审批 → Wire 事件链路），建立完整调用链认知。
- 识别现有系统的边界与复用点：`KimiSoul` 主循环、`SubagentStore` 持久化、`BackgroundTaskManager` 调度、`ApprovalRuntime` 审批、`Wire` 事件流。
- 输出 **"Repo Intelligence + Persistent Memory + Agent Teams"** 方案设计，包含数据模型、接入点、状态机、测试矩阵、评测指标和分阶段开发计划。

### Phase 2：知识层原型实现

- 使用 **Tree-sitter** 构建 Python 符号、引用与模块依赖的增量索引，支持按 commit 跟踪代码变更。
- 以 **SQLite + FTS5** 持久化四类工程记忆：架构决策、工程约束、编码偏好、验证经验，每条记忆绑定来源 commit、blob hash 和符号引用。
- 实现 **Knowledge Orchestrator**：在 Agent 推理前并行召回代码事实和历史记忆，去重、冲突标记、来源追踪，按 Token 预算合成临时 Context Pack（不永久写入会话历史）。
- 基于 Git blob 和符号存在性实现记忆失效检测：召回时自动标记 `valid` / `possibly_stale` / `stale` / `conflicted`。

### Phase 3：Agent Teams 协作运行时

- 建立 **Team / Member / Task DAG** 领域模型与持久化状态机，复用现有 Subagent、BackgroundTaskManager 和 ApprovalRuntime 基础设施。
- 实现 **Mailbox** 消息系统，支持成员间结构化消息传递与事件驱动通知。
- 设计 **Artifact Index**，仅保存工件元数据与引用，避免冗余存储。
- 实现 **预算传播与取消级联**：超限或异常时沿任务依赖图向上传播取消信号。
- 采用**单写者策略**避免多 Agent 文件写冲突，后续预留 worktree 隔离扩展点。

### Phase 4：测试与质量保障

- 覆盖分支切换、代码删除、过期记忆、Agent 异常退出、依赖失败、并发写冲突等场景的单元测试和端到端测试。
- 建设可复现的效果评测脚本，固定仓库、固定任务、固定模型和固定预算下对比 baseline 和 candidate 的表现。

---

## R — 成果 Result

| 指标 | Baseline | Candidate | 解释 |
|------|:--------:|:---------:|------|
| 首次定位正确文件耗时 | — | — | 知识层是否减少盲目探索 |
| Grep / ReadFile 调用数 | — | — | Repo map 是否减少重复读取 |
| 输入 Token 消耗 | — | — | Context Pack 是否节省上下文 |
| 最终任务成功率 | — | — | 优化不能只降低成本 |
| 过期记忆误用率 | — | — | 失效机制是否可靠 |
| Team 关键路径耗时 | — | — | 并行是否真正缩短交付时间 |

> ⚠️ 评测指标需来自固定任务集的实际实验，不可用预期值代替。秋招前应至少完成知识层或 Agent Teams 闭环之一。

---

## 技术栈

| 类别 | 技术 |
|------|------|
| 语言 | Python、asyncio |
| 数据 | SQLite / FTS5 |
| 解析 | Tree-sitter |
| 框架 | Pydantic、Typer |
| 工具 | Git、pytest |
| 架构 | Event-Driven、Multi-Agent、DAG Scheduling、Token Budget |

---

## 关键代码位置

| 模块 | 路径 |
|------|------|
| Agent 主循环 | `src/kimi_cli/soul/kimisoul.py` |
| 会话持久化 | `src/kimi_cli/session.py` |
| 子 Agent 持久化 | `src/kimi_cli/subagents/store.py` |
| 多 Agent 执行 | `src/kimi_cli/tools/agent/` |
| 后台任务管理 | `src/kimi_cli/background/` |
| 安全审批 | `src/kimi_cli/approval_runtime/` |
| 事件驱动 UI | `src/kimi_cli/wire/` |

---

## 面试核心表达

> 我没有简单加入向量数据库或批量启动多个 Agent，而是先划清事实、记忆、编排和执行的边界。代码索引只保存可验证的当前事实，长期记忆保存决策和经验，Team Scheduler 只处理任务状态与资源约束，LLM 负责语义判断但不充当唯一状态机。

---

## 高频追问速答

**Q: 为什么不用向量数据库？**

MVP 的决策和符号名称对关键词检索较友好，SQLite/FTS5 部署零成本、可离线、易调试。先建立召回基线，语义召回不足时再引入 embedding。

**Q: 知识为什么不直接写进 Context？**

Repo 快照随 HEAD 变化，永久追加会导致旧快照重复加载且难以判废。正确做法是临时合成 effective history，原始会话只存真实交互。

**Q: Agent Teams 和并发子 Agent 有什么区别？**

并发只解决同时运行；Teams 还要解决任务分配、依赖就绪、结果路由、失败传播、工件共享、写权限、预算和恢复。本质上是 LLM 驱动 + 确定性状态机约束的协作运行时。

**Q: 多 Agent 写冲突怎么办？**

MVP 单写者策略：探索/评审可并行，仅一个 coder 持有写租约。后续引入 worktree 隔离 + 集成合并。

---

## 真实性检查清单

提交简历前逐项确认：

- [ ] "实现""优化""提升"等动词均有代码、测试或实验结果支撑
- [ ] 规划中的模块没有写成已经上线
- [ ] 百分比使用固定任务集重复实验得到，并保留原始结果
- [ ] 能指出每条简历 bullet 对应的源码路径、测试和提交
- [ ] 能解释至少一个失败案例和一次设计取舍
- [ ] 没有把整个开源仓库的代码量或 star 数当作个人贡献
- [ ] 没有把应用层审批描述为 OS 级沙箱
- [ ] 没有把现有独立后台 Agent 描述成已经具备完整 Teams 编排
