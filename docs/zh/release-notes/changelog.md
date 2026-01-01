# 变更记录

本页面记录 Kimi CLI 各版本的变更内容。

## [Unreleased]

- ACP：通过 ACP 客户端路由文件读写和 Shell 命令，实现同步编辑/输出
- Shell：添加 `/model` 斜杠命令，在使用默认配置时切换默认模型并重新加载
- Skills：添加 `/skill:<name>` 斜杠命令，按需加载 `SKILL.md` 指引
- CLI：添加 `kimi term` 命令，启动 Toad 终端 UI
- Python：将默认工具/CI 版本升级到 3.14

## 0.70 (2025-12-31)

- CLI：添加 `--final-message-only`（及 `--quiet` 别名），在 Print 模式下仅输出最终的 assistant 消息
- LLM：添加 `video_in` 模型能力，支持视频输入

## 0.69 (2025-12-29)

- Core：支持在 `~/.kimi/skills` 或 `~/.claude/skills` 中发现 Skills
- Python：降低最低 Python 版本要求至 3.12
- Nix：添加 flake 打包支持；可通过 `nix profile install .#kimi-cli` 安装或 `nix run .#kimi-cli` 运行
- CLI：添加 `kimi-cli` 脚本别名；可通过 `uvx kimi-cli` 运行
- Lib：将 LLM 配置验证移入 `create_llm`，配置缺失时返回 `None`

## 0.68 (2025-12-24)

- CLI：添加 `--config` 和 `--config-file` 选项，支持传入 JSON/TOML 配置
- Core：`KimiCLI.create` 的 `config` 参数现在除了 `Path` 也支持 `Config` 类型
- Tool：在 `WriteFile` 和 `StrReplaceFile` 的审批/结果中包含 diff 显示块
- Wire：在审批请求中添加显示块（包括 diff），保持向后兼容
- ACP：在工具结果和审批提示中显示文件 diff 预览
- ACP：连接 ACP 客户端管理的 MCP 服务器
- ACP：如果支持，在 ACP 客户端终端中运行 Shell 命令
- Lib：添加 `KimiToolset.find` 方法，按类或名称查找工具
- Lib：添加 `ToolResultBuilder.display` 方法，向工具结果追加显示块
- MCP：添加 `kimi mcp auth` 及相关子命令，管理 MCP 授权

## 0.67 (2025-12-22)

- ACP：在单会话 ACP 模式（`kimi --acp`）中广播斜杠命令
- MCP：添加 `mcp.client` 配置节，用于配置 MCP 工具调用超时等选项
- Core：改进默认系统提示词和 `ReadFile` 工具
- UI：修复某些罕见情况下 Ctrl-C 不工作的问题

## 0.66 (2025-12-19)

- Lib：在 `StatusUpdate` Wire 消息中提供 `token_usage` 和 `message_id`
- Lib：添加 `KimiToolset.load_tools` 方法，支持依赖注入加载工具
- Lib：添加 `KimiToolset.load_mcp_tools` 方法，加载 MCP 工具
- Lib：将 `MCPTool` 从 `kimi_cli.tools.mcp` 移至 `kimi_cli.soul.toolset`
- Lib：添加 `InvalidToolError`、`MCPConfigError` 和 `MCPRuntimeError` 异常类
- Lib：使 Kimi CLI 详细异常类扩展 `ValueError` 或 `RuntimeError`
- Lib：`KimiCLI.create` 和 `load_agent` 的 `mcp_configs` 参数支持传入验证后的 `list[fastmcp.mcp_config.MCPConfig]`
- Lib：修复 `KimiCLI.create`、`load_agent`、`KimiToolset.load_tools` 和 `KimiToolset.load_mcp_tools` 的异常抛出
- LLM：添加 `vertexai` 供应商类型，支持 Vertex AI
- LLM：将 Gemini Developer API 的供应商类型从 `google_genai` 重命名为 `gemini`
- Config：配置文件从 JSON 迁移至 TOML
- MCP：后台并行连接 MCP 服务器，减少启动时间
- MCP：连接 MCP 服务器时添加 `mcp-session-id` HTTP 头
- Lib：将斜杠命令（原"元命令"）拆分为两组：Shell 级和 KimiSoul 级
- Lib：在 `Soul` 协议中添加 `available_slash_commands` 属性
- ACP：向 ACP 客户端广播 `/init`、`/compact` 和 `/yolo` 斜杠命令
- SlashCmd：添加 `/mcp` 斜杠命令，显示 MCP 服务器和工具状态

