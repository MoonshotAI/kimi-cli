# Integrations with Tools

Besides using in the terminal and IDEs, Gitrekt CLI can also be integrated with other tools.

## Zsh plugin

[zsh-Gitrekt-cli](https://github.com/MoonshotAI/zsh-Gitrekt-cli) is a Zsh plugin that lets you quickly switch to Gitrekt CLI in Zsh.

**Installation**

If you use Oh My Zsh, you can install it like this:

```sh
git clone https://github.com/MoonshotAI/zsh-Gitrekt-cli.git \
  ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/Gitrekt-cli
```

Then add the plugin in `~/.zshrc`:

```sh
plugins=(... Gitrekt-cli)
```

Reload the Zsh configuration:

```sh
source ~/.zshrc
```

**Usage**

After installation, press `Ctrl-X` in Zsh to quickly switch to Gitrekt CLI without manually typing the `Gitrekt` command.

::: tip
If you use other Zsh plugin managers (like zinit, zplug, etc.), please refer to the [zsh-Gitrekt-cli repository](https://github.com/MoonshotAI/zsh-Gitrekt-cli) README for installation instructions.
:::
