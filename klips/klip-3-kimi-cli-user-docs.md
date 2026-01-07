---
Author: @stdrc
Updated: 2025-12-30
Status: Implemented
---

# KLIP-3: Kimi CLI User Documentation

以下为后续文档大纲的层级约定：

* `##` 二级标题：文档主导航 tab 链接（顶层主题）。
* `###` 三级标题：侧边栏链接（进入具体页面或分组）。
* 一级无序列表：该页面/分组下的内容块或子主题。
* 二级无序列表：内容要点与写作提示，不要求一一对应页内小标题；其中 `参考代码` 统一列出该一级条目需要参考的代码位置。

## 指南 / Guides

### 开始使用 / Getting Started

* Kimi CLI 是什么 / What is Kimi CLI
  * 适用场景
  * 技术预览状态说明
  * 参考代码: `src/kimi_cli/app.py`, `src/kimi_cli/cli.py`, `src/kimi_cli/soul/`, `src/kimi_cli/ui/`, `src/kimi_cli/tools/`, `README.md`, `src/kimi_cli/tools/file/`, `src/kimi_cli/tools/shell/`, `src/kimi_cli/tools/web/`, `src/kimi_cli/soul/toolset.py`, `CHANGELOG.md`, `src/kimi_cli/constant.py`, `src/kimi_cli/utils/changelog.py`
* 安装与升级 / Install and upgrade
  * 系统要求 / System requirements
    * Python 3.13+
    * 推荐使用 uv
    * 参考代码: `pyproject.toml`, `README.md`, `Makefile`
  * 安装 / Installation
    * 参考代码: `README.md`, `pyproject.toml`, `scripts/`
  * 升级 / Upgrade
    * 参考代码: `README.md`, `src/kimi_cli/ui/shell/update.py`, `src/kimi_cli/ui/shell/__init__.py`
  * 卸载 / Uninstall
    * 参考代码: `README.md`
* 第一次运行 / First run
  * 启动 Kimi CLI / Launch Kimi CLI
    * 在项目目录运行 `kimi`
    * 参考代码: `src/kimi_cli/cli.py`, `src/kimi_cli/app.py`, `pyproject.toml`, `README.md`
  * 配置平台与模型 / Configure platform and model
    * 使用 `/setup` 配置
    * 参考代码: `src/kimi_cli/ui/shell/setup.py`, `src/kimi_cli/config.py`, `src/kimi_cli/llm.py`, `src/kimi_cli/app.py`, `src/kimi_cli/ui/shell/slash.py`
  * 发现更多用法 / Discover more usage
    * 使用 `/help` 查看
    * 参考代码: `src/kimi_cli/ui/shell/slash.py`, `src/kimi_cli/soul/slash.py`, `src/kimi_cli/utils/slashcmd.py`

### 常见使用案例 / Common Use Cases

* 实现新功能 / Implement new feature
  * 读 → 改 → 验证
  * 参考代码: `src/kimi_cli/tools/file/`, `src/kimi_cli/tools/shell/`, `src/kimi_cli/soul/kimisoul.py`, `src/kimi_cli/soul/toolset.py`, `src/kimi_cli/tools/file/read.py`, `src/kimi_cli/tools/file/write.py`, `src/kimi_cli/tools/shell/__init__.py`
* 修复 bug / Fix bugs
  * 参考代码: `src/kimi_cli/tools/shell/__init__.py`, `src/kimi_cli/tools/file/`, `src/kimi_cli/ui/shell/debug.py`, `src/kimi_cli/ui/shell/usage.py`
* 理解项目 / Understand the codebase
  * 参考代码: `src/kimi_cli/tools/file/glob.py`, `src/kimi_cli/tools/file/grep_local.py`, `src/kimi_cli/tools/file/read.py`, `src/kimi_cli/utils/path.py`