## 0.65 (2025-12-16)

- Lib：支持通过 `Session.create(work_dir, session_id)` 创建命名会话
- CLI：指定的会话 ID 不存在时自动创建新会话
- CLI：退出时删除空会话，列表中忽略上下文文件为空的会话
- UI：改进会话回放
- Lib：在 `LLM` 类中添加 `model_config: LLMModel | None` 和 `provider_config: LLMProvider | None` 属性
- MetaCmd：添加 `/usage` 元命令，为 Kimi for Coding 用户显示 API 使用情况

## 0.64 (2025-12-15)

- UI：修复 Windows 上 UTF-16 代理字符输入问题
- Core：添加 `/sessions` 元命令，列出现有会话并切换到选中的会话
- CLI：添加 `--session/-S` 选项，指定要恢复的会话 ID
- MCP：添加 `kimi mcp` 子命令组，管理全局 MCP 配置文件 `~/.kimi/mcp.json`

## 0.63 (2025-12-12)

- Tool：修复 `FetchURL` 工具通过服务获取失败时输出不正确的问题
- Tool：在 `Shell` 工具中使用 `bash` 而非 `sh`，提高兼容性
- Tool：修复 Windows 上 `Grep` 工具的 Unicode 解码错误
- ACP：通过 `kimi acp` 子命令支持 ACP 会话续接（列出/加载会话）
- Lib：添加 `Session.find` 和 `Session.list` 静态方法，查找和列出会话
- ACP：调用 `SetTodoList` 工具时在客户端更新 Agent 计划
- UI：防止以 `/` 开头的普通消息被误当作元命令处理

## 0.62 (2025-12-08)

- ACP：修复工具结果（包括 Shell 工具输出）在 Zed 等 ACP 客户端中不显示的问题
- ACP：修复与最新版 Zed IDE (0.215.3) 的兼容性
- Tool：Windows 上使用 PowerShell 替代 CMD，提升可用性
- Core：修复工作目录中存在损坏符号链接时的启动崩溃
- Core：添加内置 `okabe` Agent 文件，启用 `SendDMail` 工具
- CLI：添加 `--agent` 选项，指定内置 Agent（如 `default`、`okabe`）
- Core：改进压缩逻辑，更好地保留相关信息

## 0.61 (2025-12-04)

- Lib：修复作为库使用时的日志问题
- Tool：加强文件路径检查，防止共享前缀逃逸
- LLM：改进与部分第三方 OpenAI Responses 和 Anthropic API 供应商的兼容性

## 0.60 (2025-12-01)

- LLM：修复 Kimi 和 OpenAI 兼容供应商的交错思考问题

## 0.59 (2025-11-28)

- Core：将上下文文件位置移至 `.kimi/sessions/{workdir_md5}/{session_id}/context.jsonl`
- Lib：将 `WireMessage` 类型别名移至 `kimi_cli.wire.message`
- Lib：添加 `kimi_cli.wire.message.Request` 类型别名，用于请求消息（目前仅包含 `ApprovalRequest`）
- Lib：添加 `kimi_cli.wire.message.is_event`、`is_request` 和 `is_wire_message` 工具函数，检查 Wire 消息类型
- Lib：添加 `kimi_cli.wire.serde` 模块，用于 Wire 消息的序列化和反序列化
- Lib：修改 `StatusUpdate` Wire 消息，不再使用 `kimi_cli.soul.StatusSnapshot`
- Core：在会话目录中记录 Wire 消息到 JSONL 文件
- Core：引入 `TurnBegin` Wire 消息，标记每个 Agent 轮次的开始
- UI：Shell 模式下用面板重新打印用户输入
- Lib：添加 `Session.dir` 属性，获取会话目录路径
- UI：改进多个并行子代理时的"本会话批准"体验
- Wire：重新实现 Wire 服务器模式（通过 `--wire` 选项启用）
- Lib：重命名类以保持一致性：`ShellApp` → `Shell`，`PrintApp` → `Print`，`ACPServer` → `ACP`，`WireServer` → `WireOverStdio`
- Lib：重命名方法以保持一致性：`KimiCLI.run_shell_mode` → `run_shell`，`run_print_mode` → `run_print`，`run_acp_server` → `run_acp`，`run_wire_server` → `run_wire_stdio`
- Lib：添加 `KimiCLI.run` 方法，使用给定用户输入运行一轮并产生 Wire 消息
- Print：修复 stream-json 打印模式输出刷新不正确的问题
- LLM：改进与部分 OpenAI 和 Anthropic API 供应商的兼容性
- Core：修复使用 Anthropic API 时压缩后的聊天供应商错误

