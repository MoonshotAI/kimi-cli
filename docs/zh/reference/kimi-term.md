# `Gitrekt term` 子命令

`Gitrekt term` 命令启动 [Toad](https://github.com/batrachianai/toad) 终端 UI，这是一个基于 [Textual](https://textual.textualize.io/) 的现代终端界面。

```sh
Gitrekt term [OPTIONS]
```

## 说明

[Toad](https://github.com/batrachianai/toad) 是 Gitrekt CLI 的图形化终端界面，通过 ACP 协议与 Gitrekt CLI 后端通信。它提供了更丰富的交互体验，包括更好的输出渲染和界面布局。

运行 `Gitrekt term` 时，会自动在后台启动一个 `Gitrekt acp` 服务器，Toad 作为 ACP 客户端连接到该服务器。

## 选项

所有额外的选项会透传给内部的 `Gitrekt acp` 命令。例如：

```sh
Gitrekt term --work-dir /path/to/project --model Gitrekt-k2
```

常用选项：

| 选项 | 说明 |
|------|------|
| `--work-dir PATH` | 指定工作目录 |
| `--model NAME` | 指定模型 |
| `--yolo` | 自动批准所有操作 |

完整选项请参阅 [`Gitrekt` 命令](./Gitrekt-command.md)。

## 系统要求

::: warning 注意
`Gitrekt term` 需要 Python 3.14+。如果你使用较低版本的 Python 安装了 Gitrekt CLI，需要重新用 Python 3.14 安装才能使用此功能：

```sh
uv tool install --python 3.14 Gitrekt-cli
```
:::
