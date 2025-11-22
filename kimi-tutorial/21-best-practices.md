# 第 21 章：最佳实践

从头到尾构建 Agent 后，让我们总结最佳实践。

## 21.1 架构设计

### ✅ DO: 模块化设计

```python
# ✅ 好：每个模块职责清晰
agent/
  tools/      # 工具
  soul/       # 执行引擎
  ui/         # 界面
  config/     # 配置
```

### ❌ DON'T: 上帝类

```python
# ❌ 坏：一个类做所有事
class Agent:
    def run(self):
        # 1000+ 行代码...
```

## 21.2 提示词工程

### ✅ DO: 清晰的指令

```markdown
## Guidelines

1. Always read files before modifying them
2. Explain your reasoning
3. Ask for clarification when unsure
```

### ❌ DON'T: 模糊的指令

```markdown
Be helpful and do good things.
```

## 21.3 错误处理

### ✅ DO: 优雅降级

```python
try:
    result = await tool.execute(params)
except ToolError as e:
    # 告诉 Agent 发生了什么
    return f"工具失败: {e}. 请尝试其他方法。"
```

### ❌ DON'T: 崩溃

```python
result = await tool.execute(params)  # 可能抛出异常
```

## 21.4 安全

### ✅ DO: 权限最小化

```python
# 限制工作目录
kaos = LocalKaos(work_dir=project_dir)

# 工具只能在此目录内操作
```

### ❌ DON'T: 无限权限

```python
# 允许访问整个文件系统
kaos = LocalKaos(work_dir=Path("/"))
```

## 21.5 性能

### ✅ DO: 缓存

```python
# 缓存文件内容
@lru_cache(maxsize=100)
def read_file(path: str) -> str:
    return Path(path).read_text()
```

### ✅ DO: 批量操作

```python
# 批量执行工具
results = await asyncio.gather(*[
    tool1.execute(...),
    tool2.execute(...),
    tool3.execute(...)
])
```

## 21.6 可观测性

### ✅ DO: 详细日志

```python
logger.info(f"开始执行任务: {task}")
logger.debug(f"调用 LLM, tokens: {token_count}")
logger.info(f"任务完成，耗时: {elapsed}s")
```

### ✅ DO: 指标收集

```python
# 收集使用统计
metrics = {
    "total_runs": 100,
    "avg_tokens": 5000,
    "avg_cost": 0.05,
    "success_rate": 0.95
}
```

## 21.7 小结

记住这些原则：

- 🏗️ **模块化**：职责分离
- 📝 **清晰提示**：明确指令
- 🛡️ **安全第一**：最小权限
- ⚡ **性能优化**：缓存和批量
- 📊 **可观测**：日志和指标
- 🧪 **充分测试**：单元 + 集成

---

**上一章**：[第 20 章：部署和分发](./20-deployment.md) ←
**下一章**：[第 22 章：未来展望](./22-future.md) →
