# kimi-code (PyPI): legacy package, archived

> [!CAUTION]
> **This PyPI package is NOT the new Kimi Code CLI.** It is a legacy alias of the archived Python [Kimi CLI](https://github.com/MoonshotAI/kimi-cli) and is no longer maintained.
>
> PyPI 上的 `kimi-code` 是已归档的旧版 Python Kimi CLI 的别名包，**不是**新版 Kimi Code CLI。

## Install the new Kimi Code CLI

```sh
# macOS / Linux
curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash
```

```powershell
# Windows (PowerShell)
irm https://code.kimi.com/kimi-code/install.ps1 | iex
```

Also available via Homebrew (`brew install kimi-code`) and npm (`npm install -g @moonshot-ai/kimi-code`).

Then uninstall this package: `uv tool uninstall kimi-code` (or `pip uninstall kimi-code kimi-cli`, since pip does not remove the legacy `kimi-cli` dependency automatically).

Migration guide: [English](https://moonshotai.github.io/kimi-code/en/guides/migration) | [中文](https://moonshotai.github.io/kimi-code/zh/guides/migration)

## Note for existing users

Starting from 1.51.0, running `kimi-code` from this package only prints the instructions above. The legacy CLI it used to install is no longer supported and will stop working, so please migrate to Kimi Code CLI.
