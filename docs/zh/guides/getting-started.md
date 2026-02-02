# 开始使用

## Kimi Code CLI 是什么

Kimi Code CLI 是一个运行在终端中的 AI Agent，帮助你完成软件开发任务和终端操作。它可以阅读和编辑代码、执行 Shell 命令、搜索和抓取网页，并在执行过程中自主规划和调整行动。

Kimi Code CLI 适合以下场景：

- **编写和修改代码**：实现新功能、修复 bug、重构代码
- **理解项目**：探索陌生的代码库，解答架构和实现问题
- **自动化任务**：批量处理文件、执行构建和测试、运行脚本

Kimi Code CLI 在终端中提供类似 Shell 的交互体验，你可以用自然语言描述需求，也可以随时切换到 Shell 模式直接执行命令。除了终端使用，Kimi Code CLI 还支持通过 [Agent Client Protocol] 集成到 [IDE](./ides.md) 和其他本地 Agent 客户端中。

::: info 提示
如果你遇到问题或有建议，欢迎在 [GitHub Issues](https://github.com/MoonshotAI/kimi-cli/issues) 反馈。
:::

[Agent Client Protocol]: https://agentclientprotocol.com/

## 安装

运行安装脚本即可完成安装。脚本会先安装 [uv](https://docs.astral.sh/uv/)（Python 包管理工具），再通过 uv 安装 Kimi Code CLI：

```sh
# Linux / macOS
curl -LsSf https://code.kimi.com/install.sh | bash
```

```powershell
# Windows (PowerShell)
Invoke-RestMethod https://code.kimi.com/install.ps1 | Invoke-Expression
```

验证安装是否成功：

```sh
kimi --version
```

::: tip 提示
由于 macOS 的安全检查机制，首次运行 `kimi` 命令可能需要较长时间。可以在「系统设置 → 隐私与安全性 → 开发者工具」中添加你的终端应用来加速后续启动。
:::

如果你已经安装了 uv，也可以直接运行：

```sh
uv tool install --python 3.13 kimi-cli
```

::: tip 提示
Kimi Code CLI 支持 Python 3.12-3.14，但建议使用 3.13 以获得最佳兼容性。
:::

## 升级与卸载

升级到最新版本：

```sh
uv tool upgrade kimi-cli --no-cache
```

卸载 Kimi Code CLI：

```sh
uv tool uninstall kimi-cli
```

## 第一次运行

在你想要工作的项目目录中运行 `kimi` 命令启动 Kimi Code CLI：

```sh
cd your-project
kimi
```

首次启动时，你需要配置 API 来源。输入 `/login` 命令开始配置：

```
/login
```

执行后首先选择平台。推荐选择 **Kimi Code**，会自动打开浏览器进行 OAuth 授权；选择其他平台则需要输入 API 密钥。配置完成后 Kimi Code CLI 会自动保存设置并重新加载。详见 [平台与模型](../configuration/providers.md)。

现在你可以直接用自然语言和 Kimi Code CLI 对话了。试着描述你想完成的任务，比如：

```
帮我看一下这个项目的目录结构
```

::: tip 提示
如果项目中没有 `AGENTS.md` 文件，可以运行 `/init` 命令让 Kimi Code CLI 分析项目并生成该文件，帮助 AI 更好地理解项目结构和规范。
:::

输入 `/help` 可以查看所有可用的 [斜杠命令](../reference/slash-commands.md) 和使用提示。
