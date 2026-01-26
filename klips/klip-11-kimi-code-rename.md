---
Author: "@stdrc"
Updated: 2026-01-26
Status: Implemented
---

# KLIP-11: Rebrand Kimi CLI -> Kimi Code CLI (Docs + UI Copy)

## 背景

- 项目仓库与 PyPI 主包仍为 `kimi-cli`，Python 导入路径为 `kimi_cli`。
- 已存在 `kimi-code` 包作为薄包装以保留名称，但不计划切换主包名。
- 当前需求是最小化改动：仅更新用户可见文案与模型提示词中的品牌为「Kimi Code CLI」。

## 目标

- 用户文档与 README 统一品牌为 **Kimi Code CLI**。
- Shell UI 与 ACP/Wire 相关的用户可见文案统一品牌为 **Kimi Code CLI**。
- 默认 system prompt 与内置技能提示词统一品牌为 **Kimi Code CLI**。
- 保持命令与包名不变：`kimi` 命令、`kimi-cli` 包、`kimi_cli` 导入路径继续使用。
- `kimi-code` 继续维护以防名称被占用，但不作为主安装路径。

## 非目标/约束

- 不更改包名/导入路径/命令名。
- 不更改 User-Agent、更新 URL、二进制路径。
- 不更改仓库名、文档站点 URL、构建/发布流程。
- 不改历史变更记录中的事实表述（如旧包名迁移说明）。

## 仓库扫描（用户可见文案）

需要改名的文档主要集中在以下位置（均含大量 `Kimi CLI` 文案）：

- **顶层文档**：`README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`
- **文档站点配置/入口**：`docs/.vitepress/config.ts`, `docs/index.md`,
  `docs/en/index.md`, `docs/zh/index.md`, `docs/package.json`
- **文档内容**：`docs/en/**`, `docs/zh/**`, `docs/AGENTS.md`
- **示例说明**：`examples/*/README.md`
- **Shell UI**：`src/kimi_cli/ui/shell/*`
- **运行时品牌名称**：`src/kimi_cli/constant.py`, `src/kimi_cli/acp/server.py`,
  `src/kimi_cli/cli/__init__.py`, `src/kimi_cli/wire/server.py`
- **系统提示词**：`src/kimi_cli/agents/default/system.md`
- **内置技能提示词**：`src/kimi_cli/skills/*/SKILL.md`
- **测试快照**：`tests/core/test_default_agent.py`

## 文案规则（避免误导）

- 正文、标题用 **Kimi Code CLI**。
- 命令/包名保持现状：`kimi`, `kimi-cli`, `zsh-kimi-cli` 等不要改。
- 与实际输出绑定的字段名/命令保持不变，例如 `kimi_cli_version`、`uv tool upgrade kimi-cli`。
- 历史说明保留真实名称（如 “rename package name `ensoul` to `kimi-cli`”）。

## 已完成

- README 与文档站点入口统一品牌为 Kimi Code CLI（保留 `kimi-cli` 的 repo/徽章/链接）。
- 文档正文（`docs/en/**`, `docs/zh/**`, `docs/AGENTS.md`）与示例 README 完成文案替换，
  代码块/输出示例中保留实际命令与字段名。
- Shell UI 文案与 ACP/Wire 可见文案完成替换（欢迎语、提示语、setup、更新提示）。
- 默认 system prompt 与内置 skills 提示词完成替换，避免模型沿用旧品牌回复。
- 相关测试快照同步更新（默认 agent prompt）。
- 站点同步脚本与项目级 AGENTS 文案同步更新。
- `packages/kimi-code/` 作为薄包装包已存在，随 `kimi-cli` 版本发布。

## 已确认

- 文档站点 URL 继续保留 `moonshotai.github.io/kimi-cli`。
- 用户文档不提 `kimi-code` 包名，仅在内部维护该占位包。
