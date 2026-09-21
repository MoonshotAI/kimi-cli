# 项目知识与 Agent Teams 开发计划

> 状态：规划中  
> 目标：在复用现有 Runtime、Session、Subagent、Background、Approval 和 Wire 的前提下，完成项目级知识平面与确定性多 Agent 编排平面。  
> 使用方式：开发前确认当前里程碑，开发中勾选任务，完成后补充验证结果与关键链接。

## 1. 总体目标

### G1：项目级知识平面

- 增量索引 Python 文件、符号、引用和模块关系。
- 跨会话保存决策、约束、偏好和已验证经验。
- 检索时校验 Git、blob、文件和符号状态，识别过期或冲突记忆。
- 将有来源、受 Token 预算约束的 Context Pack 临时注入模型请求。

### G2：Agent Teams 编排平面

- 使用确定性状态机管理 Team、Member、Task DAG 和依赖传播。
- 复用现有子 Agent 与后台任务执行能力。
- 支持 Mailbox、Artifact、预算、取消、写租约和进程恢复。

### G3：工程质量与效果证明

- 覆盖索引、记忆失效、DAG 调度、故障恢复和并发冲突等测试。
- 使用固定任务集对比 baseline/candidate，所有效果数据均来自实测。

## 2. 范围与原则

- 首期只支持 Python、SQLite/FTS5 和单工作区单写者。
- 代码事实、历史记忆、协作状态分别存储；LLM 不承担数据库或状态机职责。
- Repo 快照只进入当前请求，不写入原始 `context.jsonl`。
- 所有检索结果必须可追溯；未经验证的候选记忆不得直接长期保存。
- 首期不做多语言、向量数据库、云端知识服务和多 worktree 并行写入。

## 3. 里程碑总览

| 里程碑 | 目标 | 主要交付物 | 状态 |
| --- | --- | --- | --- |
| M0 | 固化边界与评测基线 | 接入点说明、基线任务集、指标采集脚本 | 待开始 |
| M1 | 建立知识层基础设施 | 项目标识、SQLite Schema、统一模型与生命周期 | 待开始 |
| M2 | 完成 Repo Intelligence | Python 增量索引与最小查询 API | 待开始 |
| M3 | 完成 Persistent Memory | 四类记忆、FTS5、候选写入与失效校验 | 待开始 |
| M4 | 打通知识闭环 | Orchestrator、Context Pack、Wire 事件 | 待开始 |
| M5 | 完成 Teams 调度核心 | Team/Task DAG、状态机、任务派发 | 待开始 |
| M6 | 补齐协作与资源控制 | Mailbox、Artifact、预算、租约、取消传播 | 待开始 |
| M7 | 完成恢复与验收 | 状态恢复、完整测试矩阵、效果报告 | 待开始 |

## 4. 分步计划

### M0：边界与基线

- [ ] 复核 Runtime、KimiSoul、Context、Subagent、Background、Approval、Wire 的调用链和所有权。
- [ ] 明确新增模块接口、存储位置、配置项和错误降级策略。
- [ ] 选定固定仓库与任务集，记录当前定位耗时、工具调用、Token 和成功率。

完成标准：形成可复现 baseline；每个新增能力都有明确接入点，不复制现有执行链路。

### M1：知识层基础设施

- [ ] 建立 `knowledge/` 模块、稳定的 `project_id` 和统一查询结果模型。
- [ ] 设计 RepoIndex、MemoryStore 的 SQLite Schema、版本迁移和事务边界。
- [ ] 在 Runtime 中装配共享知识服务，并保证 Root/Subagent 共享服务但隔离对话上下文。
- [ ] 增加数据库损坏、服务不可用时的安全降级和基础单元测试。

完成标准：知识服务可创建、关闭、迁移和降级，不影响未启用该能力时的现有流程。

### M2：Repo Intelligence

- [ ] 使用 Tree-sitter 提取 Python 文件、类、函数、方法、签名、import、定义和引用。
- [ ] 基于内容 hash、commit、blob 和脏状态实现新增、修改、删除的增量刷新。
- [ ] 提供 `search_symbol`、`find_references`、`module_summary`、`related_files` 查询。
- [ ] 覆盖首次索引、单文件修改、删除、重命名、分支切换和并发刷新测试。