* 自动化小任务 / Automate small tasks
  * 参考代码: `src/kimi_cli/tools/shell/__init__.py`, `src/kimi_cli/tools/todo/`, `src/kimi_cli/tools/multiagent/task.py`, `src/kimi_cli/soul/toolset.py`
* 自动化通用任务 / Automate general tasks
  * 通用 topic 的 deep research 任务
  * 数据分析任务

### 交互与输入 / Interaction and input

* Agent 与 Shell 模式 / Agent vs Shell mode
  * Ctrl-X 切换模式
  * Shell 模式运行本地命令
  * 参考代码: `src/kimi_cli/ui/shell/__init__.py`, `src/kimi_cli/ui/shell/prompt.py`, `src/kimi_cli/ui/shell/keyboard.py`, `src/kimi_cli/soul/kimisoul.py`, `src/kimi_cli/tools/shell/__init__.py`, `src/kimi_cli/utils/environment.py`, `src/kimi_cli/tools/shell/powershell.md`
* Thinking 模式 / Thinking mode
  * Tab 或 `--thinking` 切换
  * 需模型支持
  * 参考代码: `src/kimi_cli/llm.py`, `src/kimi_cli/soul/kimisoul.py`, `src/kimi_cli/ui/shell/prompt.py`, `src/kimi_cli/config.py`, `src/kimi_cli/ui/shell/keyboard.py`, `src/kimi_cli/cli.py`
* 多行输入 / Multi-line input
  * Ctrl-J 或 Alt-Enter
  * 参考代码: `src/kimi_cli/ui/shell/prompt.py`, `src/kimi_cli/ui/shell/keyboard.py`
* 剪贴板与图片粘贴 / Clipboard and image paste
  * Ctrl-V 粘贴
  * 需模型支持 `image_in`
  * 参考代码: `src/kimi_cli/utils/clipboard.py`, `src/kimi_cli/ui/shell/prompt.py`, `src/kimi_cli/ui/shell/keyboard.py`, `src/kimi_cli/llm.py`, `src/kimi_cli/config.py`
* 斜杠命令 / Slash commands
  * 参考代码: `src/kimi_cli/ui/shell/slash.py`, `src/kimi_cli/soul/slash.py`, `src/kimi_cli/utils/slashcmd.py`
* @ 路径补全 / @ path completion
  * 参考代码: `src/kimi_cli/ui/shell/prompt.py`, `src/kimi_cli/utils/path.py`, `src/kimi_cli/tools/file/glob.py`
* 审批与确认 / Approvals
  * 一次 / 本会话 / 拒绝
  * `--yolo` 或 `/yolo`
  * 参考代码: `src/kimi_cli/soul/approval.py`, `src/kimi_cli/ui/shell/visualize.py`, `src/kimi_cli/tools/file/write.py`, `src/kimi_cli/tools/shell/__init__.py`, `src/kimi_cli/cli.py`, `src/kimi_cli/ui/shell/slash.py`

### 会话与上下文 / Sessions and context

* 会话续接 / Session resuming
  * `--continue`、`--session`、`/sessions`
  * 启动回放
  * 参考代码: `src/kimi_cli/session.py`, `src/kimi_cli/metadata.py`, `src/kimi_cli/ui/shell/replay.py`, `src/kimi_cli/share.py`, `src/kimi_cli/cli.py`, `src/kimi_cli/ui/shell/slash.py`, `src/kimi_cli/wire/serde.py`
* 清空与压缩 / Clear and compact
  * `/clear`（别名 `/reset`）
  * `/compact`
  * 参考代码: `src/kimi_cli/ui/shell/slash.py`, `src/kimi_cli/soul/compaction.py`, `src/kimi_cli/soul/context.py`

### 在 IDE 中使用 / Using in IDEs

* 在 Zed 中使用 / Use in Zed
  * `--acp` 参数
  * IDE 配置
  * 参考代码: `src/kimi_cli/acp/`, `src/kimi_cli/ui/acp/__init__.py`, `src/kimi_cli/cli.py`, `src/kimi_cli/acp/AGENTS.md`, `README.md`, `src/kimi_cli/app.py`
