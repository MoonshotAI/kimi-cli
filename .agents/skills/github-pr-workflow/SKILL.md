---
name: github-pr-workflow
description: Complete GitHub PR workflow from local development to submission. Use when user says "提 PR", "创建 PR", "submit PR", "怎么提交代码", "怎么发 PR", or when they have finished local feature development and need to push code and create a pull request. Also use for handling PR review feedback and iterative fixes. Guides through git workflow, gh CLI usage, fork management, and upstream synchronization.
---

# GitHub PR 工作流

从本地开发到提交 PR 的完整工作流指南。适用于向开源项目贡献代码或团队协作开发。

---

## 工作流概览

```
本地开发 → 测试验证 → 推送到 fork → 创建 PR → 处理 Review → 合并
```

---

## Step 1: 前置检查

### 1.1 检查当前 git 状态

```bash
# 查看修改的文件
git status

# 查看当前分支
git branch --show-current

# 查看远程仓库配置
git remote -v
```

**关键判断**：
- 是否在正确的分支上？
- 是否有未提交的修改？
- 远程是否配置了 upstream（上游仓库）？

### 1.2 配置 upstream（如果不存在）

```bash
# 添加上游仓库（原始项目）
git remote add upstream <原始仓库 URL>

# 示例
git remote add upstream https://github.com/MoonshotAI/kimi-cli.git
```

---

## Step 2: 本地开发与测试

### 2.1 从 upstream 同步最新代码

```bash
# 获取上游更新
git fetch upstream

# 切换到 main 分支
git checkout main

# 合并上游更新
git merge upstream/main

# 或使用 rebase
git rebase upstream/main
```

### 2.2 创建 feature 分支

```bash
# 基于最新 main 创建分支
git checkout -b feat/<feature-name>

# 示例
git checkout -b feat/token-usage-stats
```

### 2.3 开发并测试

开发完成后，本地测试验证：

```bash
# 运行测试
make test
# 或
uv run pytest

# 代码检查
make check
# 或
ruff check .
```

### 2.4 提交修改

```bash
# 添加文件
git add <files>

# 提交（使用约定式提交）
git commit -m "feat(scope): description"

# 示例
git commit -m "feat(token-ledger): add daily/weekly usage tracking"
```

---

## Step 3: 推送到 fork

### 3.1 推送到你的 fork

```bash
# 推送到 origin（你的 fork）
git push origin <branch-name>

# 示例
git push origin feat/token-usage-stats
```

如果分支已存在，使用 `-u` 建立追踪：

```bash
git push -u origin feat/token-usage-stats
```

### 3.2 使用 gh CLI 创建 PR

```bash
# 创建 PR（交互式）
gh pr create

# 或一次性创建
gh pr create --title "feat: xxx" --body "描述..."
```

**推荐的 PR 结构**：

```markdown
## 变更内容
- 做了什么
- 为什么做

## 测试
- 如何测试的
- 测试结果

## 相关
- Issue #123
```

---

## Step 4: 使用 gh CLI 管理 PR

### 4.1 查看 PR 状态

```bash
# 查看当前分支的 PR
gh pr view

# 查看指定 PR
gh pr view <number>

# 在浏览器中打开
gh pr view --web
```

### 4.2 查看 PR diff

```bash
gh pr diff <number>
```

### 4.3 检查 CI 状态

```bash
gh pr checks <number>
```

### 4.4 列出所有 PR

```bash
gh pr list
gh pr list --state open
gh pr list --author @me
```

---

## Step 5: 处理 Code Review

### 5.1 查看 Review 评论

```bash
gh pr view --comments
```

### 5.2 本地修改并推送

根据 review 反馈修改代码：

```bash
# 修改代码...

# 提交修复（使用 fix 类型）
git add .
git commit -m "fix(token-ledger): address review comments

- 修复问题 1
- 修复问题 2"

# 推送到同一分支（自动更新 PR）
git push origin <branch-name>
```

### 5.3 回复 Review 评论

在 GitHub 网页上回复评论，解释修改或提问。

---

## Step 6: 多轮迭代修复

### 6.1 保持分支同步

如果 upstream 有新提交：

```bash
# 获取上游更新
git fetch upstream

# 变基到最新 upstream/main
git rebase upstream/main

# 或合并
git merge upstream/main

# 强制推送（如果已 rebase）
git push --force-with-lease origin <branch-name>
```

### 6.2 迭代提交策略

**选项 A：每次 fix 单独提交（清晰，推荐）**
```
fix(token-ledger): handle edge case 1
fix(token-ledger): handle edge case 2  
fix(token-ledger): handle edge case 3
```

**选项 B：合并为单个 fix（如果 fix 很小）**
```bash
# 交互式 rebase 合并提交
git rebase -i HEAD~3

# 修改 pick 为 squash
# 然后强制推送
git push --force-with-lease origin <branch-name>
```

---

## Step 7: PR 合并后的清理

### 7.1 删除本地分支

```bash
# 切换到 main
git checkout main

# 删除本地分支
git branch -d <branch-name>

# 删除远程分支（如果 PR 没自动删除）
git push origin --delete <branch-name>
```

### 7.2 同步最新代码

```bash
git fetch upstream
git merge upstream/main
git push origin main
```

---

## 常用命令速查

| 任务 | 命令 |
|------|------|
| 查看 PR | `gh pr view` |
| 查看 diff | `gh pr diff` |
| 检查 CI | `gh pr checks` |
| 列出 PR | `gh pr list` |
| 创建 PR | `gh pr create` |
| 编辑 PR | `gh pr edit` |
| 关闭 PR | `gh pr close <number>` |
| 合并 PR | `gh pr merge <number>` |

---

## 最佳实践

### 提交信息规范

```
feat(scope): 新增功能
fix(scope): 修复问题
docs(scope): 文档更新
style(scope): 代码格式
test(scope): 测试相关
chore(scope): 构建/工具
```

### PR 规模控制

- 每个 PR 只做一件事
- 代码行数控制在 500 行以内（便于 review）
- 包含测试和文档更新

### 处理 Review 的心态

- Review 是帮助改进代码，不是批评
- 及时响应（24-48 小时内）
- 不理解就问，不要猜测
- 必要时可以离线讨论

---

## 故障排除

### 问题：无法推送

```bash
# 检查远程权限
git remote -v

# 确认推送到 origin（fork）而非 upstream
# 如果没有 fork，先 fork 仓库
```

### 问题：冲突

```bash
# 获取最新代码
git fetch upstream

# 变基
git rebase upstream/main

# 解决冲突后
git add .
git rebase --continue
```

### 问题：CI 失败

```bash
# 本地先运行相同检查
make test
make check

# 查看失败日志
gh run view <run-id>
```
