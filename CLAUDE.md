# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

Kimi CLI（`kimi-cli`）是一个运行在终端里的 AI agent，用于软件开发与终端操作：读写代码、执行 shell 命令、搜索网页，并自主规划与调整动作。技术栈：Python 3.12+、Typer（CLI）、asyncio、kosong（LLM 层）、fastmcp（MCP）、loguru（日志）、uv（包管理/构建）、PyInstaller（打包二进制）。

> 注意：项目正逐步演进为 [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code)。**`AGENTS.md` 是最权威的架构文档**（作为 `KIMI_AGENTS_MD` 注入 agent 提示词），详细的模块级架构请直接查阅它；本文件只保留高频命令与关键约定。

## 常用命令（优先用 uv / make）

```sh
make prepare        # 同步所有工作区依赖并安装 prek git hooks
make format         # 格式化全部包（ruff check --fix + ruff format）
make check          # 检查全部包（ruff + pyright；ty 非阻塞，|| true）
make test           # 运行全部测试（kimi-cli + kosong + pykaos + kimi-sdk）
make test-kimi-cli  # 只跑本包测试：uv run pytest tests -vv && uv run pytest tests_e2e -vv
make ai-test        # AI 驱动测试：uv run tests_ai/scripts/run.py tests_ai
uv run kimi         # 运行 CLI
```

- **单个测试**：`uv run pytest tests/core/test_create_llm.py -vv`，加 `::test_name` 定位到用例。`pytest.ini` 设置了 `asyncio_mode = auto`，异步测试无需手动 `@pytest.mark.asyncio`。
- **构建**：`make build`（构建各 Python 包）、`make build-bin`（PyInstaller 单文件二进制，产物在 `dist/`）；两者都会自动先跑 `make build-web` / `make build-vis` 内嵌 Web UI，需要 Node.js/npm。
- **前端开发**：`make web-back` + `make web-front`（web UI，uvicorn + vite）；`make vis-back` + `make vis-front`（vis 追踪可视化 UI）。

## 架构速览

调用链大致为：CLI 解析 → 应用初始化 → soul 主循环 → Wire → UI。

- **CLI 入口**：`src/kimi_cli/cli/__init__.py`（Typer）解析 UI 模式/agent spec/配置/MCP 等参数，路由到 `src/kimi_cli/app.py` 的 `KimiCLI`。顶层 `kimi` / `kimi-cli` 命令由 `src/kimi_cli/__main__.py` 进入。
- **运行时**：`KimiCLI.create` 加载 `config.py` 配置、`llm.py` 选择模型/提供商、构建 `soul/agent.py` 里的 `Runtime`、加载 agent spec、恢复 `Context`，最后构造 `KimiSoul`。
- **核心循环**：`src/kimi_cli/soul/kimisoul.py` 是主 agent 循环（接收输入、处理 slash 命令、追加 `Context`、调用 LLM、执行工具、必要时 `compaction.py` 压缩上下文）。
- **Agent spec**：`src/kimi_cli/agents/` 下 YAML，由 `agentspec.py` 加载，可 `extend` 基础 spec、按 import path 选工具、注册内置 subagent 类型；系统提示词与 spec 同目录，内置参数有 `KIMI_NOW`、`KIMI_WORK_DIR`、`KIMI_AGENTS_MD` 等。
- **工具与子 agent**：`soul/toolset.py` 按 import path 加载工具并注入依赖；内置工具在 `src/kimi_cli/tools/`（agent、shell、file、web、todo、background、dmail、think、plan）。MCP 工具经 fastmcp 加载。`LaborMarket` 注册内置 subagent 类型，`SubagentStore` 把子 agent 实例持久化到 `session/subagents/<agent_id>/` 下。
- **审批**：`soul/approval.py` 是对外门面，`approval_runtime/` 是会话级待审批状态源，审批请求投影到 Wire 流上供 Shell/Web UI 消费。
- **UI / Wire**：`soul/run_soul` 把 `KimiSoul` 接到 `wire/` 的 `Wire` 上以流式输出事件；前端在 `ui/`（shell / print / acp / wire），其中 `ui/shell/` 是默认交互体验。
- **工作区包**：`packages/kosong`（LLM 抽象层）、`packages/kaos`（pykaos，系统交互抽象）、`packages/kimi-code`、`sdks/kimi-sdk`，均在 `pyproject.toml` 的 `[tool.uv.workspace]` 中，互相通过 `[tool.uv.sources]` 关联。

## 约定

- **版本号**：仅递增 minor（`MAJOR.MINOR.PATCH`，patch 恒为 `0`），任何变更都 bump minor；major 只允许显式手动决策。此规则适用于本仓库全部包及 release/skill 工作流。
- **提交信息**：Conventional Commits，允许类型：`feat`、`fix`、`test`、`refactor`、`chore`、`style`、`docs`、`perf`、`build`、`ci`、`revert`。
- **代码质量**：ruff 负责 lint + format（规则 E、F、UP、B、SIM、I，行宽 100），pyright（standard 模式，`src/kimi_cli/**` 为 strict）与 ty 负责类型检查，ty 失败不阻塞。
- **prek hooks**：commit 时会自动运行 `make format-kimi-cli` 与 `make check-kimi-cli`（见 `.pre-commit-config.yaml`），可 `git commit --no-verify` 跳过；手动全量运行用 `prek run --all-files`。
- **测试分层**：`tests/` 单元测试、`tests_e2e/` 端到端、`tests_ai/` 由 agent 驱动（`make ai-test`）。
- **用户数据**：配置文件 `~/.kimi/config.toml`，日志、会话、MCP 配置在 `~/.kimi/`。
- **文档**：用户在 `docs/zh/` 与 `docs/en/`（Vitepress），PR 通常会同步更新中文/英文文档。

## 发布与技能

- **发布流程**：严格遵循 `release` 技能（`.agents/skills/release/SKILL.md`）——新建 `bump-0.xx` 分支、在 `CHANGELOG.md` 的 `## Unreleased` 下新增 `## 0.xx (YYYY-MM-DD)`、更新 `pyproject.toml` 版本、`uv sync` 对齐 `uv.lock`、PR 合并后打 tag 推送，由 GitHub Actions 完成发布。
- 仓库自带若干 agent 技能（`feature-smoke-test`、`gen-changelog`、`gen-docs`、`pull-request`、`translate-docs` 等），可在 `.agents/skills/` 查看。