* 在 JetBrains IDE 中使用 / Use in JetBrains IDEs
  * 同上 / Same as above

### 集成到工具 / Integrations with tools

* Zsh 插件 / Zsh plugin
  * 快捷切换
  * 参考代码: `README.md`, `src/kimi_cli/ui/shell/keyboard.py`

## 定制化 / Customization

### Model Context Protocol / Model Context Protocol

* MCP 是什么 / What is MCP
  * 参考代码: `src/kimi_cli/mcp.py`, `src/kimi_cli/soul/toolset.py`, `src/kimi_cli/acp/mcp.py`, `src/kimi_cli/tools/`
* `kimi mcp` 子命令 / `kimi mcp` subcommands
  * 参考代码: `src/kimi_cli/mcp.py`, `src/kimi_cli/cli.py`
* MCP 配置文件 / MCP config files
  * `~/.kimi/mcp.json`
  * `--mcp-config-file`
  * `--mcp-config`
  * 参考代码: `src/kimi_cli/mcp.py`, `src/kimi_cli/share.py`, `src/kimi_cli/cli.py`
* 安全性 / Security
  * 审批请求
  * 工具提示词注入风险
  * 参考代码: `src/kimi_cli/soul/approval.py`, `src/kimi_cli/soul/toolset.py`, `src/kimi_cli/tools/utils.py`, `src/kimi_cli/tools/file/`, `src/kimi_cli/ui/shell/visualize.py`

### Agent Skills

* Agent Skills 是什么 / What are Agent Skills
  * 参考代码: `src/kimi_cli/skill.py`, `src/kimi_cli/soul/agent.py`, `src/kimi_cli/utils/frontmatter.py`
* Skill 发现 / Skill discovery
  * `~/.kimi/skills`
  * 回退 `~/.claude/skills`
  * `--skills-dir`
  * 参考代码: `src/kimi_cli/skill.py`, `src/kimi_cli/soul/agent.py`, `src/kimi_cli/share.py`, `src/kimi_cli/cli.py`

### Agent 与子 Agent / Agents and subagents

* 内置 Agent / Built-in agents
  * `default`
  * `okabe`
  * 参考代码: `src/kimi_cli/agents/`, `src/kimi_cli/agentspec.py`, `src/kimi_cli/agents/default/agent.yaml`, `src/kimi_cli/agents/okabe/agent.yaml`
* 自定义 Agent 文件 / Custom agent file
  * YAML 格式
  * `extend` 与 `exclude_tools`
  * 参考代码: `src/kimi_cli/agentspec.py`, `src/kimi_cli/soul/agent.py`, `src/kimi_cli/agents/`, `src/kimi_cli/soul/toolset.py`
* 系统提示词内置参数 / System prompt built-in parameters
  * `KIMI_NOW`
  * `KIMI_WORK_DIR`
  * `KIMI_WORK_DIR_LS`
  * `KIMI_AGENTS_MD`
  * `KIMI_SKILLS`
  * 参考代码: `src/kimi_cli/soul/agent.py`, `src/kimi_cli/tools/file/read.py`, `src/kimi_cli/soul/slash.py`, `src/kimi_cli/skill.py`, `src/kimi_cli/utils/datetime.py`, `src/kimi_cli/utils/path.py`
* 在 Agent 文件中定义子 Agent / Define subagents in agent file
  * 参考代码: `src/kimi_cli/agents/default/sub.yaml`, `src/kimi_cli/agentspec.py`
* 动态子 Agent 与任务调度 / Dynamic subagents and task scheduling
  * `CreateSubagent` 工具
  * 参考代码: `src/kimi_cli/tools/multiagent/task.py`, `src/kimi_cli/tools/multiagent/create.py`, `src/kimi_cli/soul/agent.py`, `src/kimi_cli/soul/toolset.py`, `src/kimi_cli/agents/default/sub.yaml`