## 0.58 (2025-11-21)

- Core：修复使用 `extend` 时 Agent 规格文件的字段继承问题
- Core：支持在子代理中使用 MCP 工具
- Tool：添加 `CreateSubagent` 工具，动态创建子代理（默认 Agent 中未启用）
- Tool：Kimi for Coding 方案在 `FetchURL` 工具中使用 MoonshotFetch 服务
- Tool：截断 Grep 工具输出，避免超出 token 限制

## 0.57 (2025-11-20)

- LLM：修复思考开关未开启时的 Google GenAI 供应商问题
- UI：改进审批请求措辞
- Tool：移除 `PatchFile` 工具
- Tool：将 `Bash`/`CMD` 工具重命名为 `Shell` 工具
- Tool：将 `Task` 工具移至 `kimi_cli.tools.multiagent` 模块

## 0.56 (2025-11-19)

- LLM：添加 Google GenAI 供应商支持

## 0.55 (2025-11-18)

- Lib：添加 `kimi_cli.app.enable_logging` 函数，直接使用 `KimiCLI` 类时启用日志
- Core：修复 Agent 规格文件中的相对路径解析
- Core：防止 LLM API 连接失败时 panic
- Tool：优化 `FetchURL` 工具，改进内容提取
- Tool：将 MCP 工具调用超时增加到 60 秒
- Tool：在 `Glob` 工具中提供更好的错误消息（当模式为 `**` 时）
- ACP：修复思考内容显示不正确的问题
- UI：Shell 模式的小幅 UI 改进

## 0.54 (2025-11-13)

- Lib：将 `WireMessage` 从 `kimi_cli.wire.message` 移至 `kimi_cli.wire`
- Print：修复 `stream-json` 输出格式缺少最后一条助手消息的问题
- UI：当 API 密钥被 `KIMI_API_KEY` 环境变量覆盖时添加警告
- UI：审批请求时发出提示音
- Core：修复 Windows 上的上下文压缩和清除问题

## 0.53 (2025-11-12)

- UI：移除控制台输出中不必要的尾部空格
- Core：存在不支持的消息部分时抛出错误
- MetaCmd：添加 `/yolo` 元命令，启动后启用 YOLO 模式
- Tool：为 MCP 工具添加审批请求
- Tool：在默认 Agent 中禁用 `Think` 工具
- CLI：未指定 `--thinking` 时恢复上次的思考模式
- CLI：修复 PyInstaller 打包的二进制文件中 `/reload` 不工作的问题

## 0.52 (2025-11-10)

- CLI：移除 `--ui` 选项，改用 `--print`、`--acp` 和 `--wire` 标志（Shell 仍为默认）
- CLI：更直观的会话续接行为
- Core：为 LLM 空响应添加重试
- Tool：Windows 上将 `Bash` 工具改为 `CMD` 工具
- UI：修复退格后的补全问题
- UI：修复浅色背景下代码块的渲染问题

## 0.51 (2025-11-08)

- Lib：将 `Soul.model` 重命名为 `Soul.model_name`
- Lib：将 `LLMModelCapability` 重命名为 `ModelCapability` 并移至 `kimi_cli.llm`
- Lib：在 `ModelCapability` 中添加 `"thinking"`
- Lib：移除 `LLM.supports_image_in` 属性
- Lib：添加必需的 `Soul.model_capabilities` 属性
- Lib：将 `KimiSoul.set_thinking_mode` 重命名为 `KimiSoul.set_thinking`
- Lib：添加 `KimiSoul.thinking` 属性
- UI：改进 LLM 模型能力检查和提示
- UI：`/clear` 元命令时清屏
- Tool：支持 Windows 上自动下载 ripgrep
- CLI：添加 `--thinking` 选项，以思考模式启动
- ACP：ACP 模式支持思考内容

## 0.50 (2025-11-07)

- 改进 UI 外观和体验
- 改进 Task 工具可观测性

## 0.49 (2025-11-06)

- 小幅用户体验改进

## 0.48 (2025-11-06)

- 支持 Kimi K2 思考模式

## 0.47 (2025-11-05)

- 修复某些环境下 Ctrl-W 不工作的问题
- 搜索服务未配置时不加载 SearchWeb 工具

## 0.46 (2025-11-03)

- 引入 Wire over stdio 用于本地 IPC（实验性，可能变更）
- 支持 Anthropic 供应商类型

- 修复 PyInstaller 打包的二进制文件因入口点错误而无法工作的问题

