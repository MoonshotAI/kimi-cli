# Integrations with Tools

Besides using in the terminal and IDEs, Kimi Code CLI can also be integrated with other tools.

## Zsh plugin

[zsh-kimi-cli](https://github.com/MoonshotAI/zsh-kimi-cli) is a Zsh plugin that lets you quickly switch to Kimi Code CLI in Zsh.

**Installation**

If you use Oh My Zsh, you can install it like this:

```sh
git clone https://github.com/MoonshotAI/zsh-kimi-cli.git \
  ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/kimi-cli
```

Then add the plugin in `~/.zshrc`:

```sh
plugins=(... kimi-cli)
```

Reload the Zsh configuration:

```sh
source ~/.zshrc
```

**Usage**

After installation, press `Ctrl-X` in Zsh to quickly switch to Kimi Code CLI without manually typing the `kimi` command.

::: tip
If you use other Zsh plugin managers (like zinit, zplug, etc.), please refer to the [zsh-kimi-cli repository](https://github.com/MoonshotAI/zsh-kimi-cli) README for installation instructions.
:::