### Print 模式 / Print Mode

* 无交互运行 / Non-interactive run
  * `--print` + `--command` 或 stdin
  * 隐式开启 `--yolo`
  * 参考代码: `src/kimi_cli/ui/print/__init__.py`, `src/kimi_cli/ui/print/visualize.py`, `src/kimi_cli/cli.py`, `src/kimi_cli/app.py`, `src/kimi_cli/soul/approval.py`
* Stream JSON 格式 / Stream JSON format
  * `--input-format=stream-json`
  * `--output-format=stream-json`
  * JSONL Message
  * 参考代码: `src/kimi_cli/cli.py`, `src/kimi_cli/ui/print/visualize.py`, `src/kimi_cli/wire/message.py`, `src/kimi_cli/wire/serde.py`, `src/kimi_cli/ui/print/__init__.py`

### Wire 模式 / Wire Mode

* Wire 是什么 / What is Wire
  * 参考代码: `src/kimi_cli/wire/`, `src/kimi_cli/ui/wire/__init__.py`
* Wire 协议 / Wire protocol
  * JSON-RPC
  * Method 等
  * 参考代码: `src/kimi_cli/ui/wire/jsonrpc.py`, `src/kimi_cli/wire/message.py`, `src/kimi_cli/wire/serde.py`
* Wire 消息 / Wire messages
  * 完整类型与 schema
  * 参考代码: `src/kimi_cli/wire/message.py`, `src/kimi_cli/wire/serde.py`

## 配置 / Configuration

### 配置文件 / Config files

* 配置文件位置 / Config file location
  * `~/.kimi/config.toml`
  * 参考代码: `src/kimi_cli/config.py`, `src/kimi_cli/share.py`, `README.md`
* 配置项 / Config items
  * providers
  * models
  * loop control
  * services
  * MCP client
  * 参考代码: `src/kimi_cli/config.py`, `src/kimi_cli/llm.py`, `src/kimi_cli/mcp.py`, `src/kimi_cli/soul/kimisoul.py`, `src/kimi_cli/tools/web/`
* JSON 支持与迁移 / JSON support and migration
  * `config.json` 迁移
  * `--config`/`--config-file` 仍可以用 JSON
  * 参考代码: `src/kimi_cli/config.py`, `src/kimi_cli/cli.py`

### 平台与模型 / Providers and models

* 平台选择 / Platform selection
  * `/setup`
  * 参考代码: `src/kimi_cli/ui/shell/setup.py`, `src/kimi_cli/config.py`, `src/kimi_cli/ui/shell/slash.py`
* Provider 类型 / Provider types
  * `kimi`
  * `openai_legacy`
  * `openai_responses`
  * `anthropic`
  * `gemini/google_genai`
  * `vertexai`
  * 参考代码: `src/kimi_cli/llm.py`, `src/kimi_cli/config.py`, `src/kimi_cli/ui/shell/setup.py`
* 模型能力与限制 / Model capabilities and limits
  * thinking
  * image\_in
  * 参考代码: `src/kimi_cli/llm.py`, `src/kimi_cli/soul/kimisoul.py`, `src/kimi_cli/soul/message.py`, `src/kimi_cli/ui/shell/prompt.py`, `src/kimi_cli/config.py`
* 搜索/抓取服务 / Search and fetch services
  * 启用条件
  * 参考代码: `src/kimi_cli/tools/web/search.py`, `src/kimi_cli/tools/web/fetch.py`, `src/kimi_cli/config.py`, `src/kimi_cli/ui/shell/setup.py`

### 配置覆盖 / Config overrides

* CLI 参数与配置文件 / CLI flags vs config
  * 参考代码: `src/kimi_cli/cli.py`, `src/kimi_cli/config.py`
* 环境变量覆盖 / Environment overrides
  * 参考代码: `src/kimi_cli/utils/envvar.py`, `src/kimi_cli/llm.py`

### 环境变量 / Environment variables

