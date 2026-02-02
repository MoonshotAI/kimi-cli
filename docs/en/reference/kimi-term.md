# `kimi term` subcommand

The `kimi term` command launches the [Toad](https://github.com/batrachianai/toad) terminal UI, a modern terminal interface based on [Textual](https://textual.textualize.io/).

```sh
kimi term [OPTIONS]
```

## Description

[Toad](https://github.com/batrachianai/toad) is the graphical terminal interface for Kimi Code CLI, communicating with the Kimi Code CLI backend via the ACP protocol. It provides a richer interactive experience, including better output rendering and interface layout.

When running `kimi term`, a `kimi acp` server is automatically started in the background, and Toad connects to this server as an ACP client.

## Options

All additional options are passed through to the internal `kimi acp` command. For example:

```sh
kimi term --work-dir /path/to/project --model kimi-k2
```

Common options:

| Option | Description |
|--------|-------------|
| `--work-dir PATH` | Specify the working directory |
| `--model NAME` | Specify the model |
| `--yolo` | Auto-approve all actions |

For the complete list of options, see the [`kimi` command](./kimi-command.md).

## System requirements

::: warning Warning
`kimi term` requires Python 3.14+. If you installed Kimi Code CLI with a lower Python version, you need to reinstall it with Python 3.14 to use this feature:

```sh
uv tool install --python 3.14 kimi-cli
```
:::
