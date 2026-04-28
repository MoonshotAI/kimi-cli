# 斜杠命令

斜杠命令是 Kimi Code CLI 的内置命令，用于控制会话、配置和调试。在输入框中输入 `/` 开头的命令即可触发。

::: tip Shell 模式
部分斜杠命令在 Shell 模式下也可以使用，包括 `/help`、`/exit`、`/version`、`/editor`、`/theme`、`/changelog`、`/feedback`、`/export`、`/import` 和 `/task`。
:::

## 帮助与信息

### `/help`

显示帮助信息。在全屏分页器中列出键盘快捷键、所有可用的斜杠命令以及已加载的 Skills。按 `q` 退出。

别名：`/h`、`/?`

### `/version`

显示 Kimi Code CLI 版本号。

### `/changelog`

显示最近版本的变更记录。

别名：`/release-notes`

### `/feedback`

提交反馈以改进 Kimi Code CLI。执行后会提示输入反馈内容并提交。如果网络请求失败或超时，会自动回退到打开 GitHub Issues 页面。

## 账号与配置

### `/login`

登录或配置 API 平台。执行后首先选择平台：

- **Kimi Code**：自动打开浏览器进行 OAuth 授权登录
- **其他平台**：输入 API 密钥，然后选择可用模型

配置完成后自动保存到 `~/.kimi/config.toml` 并重新加载。详见 [平台与模型](../configuration/providers.md)。

别名：`/setup`

::: tip 提示
此命令仅在使用默认配置文件时可用。如果通过 `--config` 或 `--config-file` 指定了配置，则无法使用此命令。
:::

### `/logout`

登出当前平台。会清理存储的凭据并移除配置文件中的相关配置。登出后 Kimi Code CLI 会自动重新加载配置。

### `/model`

切换模型和 Thinking 模式。

此命令会先从 API 平台刷新可用模型列表。不带参数调用时，显示交互式选择界面，首先选择模型，然后选择是否开启 Thinking 模式（如果模型支持）。

选择完成后，Kimi Code CLI 会自动更新配置文件并重新加载。

::: tip 提示
此命令仅在使用默认配置文件时可用。如果通过 `--config` 或 `--config-file` 指定了配置，则无法使用此命令。
:::

### `/editor`