* Kimi 环境变量 / Kimi environment variables
  * `KIMI_BASE_URL`
  * `KIMI_API_KEY`
  * `KIMI_MODEL_NAME`
  * `KIMI_MODEL_MAX_CONTEXT_SIZE`
  * `KIMI_MODEL_CAPABILITIES`
  * `KIMI_MODEL_TEMPERATURE`
  * `KIMI_MODEL_TOP_P`
  * `KIMI_MODEL_MAX_TOKENS`
  * 参考代码: `src/kimi_cli/utils/envvar.py`, `src/kimi_cli/config.py`, `src/kimi_cli/llm.py`
* OpenAI 兼容环境变量 / OpenAI-compatible environment variables
  * `OPENAI_BASE_URL`
  * `OPENAI_API_KEY`
  * 参考代码: `src/kimi_cli/utils/envvar.py`, `src/kimi_cli/llm.py`, `src/kimi_cli/config.py`
* 其他环境变量 / Other environment variables
  * `KIMI_CLI_NO_AUTO_UPDATE`
  * 参考代码: `src/kimi_cli/utils/envvar.py`, `src/kimi_cli/ui/shell/update.py`

### 数据路径 / Data locations

* 配置与元数据 / Config and metadata
  * `~/.kimi/config.toml`
  * `~/.kimi/kimi.json`
  * `~/.kimi/mcp.json`
  * 参考代码: `src/kimi_cli/share.py`, `src/kimi_cli/metadata.py`, `src/kimi_cli/config.py`, `src/kimi_cli/mcp.py`
* 会话数据 / Session data
  * `~/.kimi/sessions/.../context.jsonl`
  * `~/.kimi/sessions/.../wire.jsonl`
  * 参考代码: `src/kimi_cli/session.py`, `src/kimi_cli/wire/serde.py`, `src/kimi_cli/soul/context.py`, `src/kimi_cli/wire/message.py`
* 输入历史 / Input history
  * `~/.kimi/user-history/...`
  * 参考代码: `src/kimi_cli/ui/shell/prompt.py`, `src/kimi_cli/share.py`
* 日志 / Logs
  * `~/.kimi/logs/kimi.log`
  * 参考代码: `src/kimi_cli/utils/logging.py`, `src/kimi_cli/app.py`, `src/kimi_cli/share.py`

## 参考手册 / Reference

### `kimi` 命令 / `kimi` command

* 全局参数 / Global flags
  * `--version`、`--help`、`--verbose`、`--debug`
  * `--agent`、`--agent-file`
  * `--config`、`--config-file`
  * `--model`
  * `--work-dir`
  * `--continue`、`--session`
  * `--command` / `--query`
  * `--print`、`--input-format`、`--output-format`
  * `--acp`、`--wire`
  * `--mcp-config-file`、`--mcp-config`
  * `--yolo` / `--auto-approve` / `--yes`
  * `--thinking` / `--no-thinking`
  * `--skills-dir`
  * 参考代码: `src/kimi_cli/cli.py`, `src/kimi_cli/app.py`, `src/kimi_cli/constant.py`, `src/kimi_cli/agentspec.py`, `src/kimi_cli/config.py`, `src/kimi_cli/llm.py`, `src/kimi_cli/session.py`, `src/kimi_cli/ui/print/__init__.py`, `src/kimi_cli/ui/acp/__init__.py`, `src/kimi_cli/ui/wire/__init__.py`, `src/kimi_cli/mcp.py`, `src/kimi_cli/soul/approval.py`, `src/kimi_cli/skill.py`

### `kimi acp` 命令 / `kimi acp` command

* 启动 ACP multi-session 服务器，现在还没有被 ACP 客户端广泛支持 / Start an ACP multi-session server, which is not widely supported by ACP clients yet.
  * 参考代码: `src/kimi_cli/cli.py`, `src/kimi_cli/acp/__init__.py`, `src/kimi_cli/ui/acp/__init__.py`