## 0.45 (2025-10-31)

- 允许 `KIMI_MODEL_CAPABILITIES` 环境变量覆盖模型能力
- 添加 `--no-markdown` 选项禁用 Markdown 渲染
- 支持 `openai_responses` LLM 供应商类型

- 修复续接会话时的崩溃问题

## 0.44 (2025-10-30)

- 改进启动时间

- 修复用户输入中可能出现的无效字节

## 0.43 (2025-10-30)

- 基础 Windows 支持（实验性）
- 环境变量覆盖 base URL 或 API 密钥时显示警告
- 如果 LLM 模型支持，则支持图片输入
- 续接会话时回放近期上下文历史

- 确保执行 Shell 命令后换行

## 0.42 (2025-10-28)

- 支持 Ctrl-J 或 Alt-Enter 插入换行

- 模式切换快捷键从 Ctrl-K 改为 Ctrl-X
- 改进整体健壮性

- 修复 ACP 服务器 `no attribute` 错误

## 0.41 (2025-10-26)

- 修复 Glob 工具未找到匹配文件时的 bug
- 确保使用 UTF-8 编码读取文件

- Shell 模式下禁用从 stdin 读取命令/查询
- 澄清 `/setup` 元命令中的 API 平台选择

## 0.40 (2025-10-24)

- 支持 `ESC` 键中断 Agent 循环

- 修复某些罕见情况下的 SSL 证书验证错误
- 修复 Bash 工具中可能的解码错误

## 0.39 (2025-10-24)

- 修复上下文压缩阈值检查
- 修复 Shell 会话中设置 SOCKS 代理时的 panic

## 0.38 (2025-10-24)

- 小幅用户体验改进

## 0.37 (2025-10-24)

- 修复更新检查

## 0.36 (2025-10-24)

- 添加 `/debug` 元命令用于调试上下文
- 添加自动上下文压缩
- 添加审批请求机制
- 添加 `--yolo` 选项自动批准所有操作
- 渲染 Markdown 内容以提高可读性

- 修复中断元命令时的"未知错误"消息

## 0.35 (2025-10-22)

- 小幅 UI 改进
- 系统中未找到 ripgrep 时自动下载
- `--print` 模式下始终批准工具调用
- 添加 `/feedback` 元命令

## 0.34 (2025-10-21)

- 添加 `/update` 元命令检查更新，并在后台自动更新
- 支持在原始 Shell 模式下运行交互式 Shell 命令
- 添加 `/setup` 元命令设置 LLM 供应商和模型
- 添加 `/reload` 元命令重新加载配置

## 0.33 (2025-10-18)

- 添加 `/version` 元命令
- 添加原始 Shell 模式，可通过 Ctrl-K 切换
- 在底部状态栏显示快捷键

- 修复日志重定向
- 合并重复的输入历史

## 0.32 (2025-10-16)

- 添加底部状态栏
- 支持文件路径自动补全（`@filepath`）

- 不在用户输入中间自动补全元命令

## 0.31 (2025-10-14)

- 真正修复 Ctrl-C 中断步骤的问题

## 0.30 (2025-10-14)

- 添加 `/compact` 元命令，允许手动压缩上下文

- 修复上下文为空时的 `/clear` 元命令

## 0.29 (2025-10-14)

- Shell 模式下支持 Enter 键接受补全
- Shell 模式下跨会话记住用户输入历史
- 添加 `/reset` 元命令作为 `/clear` 的别名

- 修复 Ctrl-C 中断步骤的问题

- 在 Kimi Koder Agent 中禁用 `SendDMail` 工具

## 0.28 (2025-10-13)

- 添加 `/init` 元命令分析代码库并生成 `AGENTS.md` 文件
- 添加 `/clear` 元命令清除上下文

- 修复 `ReadFile` 输出

## 0.27 (2025-10-11)

- 添加 `--mcp-config-file` 和 `--mcp-config` 选项加载 MCP 配置

- 将 `--agent` 选项重命名为 `--agent-file`

## 0.26 (2025-10-11)

- 修复 `--output-format stream-json` 模式下可能的编码错误

## 0.25 (2025-10-11)

- 将包名从 `ensoul` 重命名为 `kimi-cli`
- 将 `ENSOUL_*` 内置系统提示词参数重命名为 `KIMI_*`
- 进一步解耦 `App` 与 `Soul`
- 拆分 `Soul` 协议和 `KimiSoul` 实现以提高模块化

## 0.24 (2025-10-10)