设置外部编辑器。不带参数调用时，显示交互式选择界面；也可以直接指定编辑器命令，如 `/editor vim`。配置后按 `Ctrl-O` 会使用此编辑器打开当前输入内容。详见 [键盘快捷键](./keyboard.md#外部编辑器)。

### `/theme`

切换终端配色主题。Kimi Code CLI 提供深色（`dark`）和浅色（`light`）两套配色方案，默认使用深色主题。

用法：

- `/theme`：显示当前主题
- `/theme dark`：切换到深色主题
- `/theme light`：切换到浅色主题

切换后配置会保存到 `config.toml` 并自动重新加载。浅色主题会调整 Diff 高亮、任务浏览器、提示符补全菜单、底部工具栏和 MCP 状态等所有 UI 组件的颜色，以适配浅色终端背景。也可以直接在配置文件中设置 `theme = "light"`，详见 [配置文件](../configuration/config-files.md)。

### `/reload`

重新加载配置文件，无需退出 Kimi Code CLI。

### `/debug`

显示当前上下文的调试信息，包括：
- 消息数量和 token 数
- 检查点数量
- 完整的消息历史

调试信息会在分页器中显示，按 `q` 退出。

### `/usage`

显示 API 用量和配额信息，以进度条和剩余百分比的形式展示各类配额的使用情况。

别名：`/status`

::: tip 提示
此命令仅适用于 Kimi Code 平台。
:::

### `/mcp`

显示当前连接的 MCP 服务器和加载的工具。详见 [Model Context Protocol](../customization/mcp.md)。

输出包括：
- 服务器连接状态（绿色表示已连接）
- 每个服务器提供的工具列表

### `/hooks`

显示当前配置的 hooks。详见 [Hooks](../customization/hooks.md)。

输出包括：
- 已配置 hook 的事件类型和数量
- 提示信息（如果未配置任何 hook）

## 会话管理

### `/new`

创建一个新会话并立即切换过去，无需退出 Kimi Code CLI。如果当前会话没有任何内容，会自动清理空会话目录。

### `/sessions`

列出当前工作目录下的所有会话，可切换到其他会话。

别名：`/resume`

使用方向键选择会话，按 `Enter` 确认切换，按 `Ctrl-C` 取消。按 `Ctrl-A` 可在 「仅当前目录」 和 「所有目录」 之间切换会话范围。

### `/title`

查看或设置当前会话的标题。设置的标题会显示在 `/sessions` 列表中，方便识别和查找会话。

别名：`/rename`

用法：

- `/title`：显示当前会话标题
- `/title <text>`：设置会话标题（最长 200 字符）

标题在首次对话后会自动从用户消息中生成；使用此命令手动设置后，自动生成将不再覆盖。

### `/undo`

回退到之前的某个轮次并重试。执行后会弹出交互式选择器，展示所有历史轮次的用户消息（截断到 80 字符）。选中某个轮次后，Kimi Code CLI 会 fork 出一个新会话，包含该轮次**之前**的所有对话历史，并将被选中轮次的用户消息预填到输入框，方便编辑后重新发送。原会话始终保留不丢失。

使用方向键选择轮次，按 `Enter` 确认，按 `Ctrl-C` 取消。

::: tip 使用场景
当 API 返回截断或异常的回复导致会话无法继续时，使用 `/undo` 可以回退到出问题之前的轮次重新开始，无需放弃整个会话。
:::

### `/fork`

从当前会话 fork 出一个新会话，复制完整的对话历史。原会话保留不变，新会话成为当前活动会话。适用于需要从当前状态分支出不同方向尝试的场景。

### `/export`

将当前会话的上下文导出为 Markdown 文件，方便归档或分享。

用法：

- `/export`：导出到当前工作目录，文件名自动生成（格式为 `kimi-export-<会话ID前8位>-<时间戳>.md`）
- `/export <path>`：导出到指定路径。如果路径是目录，文件名会自动生成；如果是文件路径，则直接写入该文件

导出文件包含：
- 会话元数据（会话 ID、导出时间、工作目录、消息数、token 数）
- 对话概览（主题、轮次数、工具调用次数）
- 完整的对话历史，按轮次组织，包括用户消息、AI 回复、工具调用和工具结果

### `/import`

从文件或其他会话导入上下文到当前会话。导入的内容会作为参考上下文附加到当前对话中，AI 可以利用这些信息来辅助后续的交互。

用法：

- `/import <file_path>`：从文件导入。支持 Markdown、文本、代码、配置文件等常见文本格式；不支持二进制文件（如图片、PDF、压缩包）
- `/import <session_id>`：从指定会话 ID 导入。不能导入当前会话自身

### `/clear`

清空当前会话的上下文，开始新的对话。

别名：`/reset`

### `/compact`

手动压缩上下文，减少 token 使用。可以在命令后附带自定义指引，告诉 AI 在压缩时优先保留哪些信息，例如 `/compact 保留数据库相关的讨论`。

当上下文过长时，Kimi Code CLI 会自动触发压缩。此命令可手动触发压缩过程。

## Skills

### `/skill:<name>`

加载指定的 Skill，将 `SKILL.md` 内容作为提示词发送给 Agent。此命令适用于普通 Skill 和 Flow Skill。

例如：

- `/skill:code-style`：加载代码风格规范
- `/skill:pptx`：加载 PPT 制作流程
- `/skill:git-commits 修复用户登录问题`：加载 Skill 并附带额外的任务描述

命令后面可以附带额外的文本，这些内容会追加到 Skill 提示词之后。详见 [Agent Skills](../customization/skills.md)。

::: tip 提示
Flow Skill 也可以通过 `/skill:<name>` 调用，此时作为普通 Skill 加载内容，不会自动执行流程。如需执行流程，请使用 `/flow:<name>`。
:::

### `/flow:<name>`

执行指定的 Flow Skill。Flow Skill 在 `SKILL.md` 中内嵌 Agent Flow 流程图，执行后 Agent 会从 `BEGIN` 节点开始，按照流程图定义依次处理每个节点，直到到达 `END` 节点。

例如：

- `/flow:code-review`：执行代码审查工作流
- `/flow:release`：执行发布工作流

::: tip 提示
Flow Skill 也可以通过 `/skill:<name>` 调用，此时作为普通 Skill 加载内容，不会自动执行流程。
:::

详见 [Agent Skills](../customization/skills.md#flow-skills)。

## 工作区

### `/add-dir`

将额外目录添加到工作区范围。添加后，该目录对所有文件工具（`ReadFile`、`WriteFile`、`Glob`、`Grep`、`StrReplaceFile` 等）可用，并会在系统提示词中展示目录结构。添加的目录会随会话状态持久化，恢复会话时自动还原。

用法：

- `/add-dir <path>`：添加指定目录到工作区
- `/add-dir`：不带参数时列出已添加的额外目录

::: tip 提示
已在工作目录内的目录无需添加，因为它们已经可访问。也可以在启动时通过 `--add-dir` 参数添加，详见 [`kimi` 命令](./kimi-command.md#工作目录)。
:::

## 其他

### `/btw`

在不打断主对话的情况下提出快速侧问。在空闲和 streaming 期间均可使用。

用法：`/btw <问题>`

侧问在隔离的上下文中运行：能看到对话历史但不会修改它。工具调用被禁用——响应仅基于模型对当前对话的已有了解，以纯文本形式回答。

在 streaming 期间，响应会显示在一个可滚动的模态面板中，覆盖在提示区域上方。使用 `↑`/`↓` 滚动，`Escape` 关闭。

::: tip
此命令仅在交互式 Shell 模式下可用。Wire 和 ACP 客户端可使用 `BtwBegin`/`BtwEnd` Wire 事件配合 `run_side_question()` API。
:::

### `/init`

分析当前项目并生成 `AGENTS.md` 文件。

此命令会启动一个临时子会话分析代码库结构，生成项目说明文档，帮助 Agent 更好地理解项目。

### `/plan`

切换 Plan 模式。Plan 模式下 AI 只能使用只读工具探索代码库，将实施方案写入 plan 文件后提交给你审批。详见 [Plan 模式](../guides/interaction.md#plan-模式)。

用法：

- `/plan`：切换 Plan 模式开关
- `/plan on`：开启 Plan 模式
- `/plan off`：关闭 Plan 模式
- `/plan view`：查看当前方案内容
- `/plan clear`：清除当前方案文件

开启 Plan 模式后，提示符变为 `📋`，底部状态栏显示蓝色的 `plan` 标识。

### `/task`

打开交互式任务浏览器，查看、监控和管理后台任务。

任务浏览器为三列 TUI 界面：

- **左列**：任务列表，显示任务 ID、状态和描述
- **中列**：选中任务的详细信息，包括 ID、状态、描述、时间、exit code 等
- **右列**：最后几行输出预览

支持以下键盘操作：

| 快捷键 | 功能 |
|--------|------|
| `Enter` / `O` | 在分页器中查看选中任务的完整输出 |
| `S` | 请求停止选中任务（需确认） |
| `Tab` | 切换过滤模式（全部 / 仅活跃任务） |
| `R` | 刷新任务列表 |
| `Q` / `Esc` | 退出浏览器 |

任务浏览器每秒自动刷新，实时显示任务状态变化。

::: tip 提示
后台任务通过 AI 使用 `Shell` 工具的 `run_in_background=true` 参数启动。当后台任务完成时，系统会自动通知 AI。
:::

### `/yolo`

切换 YOLO 模式。开启后自动批准所有工具调用，底部状态栏会显示黄色的 YOLO 标识；再次输入可关闭。YOLO 只解除审批摩擦——Agent 仍可通过 `AskUserQuestion` 向你提问。`/yolo` 与 `/afk` 相互独立。

::: warning 注意
YOLO 模式会跳过所有审批确认，请确保你了解可能的风险。
:::

### `/afk`

切换 AFK（away-from-keyboard）模式。开启后会自动批准所有工具调用，并进一步自动 dismiss Agent 发出的任何 `AskUserQuestion`——让 Agent 自己做判断，不再等待一个永远不会到来的回答。状态栏会显示独立的橙色 AFK 标识，与 YOLO 标识互不相干；再次输入可关闭。

::: warning 注意
AFK 会跳过所有审批确认，并且去掉提问澄清的安全网。仅在你确实无法守在终端前时使用。
:::

### `/web`

切换到 Web UI。执行后 Kimi Code CLI 会启动 Web UI 服务器并在浏览器中打开当前会话，你可以在 Web UI 中继续对话。详见 [Web UI](./kimi-web.md)。

### `/vis`

切换到 Agent Tracing Visualizer。执行后 Kimi Code CLI 会启动可视化面板服务器并在浏览器中打开当前会话的追踪视图，你可以在其中检查 Wire 事件时间线、上下文消息和用量统计。详见 [Agent Tracing Visualizer](./kimi-vis.md)。

## 命令补全

在输入框中输入 `/` 后，会自动显示可用命令列表。继续输入可过滤命令，支持模糊匹配，按 Enter 选择。

例如，输入 `/ses` 会匹配到 `/sessions`，输入 `/clog` 会匹配到 `/changelog`。命令的别名也支持匹配，例如输入 `/h` 会匹配到 `/help`。
