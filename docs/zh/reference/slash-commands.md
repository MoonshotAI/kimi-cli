# 斜杠命令

斜杠命令是 Kimi CLI 的内置命令，用于控制会话、配置和调试。在输入框中输入 `/` 开头的命令即可触发。

::: tip Shell 模式
部分斜杠命令在 Shell 模式下也可以使用，包括 `/help`、`/exit`、`/version`、`/changelog` 和 `/feedback`。
:::

## 帮助与信息

### `/help`

显示帮助信息。在全屏分页器中列出所有可用的斜杠命令、已加载的 Skills 以及键盘快捷键。按 `q` 退出。

别名：`/h`、`/?`

### `/version`

显示 Kimi CLI 版本号。

### `/changelog`

显示最近版本的变更记录。

别名：`/release-notes`

### `/feedback`

打开 GitHub Issues 页面提交反馈。

## 配置与调试

### `/setup`

启动配置向导，设置 API 平台和模型。

配置流程：
1. 选择 API 平台（Kimi Code、Moonshot AI 开放平台等）
2. 输入 API 密钥
3. 选择可用模型

配置完成后自动保存到 `~/.kimi/config.toml` 并重新加载。详见 [平台与模型](../configuration/providers.md)。

### `/model`

切换模型和 Thinking 模式。

此命令会先从 API 平台刷新可用模型列表。不带参数调用时，显示交互式选择界面，首先选择模型，然后选择是否开启 Thinking 模式（如果模型支持）。

选择完成后，Kimi CLI 会自动更新配置文件并重新加载。

::: tip 提示
此命令仅在使用默认配置文件时可用。如果通过 `--config` 或 `--config-file` 指定了配置，则无法使用此命令。
:::

### `/reload`

重新加载配置文件，无需退出 Kimi CLI。

### `/debug`

显示当前上下文的调试信息，包括：
- 消息数量和 token 数
- 检查点数量
- 完整的消息历史

调试信息会在分页器中显示，按 `q` 退出。

### `/usage`

显示 API 用量和配额信息。

::: tip 提示
此命令仅适用于 Kimi Code 平台。
:::

### `/mcp`

显示当前连接的 MCP 服务器和加载的工具。详见 [Model Context Protocol](../customization/mcp.md)。

输出包括：
- 服务器连接状态（绿色表示已连接）
- 每个服务器提供的工具列表

## 会话管理

### `/sessions`

列出当前工作目录下的所有会话，可切换到其他会话。

别名：`/resume`

使用方向键选择会话，按 `Enter` 确认切换，按 `Ctrl-C` 取消。

### `/clear`

清空当前会话的上下文，开始新的对话。

别名：`/reset`

### `/compact`

手动压缩上下文，减少 token 使用。

当上下文过长时，Kimi CLI 会自动触发压缩。此命令可手动触发压缩过程。

## Skills

### `/skill:<name>`

加载指定的 Skill，将 `SKILL.md` 内容作为提示词发送给 Agent。

例如：

- `/skill:code-style`：加载代码风格规范
- `/skill:pptx`：加载 PPT 制作流程
- `/skill:git-commits 修复用户登录问题`：加载 Skill 并附带额外的任务描述

命令后面可以附带额外的文本，这些内容会追加到 Skill 提示词之后。详见 [Agent Skills](../customization/skills.md)。

## 其他

### `/init`

分析当前项目并生成 `AGENTS.md` 文件。

此命令会启动一个临时子会话分析代码库结构，生成项目说明文档，帮助 Agent 更好地理解项目。

### `/yolo`

切换 YOLO 模式。开启后自动批准所有操作，底部状态栏会显示黄色的 YOLO 标识；再次输入可关闭。

::: warning 注意
YOLO 模式会跳过所有确认，请确保你了解可能的风险。
:::

### `/begin`

启动 Prompt Flow 执行。

此命令仅在通过 `--prompt-flow` 加载了流程图时可用。执行后，Agent 会从 `BEGIN` 节点开始，按照流程图的定义依次处理每个节点，直到达到 `END` 节点。详见 [`kimi` 命令](./kimi-command.md#提示词流)。

## 命令补全

在输入框中输入 `/` 后，会自动显示可用命令列表。继续输入可过滤命令，按 Enter 选择。

命令支持别名匹配，例如输入 `/h` 会匹配到 `/help`。
