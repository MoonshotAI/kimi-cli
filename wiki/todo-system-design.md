# Todo 系统设计文档

## 概述

Todo 系统是 Kimi CLI 中的核心任务管理工具，旨在帮助 AI 代理在复杂任务执行过程中进行任务分解、进度跟踪和状态管理。该系统通过 `SetTodoList` 工具实现，为代理提供了结构化的任务管理能力。

## 设计目标

### 1. 任务分解与追踪
- 将复杂任务分解为可管理的子任务
- 实时跟踪任务进度状态
- 提供清晰的任务完成路径

### 2. 上下文管理
- 在长对话中保持任务上下文
- 避免任务遗漏和重复
- 提供任务优先级管理

### 3. 用户体验优化
- 直观的任务状态显示
- 鼓励用户继续完成任务
- 避免过度细粒度的任务管理

## 核心架构

### 数据模型

```python
class Todo(BaseModel):
    title: str = Field(description="The title of the todo", min_length=1)
    status: Literal["Pending", "In Progress", "Done"] = Field(description="The status of the todo")

class Params(BaseModel):
    todos: list[Todo] = Field(description="The updated todo list")
```

### 状态定义

| 状态 | 描述 | 显示格式 |
|------|------|----------|
| `Pending` | 待处理 | `- 任务标题 [Pending]` |
| `In Progress` | 进行中 | `- **任务标题** [In Progress]` |
| `Done` | 已完成 | `- ~~任务标题~~ [Done]` |

## 实现细节

### 核心工具类

```python
class SetTodoList(CallableTool2[Params]):
    name: str = "SetTodoList"
    description: str = "Update the whole todo list"
    
    async def __call__(self, params: Params) -> ToolReturnValue:
        # 渲染任务列表为 Markdown 格式
        rendered = self._render_todos(params.todos)
        return ToolOk(output="", message="Todo list updated", brief=rendered)
```

### 渲染逻辑

任务列表根据不同状态采用不同的 Markdown 格式：

- **已完成任务**: 使用删除线 `~~text~~`
- **进行中任务**: 使用粗体 `**text**`
- **待处理任务**: 普通文本

## 使用场景

### 适用场景

1. **多步骤复杂任务**
   ```
   - [ ] 分析项目结构
   - [ ] 设计数据库模式
   - [ ] 实现 API 接口
   - [ ] 编写单元测试
   - [ ] 部署到测试环境
   ```

2. **多个并行任务**
   ```
   - [ ] 修复登录页面 Bug
   - [ ] 优化数据库查询性能
   - [ ] 更新 API 文档
   ```

3. **长期项目管理**
   ```
   - [x] 需求分析
   - [x] 技术选型
   - [ ] 系统设计
   - [ ] 开发实现
   - [ ] 测试验证
   - [ ] 部署上线
   ```

### 不适用场景

1. **简单问答任务**
   - "Python 中如何定义函数？"
   - "什么是 REST API？"

2. **单步操作任务**
   - "修复 test_example.py 中的语法错误"
   - "将文件 A 复制到目录 B"

3. **机械性操作**
   - "将配置文件中的端口从 8080 改为 3000"
   - "创建一个新的 Python 文件"

## 最佳实践

### 1. 任务粒度控制

**推荐粒度**:
- 每个任务应该在 15-60 分钟内完成
- 任务应该有明确的完成标准
- 避免过于细粒度的分解

**示例**:
```
✅ 好的分解:
- [ ] 实现用户认证模块
- [ ] 设计数据库表结构
- [ ] 编写 API 文档

❌ 过细分解:
- [ ] 创建 auth.py 文件
- [ ] 定义 User 模型
- [ ] 实现 login 函数
- [ ] 实现 register 函数
```

### 2. 状态管理策略

**状态转换原则**:
- 一次只专注一个任务的 `In Progress` 状态
- 完成任务后立即更新状态为 `Done`
- 根据实际情况调整 `Pending` 任务的优先级

### 3. 任务描述规范

**好的任务描述**:
- 使用动词开头的明确描述
- 包含具体的交付物要求
- 避免模糊的表述

```
✅ 好的描述:
- [ ] 实现用户登录 API 接口
- [ ] 编写登录功能的单元测试
- [ ] 更新 API 文档添加登录接口

❌ 模糊描述:
- [ ] 登录功能
- [ ] 测试
- [ ] 文档
```

## 集成与扩展

### ACP 模式集成

在 Agent Client Protocol (ACP) 模式下，Todo 列表会自动转换为计划更新：

```python
status_map = {
    "pending": "pending",
    "in progress": "in_progress", 
    "done": "completed"
}
```

### 与其他工具的协作

Todo 系统与以下工具紧密协作：
- **Task 工具**: 子任务委托
- **Think 工具**: 任务规划和反思
- **File 工具**: 文档和代码实现
- **Bash 工具**: 系统操作和部署

## 性能考虑

### 1. 上下文管理
- Todo 列表长度建议控制在 10-20 项以内
- 过长的列表会影响上下文窗口使用效率
- 定期清理已完成的任务

### 2. 更新频率
- 避免过于频繁的 Todo 列表更新
- 在关键里程碑时进行状态更新
- 批量处理多个状态变更

## 错误处理

### 常见错误场景

1. **空任务列表**
   ```python
   # 处理逻辑：忽略空列表更新
   if not todos:
       logger.warning("Empty todo list provided")
       return
   ```

2. **无效任务状态**
   ```python
   # 自动修正无效状态为 "Pending"
   if todo.status not in VALID_STATUSES:
       todo.status = "Pending"
   ```

3. **重复任务标题**
   ```python
   # 合并重复任务，保留最新的状态
   seen_titles = set()
   unique_todos = []
   for todo in todos:
       if todo.title not in seen_titles:
           unique_todos.append(todo)
           seen_titles.add(todo.title)
   ```

## 监控与调试

### 1. 日志记录
- 记录 Todo 列表的创建和更新
- 跟踪任务状态变更历史
- 监控异常情况

### 2. 调试命令
```bash
# 查看 Todo 工具的调用历史
grep "SetTodoList" ~/.kimi/logs/kimi.log

# 检查会话中的 Todo 使用情况
grep -A 5 -B 5 "todo" ~/.kimi/sessions/*/history.jsonl
```

## 未来扩展计划

### 1. 增强功能
- 任务优先级支持
- 任务依赖关系
- 任务标签和分类
- 任务时间估算

### 2. 可视化改进
- 任务进度图表
- 甘特图视图
- 燃尽图支持

### 3. 协作功能
- 多用户任务分配
- 任务评论系统
- 审核工作流

## 总结

Todo 系统作为 Kimi CLI 的核心任务管理工具，在提高 AI 代理的工作效率和任务完成质量方面发挥着重要作用。通过合理的使用和持续的优化，该系统将继续为用户提供更强大的任务管理能力。

---

**文档版本**: 1.0  
**最后更新**: 2025-01-15  
**维护团队**: Kimi CLI 开发团队
