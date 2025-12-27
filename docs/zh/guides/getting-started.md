# 开始使用

## Kimi CLI 是什么

- 适用场景
- 技术预览状态说明

::: info 参考代码
`src/kimi_cli/app.py`, `src/kimi_cli/cli.py`, `src/kimi_cli/soul/`, `src/kimi_cli/ui/`, `src/kimi_cli/tools/`, `README.md`, `src/kimi_cli/tools/file/`, `src/kimi_cli/tools/shell/`, `src/kimi_cli/tools/web/`, `src/kimi_cli/soul/toolset.py`, `CHANGELOG.md`, `src/kimi_cli/constant.py`, `src/kimi_cli/utils/changelog.py`
:::

## 安装与升级

系统要求

- Python 3.13+
- 推荐使用 uv

::: info 参考代码
`pyproject.toml`, `README.md`, `Makefile`
:::

安装

::: info 参考代码
`README.md`, `pyproject.toml`, `scripts/`
:::

升级

::: info 参考代码
`README.md`, `src/kimi_cli/ui/shell/update.py`, `src/kimi_cli/ui/shell/__init__.py`
:::

卸载

::: info 参考代码
`README.md`
:::

## 第一次运行

启动 Kimi CLI

- 在项目目录运行 `kimi`

::: info 参考代码
`src/kimi_cli/cli.py`, `src/kimi_cli/app.py`, `pyproject.toml`, `README.md`
:::

配置平台与模型

- 使用 `/setup` 配置

::: info 参考代码
`src/kimi_cli/ui/shell/setup.py`, `src/kimi_cli/config.py`, `src/kimi_cli/llm.py`, `src/kimi_cli/app.py`, `src/kimi_cli/ui/shell/slash.py`
:::

发现更多用法

- 使用 `/help` 查看

::: info 参考代码
`src/kimi_cli/ui/shell/slash.py`, `src/kimi_cli/soul/slash.py`, `src/kimi_cli/utils/slashcmd.py`
:::