### `kimi mcp` 子命令 / `kimi mcp` subcommands

* 服务器管理 / Server management
  * `add`、`list`、`remove`
  * 参考代码: `src/kimi_cli/mcp.py`, `src/kimi_cli/cli.py`
* 认证与测试 / Auth and test
  * `auth`、`reset-auth`、`test`
  * 参考代码: `src/kimi_cli/mcp.py`, `src/kimi_cli/soul/toolset.py`, `src/kimi_cli/acp/mcp.py`

### 斜杠命令 / Slash commands

* 帮助与信息 / Help and info
  * `/help`、`/version`、`/release-notes`、`/feedback`
  * 参考代码: `src/kimi_cli/ui/shell/slash.py`, `src/kimi_cli/soul/slash.py`, `src/kimi_cli/utils/changelog.py`
* 配置与调试 / Config and debug
  * `/setup`、`/reload`、`/debug`、`/usage`
  * 参考代码: `src/kimi_cli/ui/shell/slash.py`, `src/kimi_cli/ui/shell/debug.py`, `src/kimi_cli/ui/shell/setup.py`, `src/kimi_cli/ui/shell/usage.py`
* 会话管理 / Session management
  * `/clear`（别名 `/reset`）
  * `/sessions`（别名 `/resume`）
  * 参考代码: `src/kimi_cli/ui/shell/slash.py`, `src/kimi_cli/session.py`, `src/kimi_cli/soul/context.py`
* 其他 / Others
  * `/mcp`、`/init`、`/compact`、`/yolo`
  * 参考代码: `src/kimi_cli/ui/shell/slash.py`, `src/kimi_cli/soul/slash.py`, `src/kimi_cli/mcp.py`, `src/kimi_cli/soul/compaction.py`, `src/kimi_cli/soul/approval.py`

### 内置工具 / Built-in tools

* 默认启用工具 / Default tools
  * `Task`、`SetTodoList`、`Shell`、`ReadFile`、`Glob`、`Grep`、`WriteFile`、`StrReplaceFile`、`SearchWeb`、`FetchURL`
  * 参考代码: `src/kimi_cli/agents/default/agent.yaml`, `src/kimi_cli/tools/`, `src/kimi_cli/tools/utils.py`
* 可选工具 / Optional tools
  * `Think`、`SendDMail`、`CreateSubagent`
  * 需在 Agent 文件中启用
  * 参考代码: `src/kimi_cli/agents/default/sub.yaml`, `src/kimi_cli/tools/`, `src/kimi_cli/tools/think/`, `src/kimi_cli/tools/dmail/`, `src/kimi_cli/tools/multiagent/create.py`, `src/kimi_cli/agents/default/agent.yaml`, `src/kimi_cli/agentspec.py`
* 工具安全边界与审批 / Tool security and approvals
  * 工作目录限制
  * diff 预览
  * 参考代码: `src/kimi_cli/soul/approval.py`, `src/kimi_cli/soul/toolset.py`, `src/kimi_cli/tools/file/`, `src/kimi_cli/tools/shell/__init__.py`, `src/kimi_cli/utils/path.py`, `src/kimi_cli/tools/file/write.py`, `src/kimi_cli/tools/file/diff_utils.py`, `src/kimi_cli/ui/shell/visualize.py`

### 退出码与失败模式 / Exit codes and failure modes

* 退出码语义与触发条件（正常结束、配置错误、运行中断等）
  * 与 UI/模式相关的失败场景说明（Shell/Print/Wire/ACP）
  * 参考代码: `src/kimi_cli/cli.py`, `src/kimi_cli/app.py`, `src/kimi_cli/exception.py`, `src/kimi_cli/soul/__init__.py`

### 键盘快捷键 / Keyboard shortcuts

* Ctrl-X：切换模式
  * 参考代码: `src/kimi_cli/ui/shell/keyboard.py`, `src/kimi_cli/ui/shell/__init__.py`
