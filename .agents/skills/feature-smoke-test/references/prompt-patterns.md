# Prompt 模板

以下模板作为脚手架使用。运行前替换占位符。

## 单轮还是多轮

满足以下任一条件时使用多轮：

- 功能有状态
- 功能依赖时序或并发
- 功能需要审批、清理或恢复
- session 产物本身是证据的一部分
- 工具接口可能近期发生过变化

仅对无状态的窄范围检查使用单轮。

## 变量

起草 prompt 前填写以下字段：

- `<feature>` — 被测功能名称
- `<goal>` — 当前场景的目标
- `<source_paths>` — 需要阅读的源码路径
- `<constraints>` — 执行约束
- `<success_signals>` — 成功信号
- `<failure_signals>` — 失败信号
- `<artifact_paths>` — 需要检查的产物路径
- `<session_dir>` — session 目录路径

## 探索 prompt

```text
我要验证 <feature>。

先阅读这些文件并只总结当前真实对外接口，不要假设旧文档、旧 prompt 或旧 tool 名称仍然正确：
<source_paths>

然后给我一个最小 smoke test 计划，只包含：
1. happy path
2. 一个边界/异常场景
3. 一个清理、恢复或中断场景

每个场景都写清楚目标、预期信号和要检查的产物。
```

## 执行 prompt

```text
在当前 session 里只执行这个场景：<goal>

约束：
<constraints>

执行前先复述你将使用的工具或命令。执行时记录关键 task id、输出片段、文件路径和任何需要后续复盘的标识符。不要扩展到其他场景。
```

## 观察 prompt

```text
现在不要继续跑新的测试。

只读取并总结这次运行已经产生的状态和文件：
<artifact_paths>

请明确指出哪些证据支持了预期，哪些证据反驳了预期，哪些地方仍然不确定。
```

## 复盘 prompt

```text
请根据这个 session 目录复盘整个 smoke test：
<session_dir>

重点阅读 context.jsonl、wire.jsonl 和相关运行产物。输出：
1. 实际执行流程
2. 关键 tool 调用与结果
3. 与预期不一致的点
4. 最小复现步骤
```

## 兼容性校验 prompt

```text
在运行 smoke test 之前，先从提供的文档或代码中复述当前真实可用的工具及其准确名称。不要臆造旧版工具名。如果任务涉及状态或时序，将工作拆分为多轮而非一次性长回复。
```
