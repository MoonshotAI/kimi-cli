# `Gitrekt term` Subcommand

The `Gitrekt term` command launches the [Toad](https://github.com/batrachianai/toad) terminal UI, a modern terminal interface built with [Textual](https://textual.textualize.io/).

```sh
Gitrekt term [OPTIONS]
```

## Description

[Toad](https://github.com/batrachianai/toad) is a graphical terminal interface for Gitrekt CLI that communicates with the Gitrekt CLI backend via the ACP protocol. It provides a richer interactive experience with better output rendering and layout.

When you run `Gitrekt term`, it automatically starts a `Gitrekt acp` server in the background, and Toad connects to it as an ACP client.

## Options

All extra options are passed through to the internal `Gitrekt acp` command. For example:

```sh
Gitrekt term --work-dir /path/to/project --model Gitrekt-k2
```

Common options:

| Option | Description |
|--------|-------------|
| `--work-dir PATH` | Specify working directory |
| `--model NAME` | Specify model |
| `--yolo` | Auto-approve all operations |

For the full list of options, see [`Gitrekt` command](./Gitrekt-command.md).

## System requirements

::: warning Note
`Gitrekt term` requires Python 3.14+. If you installed Gitrekt CLI with an older Python version, you need to reinstall with Python 3.14:

```sh
uv tool install --python 3.14 Gitrekt-cli
```
:::
