# 开始使用

## Kimi CLI 是什么

Kimi CLI 是一个运行在终端中的 AI Agent，帮助你完成软件开发任务和终端操作。它可以阅读和编辑代码、执行 Shell 命令、搜索和抓取网页，并在执行过程中自主规划和调整行动。

Kimi CLI 适合以下场景：

- **编写和修改代码**：实现新功能、修复 bug、重构代码
- **理解项目**：探索陌生的代码库，解答架构和实现问题
- **自动化任务**：批量处理文件、执行构建和测试、运行脚本

Kimi CLI 在终端中提供类似 Shell 的交互体验，你可以用自然语言描述需求，也可以随时切换到 Shell 模式直接执行命令。除了终端使用，Kimi CLI 还支持通过 [Agent Client Protocol] 集成到 IDE 和其他本地 Agent 客户端中。

::: warning 注意
Kimi CLI 目前处于技术预览阶段，功能和 API 可能会发生变化。如果你遇到问题或有建议，欢迎在 [GitHub Issues](https://github.com/MoonshotAI/kimi-cli/issues) 反馈。
:::

[Agent Client Protocol]: https://agentclientprotocol.com/

## 安装与升级

Kimi CLI 是一个 Python 程序，需要 Python 3.12 或更高版本。我们推荐使用 [uv](https://docs.astral.sh/uv/) 进行安装和管理，它是一个快速的 Python 包管理工具。

如果你还没有安装 uv，请参考 [uv 安装文档](https://docs.astral.sh/uv/getting-started/installation/)完成安装。

安装 Kimi CLI：

```sh
uv tool install --python 3.13 kimi-cli
```

验证安装是否成功：

```sh
kimi --help
```

::: tip 提示
由于 macOS 的安全检查机制，首次运行 `kimi` 命令可能需要 10 秒或更长时间，这是正常现象。
:::

升级到最新版本：

```sh
uv tool upgrade kimi-cli --no-cache
```

卸载 Kimi CLI：

```sh
uv tool uninstall kimi-cli
```

## 第一次运行

在你想要工作的项目目录中运行 `kimi` 命令启动 Kimi CLI：

```sh
cd your-project
kimi
```

首次启动时，你需要配置 API 平台和模型。输入 `/setup` 命令进入配置向导：

1. 选择 API 平台（如 Kimi for Coding、Moonshot AI 开放平台）
2. 输入你的 API 密钥
3. 选择要使用的模型

配置完成后，Kimi CLI 会自动保存设置并重新加载。

现在你可以直接用自然语言和 Kimi CLI 对话了。试着描述你想完成的任务，比如：

```
帮我看一下这个项目的目录结构
```

输入 `/help` 可以查看所有可用的斜杠命令和使用提示。