完成标准：索引结果带路径、范围和版本来源；变化文件能局部更新，查询失败不阻断 Agent。

### M3：Persistent Memory

- [ ] 实现 `decision`、`constraint`、`preference`、`lesson` 四类记忆及代码引用模型。
- [ ] 使用 FTS5 完成可解释检索，并过滤敏感信息、源码副本和低价值工具输出。
- [ ] 回合结束只生成候选记忆，通过测试、Git diff 或用户确认后再持久化。
- [ ] 根据文件、符号、commit 和 blob 标注 `valid`、`possibly_stale`、`stale`、`conflicted`。
- [ ] 覆盖跨会话召回、重复写入、过期、冲突和删除引用测试。

完成标准：记忆有来源、有验证状态、可失效；新会话能检索项目级历史知识。

### M4：Knowledge Orchestrator

- [ ] 根据任务类型规划 RepoIndex、MemoryStore 或双路查询，并行执行召回。
- [ ] 实现去重、时效校验、冲突标记、相关性排序和 Token 预算裁剪。
- [ ] 生成带来源的 Context Pack，仅加入本轮 `effective_history`。
- [ ] 通过 Wire 记录检索来源、状态、Token、耗时和降级原因。
- [ ] 对比 baseline，验证定位效率、探索调用和过期记忆误用情况。

完成标准：完成“召回—校验—临时注入—验证—候选记忆”的知识闭环，且不污染会话历史。

### M5：Agent Teams 调度核心

- [ ] 定义 Team、Member、TeamTask、Dependency 模型和合法状态迁移。
- [ ] 实现 DAG 环检测、就绪计算、依赖失败传播、并发限制和重试规则。
- [ ] 将就绪任务映射到现有 SubagentStore 与 BackgroundTaskManager。
- [ ] 扩展 Approval 来源和 Wire 事件，使任务可追踪到 team/task/agent。
- [ ] 覆盖环检测、就绪顺序、失败阻塞、超时、重复通知和审批取消测试。

完成标准：Scheduler 只负责编排，Agent 执行、审批和 UI 继续复用现有实现。

### M6：协作与资源控制

- [ ] 实现持久化 Mailbox，支持成员间结构化消息和消费状态。
- [ ] 实现 Artifact Index，记录工件引用、摘要、生产者和验证状态。
- [ ] 实现 Team/Task 分层预算的预留、结算和超限停止派发。
- [ ] 实现单写者租约、心跳、过期回收以及 Team 取消级联。
- [ ] 覆盖预算耗尽、成员丢失、租约回收和并发写冲突测试。

完成标准：成员能交换结果而无需全部回灌 Root 上下文；资源上限和写冲突由代码控制。

### M7：恢复、评测与交付

- [ ] 持久化 Team、DAG、Mailbox、Artifact、预算账本和租约。
- [ ] 实现重启后的 `load → reconcile → schedule`，处理失联任务和过期租约。
- [ ] 运行完整测试、格式化、静态检查及端到端冒烟测试。
- [ ] 使用固定任务集重复对比 baseline/candidate，保存原始 Trace 和失败样本。
- [ ] 更新用户文档、架构说明和简历材料，只陈述有代码与数据支撑的成果。

完成标准：异常退出后可安全恢复；核心指标有可复现实测结果；文档与仓库实现一致。

## 5. 验收指标

| 类别 | 指标 |
| --- | --- |
| 知识效率 | 首次定位正确文件耗时、`Grep`/`ReadFile` 调用数、输入 Token |
| 知识质量 | 召回准确率、过期记忆误用率、增量索引延迟 |
| 任务效果 | 最终任务成功率、测试通过率 |
| Teams 效率 | 关键路径耗时、重复工作率、预算使用 |
| Teams 安全 | 并发写冲突率、取消成功率、重启恢复成功率 |

## 6. 开发记录模板

每完成一个里程碑，在对应章节更新勾选状态，并追加一条简短记录：

```text
日期：YYYY-MM-DD
里程碑：M?
结果：完成 / 部分完成 / 阻塞
验证：测试命令、报告或 Trace 路径
关键决定：仅记录会影响后续开发的取舍
下一步：一个明确动作
```
