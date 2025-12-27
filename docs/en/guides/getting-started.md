# Getting Started

## What is Kimi CLI

- Use cases
- Technical preview status

::: info Reference Code
`src/kimi_cli/app.py`, `src/kimi_cli/cli.py`, `src/kimi_cli/soul/`, `src/kimi_cli/ui/`, `src/kimi_cli/tools/`, `README.md`, `src/kimi_cli/tools/file/`, `src/kimi_cli/tools/shell/`, `src/kimi_cli/tools/web/`, `src/kimi_cli/soul/toolset.py`, `CHANGELOG.md`, `src/kimi_cli/constant.py`, `src/kimi_cli/utils/changelog.py`
:::

## Install and upgrade

System requirements

- Python 3.13+
- uv recommended

::: info Reference Code
`pyproject.toml`, `README.md`, `Makefile`
:::

Installation

::: info Reference Code
`README.md`, `pyproject.toml`, `scripts/`
:::

Upgrade

::: info Reference Code
`README.md`, `src/kimi_cli/ui/shell/update.py`, `src/kimi_cli/ui/shell/__init__.py`
:::

Uninstall

::: info Reference Code
`README.md`
:::

## First run

Launch Kimi CLI

- Run `kimi` in your project directory

::: info Reference Code
`src/kimi_cli/cli.py`, `src/kimi_cli/app.py`, `pyproject.toml`, `README.md`
:::

Configure platform and model

- Use `/setup` to configure

::: info Reference Code
`src/kimi_cli/ui/shell/setup.py`, `src/kimi_cli/config.py`, `src/kimi_cli/llm.py`, `src/kimi_cli/app.py`, `src/kimi_cli/ui/shell/slash.py`
:::

Discover more usage

- Use `/help` to view

::: info Reference Code
`src/kimi_cli/ui/shell/slash.py`, `src/kimi_cli/soul/slash.py`, `src/kimi_cli/utils/slashcmd.py`
:::