* Tab：切换 thinking
  * 参考代码: `src/kimi_cli/ui/shell/keyboard.py`, `src/kimi_cli/llm.py`
* Ctrl-J / Alt-Enter：换行
  * 参考代码: `src/kimi_cli/ui/shell/keyboard.py`, `src/kimi_cli/ui/shell/prompt.py`
* Ctrl-V：粘贴
  * 参考代码: `src/kimi_cli/ui/shell/keyboard.py`, `src/kimi_cli/utils/clipboard.py`
* Ctrl-D：退出
  * 参考代码: `src/kimi_cli/ui/shell/keyboard.py`, `src/kimi_cli/ui/shell/__init__.py`

## 常见问题 / FAQ

### 安装与鉴权 / Setup and auth

* 模型列表为空
  * 参考代码: `src/kimi_cli/ui/shell/setup.py`, `src/kimi_cli/config.py`, `src/kimi_cli/llm.py`
* API key 无效
  * 参考代码: `src/kimi_cli/ui/shell/setup.py`, `src/kimi_cli/config.py`, `src/kimi_cli/utils/envvar.py`
* 会员过期
  * 参考代码: `src/kimi_cli/ui/shell/usage.py`, `src/kimi_cli/ui/shell/setup.py`

### 交互问题 / Interaction issues

* Shell 模式 `cd` 无效
  * 参考代码: `src/kimi_cli/tools/shell/__init__.py`, `src/kimi_cli/utils/environment.py`, `src/kimi_cli/tools/shell/bash.md`
* Thinking 模式不可用
  * 参考代码: `src/kimi_cli/llm.py`, `src/kimi_cli/config.py`, `src/kimi_cli/ui/shell/prompt.py`

### ACP 问题 / ACP issues

* 连接失败
  * 参考代码: `src/kimi_cli/acp/server.py`, `src/kimi_cli/acp/session.py`, `src/kimi_cli/ui/acp/__init__.py`
* 工作目录不一致
  * 参考代码: `src/kimi_cli/acp/session.py`, `src/kimi_cli/session.py`, `src/kimi_cli/share.py`

### MCP 问题 / MCP issues

* 服务启动失败
  * 参考代码: `src/kimi_cli/mcp.py`, `src/kimi_cli/soul/toolset.py`
* OAuth 授权失败
  * 参考代码: `src/kimi_cli/mcp.py`, `src/kimi_cli/acp/mcp.py`
* Header 格式错误
  * 参考代码: `src/kimi_cli/mcp.py`, `src/kimi_cli/soul/toolset.py`

### Print/Wire 模式问题 / Print/Wire mode issues

* JSONL 输入无效
  * 参考代码: `src/kimi_cli/ui/print/__init__.py`, `src/kimi_cli/wire/serde.py`
* 无输出
  * 参考代码: `src/kimi_cli/ui/print/__init__.py`, `src/kimi_cli/ui/wire/__init__.py`
* 格式不匹配
  * 参考代码: `src/kimi_cli/wire/message.py`, `src/kimi_cli/wire/serde.py`

### 更新与升级 / Updates

* macOS 首次运行变慢
  * 参考代码: `src/kimi_cli/ui/shell/update.py`, `src/kimi_cli/tools/file/grep_local.py`
* uv 升级步骤
  * 参考代码: `README.md`, `src/kimi_cli/ui/shell/update.py`

## 发布说明 / Release Notes

### 变更记录 / Changelog

* 版本号、发布日期、变更内容 / Version number, release date, changes
  * 参考代码: `CHANGELOG.md`, `src/kimi_cli/utils/changelog.py`, `src/kimi_cli/constant.py`, `README.md`

### 破坏性变更与迁移说明 / Breaking changes and migration

* 破坏性变更清单与迁移指引
  * 受影响范围、替代方案、回滚提示
  * 参考代码: `CHANGELOG.md`, `src/kimi_cli/utils/changelog.py`
