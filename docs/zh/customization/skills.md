# Agent Skills

Agent Skills 是可复用的提示词片段，让你可以为 AI 添加特定领域的知识或行为指引。

## Agent Skills 是什么

一个 Skill 就是一个包含 `SKILL.md` 文件的目录。`SKILL.md` 的内容会作为系统提示词的一部分注入给 AI，让它了解特定的规则、偏好或领域知识。

例如，你可以创建一个「代码风格」Skill，告诉 AI 你项目的命名规范、注释风格等；或者创建一个「安全审计」Skill，让 AI 在审查代码时关注特定的安全问题。

## Skill 发现

Kimi CLI 会从以下目录发现 Skills：

1. `~/.kimi/skills`（默认目录）
2. `~/.claude/skills`（兼容 Claude Code 的 Skills）

你也可以通过 `--skills-dir` 参数指定其他目录：

```sh
kimi --skills-dir /path/to/my-skills
```

## 创建 Skill

创建一个 Skill 只需要两步：

1. 在 skills 目录下创建一个子目录
2. 在子目录中创建 `SKILL.md` 文件

**目录结构示例**

```
~/.kimi/skills/
├── code-style/
│   └── SKILL.md
├── security-review/
│   └── SKILL.md
└── api-design/
    └── SKILL.md
```

**SKILL.md 格式**

`SKILL.md` 使用 YAML frontmatter 定义元数据，后面是提示词内容：

```markdown
---
name: code-style
description: 我的项目代码风格规范
---

## 代码风格

在这个项目中，请遵循以下规范：

- 使用 4 空格缩进
- 变量名使用 camelCase
- 函数名使用 snake_case
- 每个函数都需要 docstring
- 单行不超过 100 字符
```

**frontmatter 字段**

| 字段 | 说明 | 是否必填 |
|------|------|----------|
| `name` | Skill 名称，默认使用目录名 | 否 |
| `description` | Skill 描述，用于展示 | 否 |

frontmatter 是可选的。如果省略，Skill 名称会使用目录名，描述为「No description provided」。

## 示例 Skill

**Python 项目规范**

```markdown
---
name: python-project
description: Python 项目开发规范
---

## Python 开发规范

- 使用 Python 3.12+
- 使用 ruff 进行代码格式化和 lint
- 使用 pyright 进行类型检查
- 测试使用 pytest
- 依赖管理使用 uv

代码风格：
- 行长度限制 100 字符
- 使用类型注解
- 公开函数需要 docstring
```

**Git 提交规范**

```markdown
---
name: git-commits
description: Git 提交信息规范
---

## Git 提交规范

使用 Conventional Commits 格式：

类型(范围): 描述

允许的类型：feat, fix, docs, style, refactor, test, chore

示例：
- feat(auth): 添加 OAuth 登录支持
- fix(api): 修复用户查询返回空值的问题
- docs(readme): 更新安装说明
```

Skills 让你可以将团队的最佳实践和项目规范固化下来，确保 AI 始终遵循一致的标准。