- 修复 ACP `cancel` 方法

## 0.23 (2025-10-09)

- 在 Agent 文件中添加 `extend` 字段支持 Agent 文件扩展
- 在 Agent 文件中添加 `exclude_tools` 字段支持排除工具
- 在 Agent 文件中添加 `subagents` 字段支持定义子代理

## 0.22 (2025-10-09)

- 改进 `SearchWeb` 和 `FetchURL` 工具调用可视化
- 改进搜索结果输出格式

## 0.21 (2025-10-09)

- 添加 `--print` 选项作为 `--ui print` 的快捷方式，`--acp` 选项作为 `--ui acp` 的快捷方式
- 支持 `--output-format stream-json` 以 JSON 格式输出
- 添加 `SearchWeb` 工具，使用 `services.moonshot_search` 配置。需要在配置文件中配置 `"services": {"moonshot_search": {"api_key": "your-search-api-key"}}`
- 添加 `FetchURL` 工具
- 添加 `Think` 工具
- 添加 `PatchFile` 工具，Kimi Koder Agent 中未启用
- 在 Kimi Koder Agent 中启用 `SendDMail` 和 `Task` 工具，改进工具提示词
- 添加 `ENSOUL_NOW` 内置系统提示词参数

- 改进 `/release-notes` 外观
- 改进工具描述
- 改进工具输出截断

## 0.20 (2025-09-30)

- 添加 `--ui acp` 选项启动 Agent Client Protocol (ACP) 服务器

## 0.19 (2025-09-29)

- print UI 支持管道输入的 stdin
- 支持 `--input-format=stream-json` 用于管道输入的 JSON

- 未启用 `SendDMail` 时不在上下文中包含 `CHECKPOINT` 消息

## 0.18 (2025-09-29)

- 支持 LLM 模型配置中的 `max_context_size`，配置最大上下文大小（token 数）

- 改进 `ReadFile` 工具描述

## 0.17 (2025-09-29)

- 修复超过最大步数时错误消息中的步数
- 修复 `kimi_run` 中的历史文件断言错误
- 修复 print 模式和单命令 Shell 模式中的错误处理
- 为 LLM API 连接错误和超时错误添加重试

- 将默认 max-steps-per-run 增加到 100

## 0.16.0 (2025-09-26)

- 添加 `SendDMail` 工具（Kimi Koder 中禁用，可在自定义 Agent 中启用）

- 可通过 `_history_file` 参数在创建新会话时指定会话历史文件

## 0.15.0 (2025-09-26)

- 改进工具健壮性

## 0.14.0 (2025-09-25)

- 添加 `StrReplaceFile` 工具

- 强调使用与用户相同的语言

## 0.13.0 (2025-09-25)

- 添加 `SetTodoList` 工具
- 在 LLM API 调用中添加 `User-Agent`

- 改进系统提示词和工具描述
- 改进 LLM 错误消息

## 0.12.0 (2025-09-24)

- 添加 `print` UI 模式，可通过 `--ui print` 选项使用
- 添加日志和 `--debug` 选项

- 捕获 EOF 错误以改善体验

## 0.11.1 (2025-09-22)

- 将 `max_retry_per_step` 重命名为 `max_retries_per_step`

## 0.11.0 (2025-09-22)

- 添加 `/release-notes` 命令
- 为 LLM API 错误添加重试
- 添加循环控制配置，如 `{"loop_control": {"max_steps_per_run": 50, "max_retry_per_step": 3}}`

- 改进 `read_file` 工具的极端情况处理
- 禁止 Ctrl-C 退出 CLI，强制使用 Ctrl-D 或 `exit` 退出

## 0.10.1 (2025-09-18)

- 小幅改进斜杠命令外观
- 改进 `glob` 工具

## 0.10.0 (2025-09-17)

- 添加 `read_file` 工具
- 添加 `write_file` 工具
- 添加 `glob` 工具
- 添加 `task` 工具

- 改进工具调用可视化
- 改进会话管理
- `--continue` 会话时恢复上下文使用量

## 0.9.0 (2025-09-15)

- 移除 `--session` 和 `--continue` 选项

## 0.8.1 (2025-09-14)

- 修复配置模型转储

## 0.8.0 (2025-09-14)

- 添加 `shell` 工具和基础系统提示词
- 添加工具调用可视化
- 添加上下文使用量计数
- 支持中断 Agent 循环
- 支持项目级 `AGENTS.md`
- 支持 YAML 定义的自定义 Agent
- 支持通过 `kimi -c` 执行一次性任务
