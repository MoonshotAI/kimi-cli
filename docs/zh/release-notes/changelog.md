# Changelog

本文档记录 Kimi Code CLI 每个版本的变更。

## Unreleased

- CLI: 添加 `--starting-prompt` 选项，用于提供初始提示并保持会话开启以便交互

- Web：修复历史记录回放时的 WebSocket 错误，发送前检查连接状态
- Web：Git diff 状态栏现在显示未跟踪文件（尚未添加到 git 的新文件）
- Web：仅在 public 模式下限制敏感 API；更新 origin 执行逻辑

## 1.6 (2026-02-03)

- Web: 为网络模式添加基于令牌的认证和访问控制（`--network`, `--lan-only`, `--public`）
- Web: 添加安全选项：`--auth-token`, `--allowed-origins`, `--restrict-sensitive-apis`, `--dangerously-omit-auth`
- Web: 更改 `--host` 选项以绑定到特定 IP 地址；添加自动网络地址检测
- Web: 修复创建新会话时的 WebSocket 断开问题
- Web: 将最大图片尺寸从 1024 增加到 4096 像素
- Web: 改进 UI 响应性，增强悬停效果和更好的布局处理
- Wire: 添加 `TurnEnd` 事件以标记 Agent 回合完成（协议版本 1.2）
- Core: 修复包含 `$` 的自定义 Agent 提示文件导致启动失败的问题

## 1.5 (2026-01-30)

- Web: 添加 Git diff 状态栏，显示会话工作目录中的未提交变更
- Web: 添加 "Open in" 菜单，用于在 Terminal、VS Code、Cursor 或其他本地应用中打开文件/目录
- Web: 添加搜索功能，按标题或工作目录筛选会话
- Web: 改进会话标题显示，优化溢出处理

## 1.4 (2026-01-30)

- Shell: 合并 `/login` 和 `/setup` 命令；`/setup` 现为 `/login` 的别名
- Shell: `/usage` 现在显示剩余配额百分比；添加 `/status` 别名
- Config: 添加 `KIMI_SHARE_DIR` 环境变量来自定义共享目录路径（默认：`~/.kimi`）
- Web: 添加新的 Web UI 用于浏览器交互
- CLI: 添加 `kimi web` 子命令以启动 Web UI 服务器
- Auth: 修复设备名称或操作系统版本包含非 ASCII 字符时的编码错误
- Auth: OAuth 凭证现在存储在文件中而不是 keyring 中；现有令牌在启动时自动迁移
- Auth: 修复系统休眠或休眠后授权失败的问题

## 1.3 (2026-01-28)

- Auth: 修复 Agent 回合期间的认证问题
- Tool: 在 `ReadMediaFile` 中使用描述性标签包装媒体内容，以改进路径可追溯性

## 1.2 (2026-01-27)

- UI: 显示 `kimi-for-coding` 模型的描述

## 1.1 (2026-01-27)

- LLM: 修复 `kimi-for-coding` 模型的能力配置

## 1.0 (2026-01-27)

- Shell: 添加 `/login` 和 `/logout` 斜杠命令用于登录和登出
- CLI: 添加 `kimi login` 和 `kimi logout` 子命令
- Core: 修复子 Agent 审批请求处理

## 0.88 (2026-01-26)

- MCP: 连接 MCP 服务器时移除 `Mcp-Session-Id` 请求头以修复兼容性问题

## 0.87 (2026-01-25)

- Shell: 修复当 HTML 块出现在任何元素外部时的 Markdown 渲染错误
- Skills: 添加更多用户级和项目级技能目录候选
- Core: 改进系统提示词中关于媒体文件生成和处理任务的指导
- Shell: 修复 macOS 上的剪贴板图片粘贴问题

## 0.86 (2026-01-24)

- Build: 修复二进制构建

## 0.85 (2026-01-24)

- Shell: 将粘贴的图片缓存到磁盘以在会话间持久化
- Shell: 基于内容哈希对缓存的附件进行去重
- Shell: 修复消息历史中的图片/音频/视频附件显示
- Tool: 在 `ReadMediaFile` 中使用文件路径作为媒体标识符以改进可追溯性
- Tool: 修复某些 MP4 文件未被识别为视频的问题
- Shell: 处理斜杠命令执行期间的 Ctrl-C
- Shell: 修复当输入包含无效 shell 语法时 shell 模式下的 shlex 解析错误
- Shell: 修复 MCP 服务器和第三方库的 stderr 输出污染 Shell UI 的问题
- Wire: 连接关闭或收到 Ctrl-C 时优雅关闭并正确清理待处理请求

## 0.84 (2026-01-22)

- Build: 添加跨平台独立二进制构建，支持 Windows、macOS（含代码签名和公证）和 Linux（x86_64 和 ARM64）
- Shell: 修复斜杠命令自动补全在精确命令/别名匹配时仍显示建议的问题
- Tool: 将 SVG 文件视为文本而非图片
- Flow: 支持 Flow skill 中的 D2 markdown 块字符串（`|md` 语法）用于多行节点标签
- Core: 修复运行 `/reload`、`/setup` 或 `/clear` 后可能出现的 "event loop is closed" 错误
- Core: 修复在继续的会话中使用 `/clear` 时的崩溃问题

## 0.83 (2026-01-21)

- Tool: 添加 `ReadMediaFile` 工具用于读取图片/视频文件；`ReadFile` 现在专注于文本文件
- Skills: Flow skill 现在也注册为 `/skill:<skill-name>` 命令（除了 `/flow:<skill-name>`）

## 0.82 (2026-01-21)

- Tool: 允许 `WriteFile` 和 `StrReplaceFile` 工具在使用绝对路径时编辑/写入工作目录外的文件
- Tool: 使用 Kimi 提供商时将视频上传到 Kimi 文件 API，将内联 data URL 替换为 `ms://` 引用
- Config: 添加 `reserved_context_size` 设置来自动压缩触发阈值（默认：50000 令牌）

## 0.81 (2026-01-21)

- Skills: 添加 Flow skill 类型，在 SKILL.md 中嵌入 Agent Flow（Mermaid/D2），通过 `/flow:<skill-name>` 命令调用
- CLI: 移除 `--prompt-flow` 选项；改用 Flow skill
- Core: 将 `/begin` 命令替换为 Flow skill 的 `/flow:<skill-name>` 命令

## 0.80 (2026-01-20)

- Wire: 添加 `initialize` 方法用于交换客户端/服务器信息、外部工具注册和斜杠命令通告
- Wire: 通过 Wire 协议支持外部工具调用
- Wire: 将 `ApprovalRequestResolved` 重命名为 `ApprovalResponse`（向后兼容）

## 0.79 (2026-01-19)

- Skills: 添加项目级技能支持，从 `.agents/skills/`（或 `.kimi/skills/`、`.claude/skills/`）发现
- Skills: 统一技能发现，分层加载（内置 → 用户 → 项目）；用户级技能现在优先使用 `~/.config/agents/skills/`
- Shell: 支持斜杠命令自动补全的模糊匹配
- Shell: 增强审批请求预览，显示 shell 命令和 diff 内容，使用 `Ctrl-E` 展开完整内容
- Wire: 添加 `ShellDisplayBlock` 类型用于审批请求中的 shell 命令显示
- Shell: 重新排序 `/help`，将键盘快捷键显示在斜杠命令之前
- Wire: 对无效请求返回正确的 JSON-RPC 2.0 错误响应

## 0.78 (2026-01-16)

- CLI: 为 Prompt Flow 添加 D2 流程图格式支持（`.d2` 扩展名）

## 0.77 (2026-01-15)

- Shell: 修复 `/help` 和 `/changelog` 全屏分页器显示中的换行问题
- Shell: 使用 `/model` 切换思考模式而非 Tab 键
- Config: 添加 `default_thinking` 配置选项（升级后需要运行 `/model` 选择思考模式）
- LLM: 添加 `always_thinking` 能力用于始终使用思考模式的模型
- CLI: 将 `--command`/`-c` 重命名为 `--prompt`/`-p`，保留 `--command`/`-c` 作为别名，移除 `--query`/`-q`
- Wire: 修复 Wire 模式下审批请求响应不正确的问题
- CLI: 添加 `--prompt-flow` 选项以将 Mermaid 流程图文件加载为 Prompt Flow
- Core: 如果加载了 Prompt Flow，添加 `/begin` 斜杠命令以启动流程
- Core: 将 Ralph Loop 替换为基于 Prompt Flow 的实现

## 0.76 (2026-01-12)

- Tool: 使 `ReadFile` 工具描述反映模型对图片/视频支持的能力
- Tool: 修复 TypeScript 文件（`.ts`, `.tsx`, `.mts`, `.cts`）被误识别为视频文件的问题
- Shell: 允许在 shell 模式中使用斜杠命令（`/help`, `/exit`, `/version`, `/changelog`, `/feedback`）
- Shell: 改进 `/help`，使用全屏分页器显示斜杠命令、技能和键盘快捷键
- Shell: 改进 `/changelog` 和 `/mcp` 显示，使用一致的项目符号格式
- Shell: 在底部状态栏显示当前模型名称
- Shell: 添加 `Ctrl-/` 快捷键显示帮助

## 0.75 (2026-01-09)

- Tool: 改进 `ReadFile` 工具描述
- Skills: 添加内置 `kimi-cli-help` 技能以回答 Kimi Code CLI 使用和配置问题

## 0.74 (2026-01-09)

- ACP: 允许 ACP 客户端选择和切换模型（含思考变体）
- ACP: 为设置流程添加 `terminal-auth` 认证方法
- CLI: 弃用 `--acp` 选项，改用 `kimi acp` 子命令
- Tool: 在 `ReadFile` 工具中支持读取图片和视频文件

## 0.73 (2026-01-09)

- Skills: 添加随包分发的内置 skill-creator 技能
- Tool: 在 `ReadFile` 路径中将 `~` 扩展为主目录
- MCP: 确保 MCP 工具在启动 Agent 循环前完成加载
- Wire: 修复 Wire 模式无法接收有效 `cancel` 请求的问题
- Setup: 允许 `/model` 在所选提供商的所有可用模型之间切换
- Lib: 从 `kimi_cli.wire.types` 重新导出所有 Wire 消息类型，作为 `kimi_cli.wire.message` 的替代
- Loop: 添加 `max_ralph_iterations` 循环控制配置以限制额外的 Ralph 迭代
- Config: 将循环控制配置中的 `max_steps_per_run` 重命名为 `max_steps_per_turn`（向后兼容）
- CLI: 添加 `--max-steps-per-turn`、`--max-retries-per-step` 和 `--max-ralph-iterations` 选项以覆盖循环控制配置
- SlashCmd: 使 `/yolo` 切换自动审批模式
- UI: 在 shell 提示中显示 YOLO 徽章

## 0.72 (2026-01-04)

- Python: 修复在 Python 3.14 上的安装问题

## 0.71 (2026-01-04)

- ACP: 通过 ACP 客户端路由文件读/写和 shell 命令以实现同步编辑/输出
- Shell: 添加 `/model` 斜杠命令以切换默认模型并在使用默认配置时重新加载
- Skills: 添加 `/skill:<name>` 斜杠命令以按需加载 `SKILL.md` 指令
- CLI: 添加 `kimi info` 子命令用于版本/协议详情（支持 `--json`）
- CLI: 添加 `kimi term` 以启动 Toad 终端 UI
- Python: 将默认工具/CI 版本升级到 3.14

## 0.70 (2025-12-31)

- CLI: 添加 `--final-message-only`（和 `--quiet` 别名）以仅在 print UI 中输出最终助手消息
- LLM: 添加 `video_in` 模型能力并支持视频输入

## 0.69 (2025-12-29)

- Core: 支持在 `~/.kimi/skills` 或 `~/.claude/skills` 中发现技能
- Python: 将最低要求的 Python 版本降低到 3.12
- Nix: 添加 flake 打包；使用 `nix profile install .#kimi-cli` 安装或运行 `nix run .#kimi-cli`
- CLI: 添加 `kimi-cli` 脚本别名用于调用 CLI；可通过 `uvx kimi-cli` 运行
- Lib: 将 LLM 配置验证移入 `create_llm`，配置缺失时返回 `None`

## 0.68 (2025-12-24)

- CLI: 添加 `--config` 和 `--config-file` 选项以传入配置 JSON/TOML
- Core: 允许 `KimiCLI.create` 的 `config` 参数使用 `Config` 类型以及 `Path` 类型
- Tool: 在 `WriteFile` 和 `StrReplaceFile` 审批/结果中包含 diff 显示块
- Wire: 向审批请求添加显示块（包括 diff），具有向后兼容的默认值
- ACP: 在工具结果和审批提示中显示文件 diff 预览
- ACP: 连接到 ACP 客户端管理的 MCP 服务器
- ACP: 如果支持，在 ACP 客户端终端中运行 shell 命令
- Lib: 添加 `KimiToolset.find` 方法以按类或名称查找工具
- Lib: 添加 `ToolResultBuilder.display` 方法以向工具结果追加显示块
- MCP: 添加 `kimi mcp auth` 及相关子命令以管理 MCP 授权

## 0.67 (2025-12-22)

- ACP: 在单会话 ACP 模式（`kimi --acp`）中通告斜杠命令
- MCP: 添加 `mcp.client` 配置部分以配置 MCP 工具调用超时和其他未来选项
- Core: 改进默认系统提示词和 `ReadFile` 工具
- UI: 修复某些罕见情况下 Ctrl-C 不工作的问题

## 0.66 (2025-12-19)

- Lib: 在 `StatusUpdate` Wire 消息中提供 `token_usage` 和 `message_id`
- Lib: 添加 `KimiToolset.load_tools` 方法以使用依赖注入加载工具
- Lib: 添加 `KimiToolset.load_mcp_tools` 方法以加载 MCP 工具
- Lib: 将 `MCPTool` 从 `kimi_cli.tools.mcp` 移动到 `kimi_cli.soul.toolset`
- Lib: 添加 `InvalidToolError`、`MCPConfigError` 和 `MCPRuntimeError`
- Lib: 使详细的 Kimi Code CLI 异常类继承 `ValueError` 或 `RuntimeError`
- Lib: 允许将验证后的 `list[fastmcp.mcp_config.MCPConfig]` 作为 `mcp_configs` 传递给 `KimiCLI.create` 和 `load_agent`
- Lib: 修复 `KimiCLI.create`、`load_agent`、`KimiToolset.load_tools` 和 `KimiToolset.load_mcp_tools` 的异常抛出
- LLM: 添加提供商类型 `vertexai` 以支持 Vertex AI
- LLM: 将 Gemini Developer API 提供商类型从 `google_genai` 重命名为 `gemini`
- Config: 将配置文件从 JSON 迁移到 TOML
- MCP: 后台并行连接 MCP 服务器以减少启动时间
- MCP: 连接 MCP 服务器时添加 `mcp-session-id` HTTP 请求头
- Lib: 将斜杠命令（原 "meta 命令"）分为两组：Shell 级和 KimiSoul 级
- Lib: 向 `Soul` 协议添加 `available_slash_commands` 属性
- ACP: 向 ACP 客户端通告斜杠命令 `/init`、`/compact` 和 `/yolo`
- SlashCmd: 添加 `/mcp` 斜杠命令以显示 MCP 服务器和工具状态

## 0.65 (2025-12-16)

- Lib: 支持通过 `Session.create(work_dir, session_id)` 创建命名会话
- CLI: 指定会话 ID 未找到时自动创建新会话
- CLI: 退出时删除空会话，列出时忽略上下文文件为空的会话
- UI: 改进会话回放
- Lib: 向 `LLM` 类添加 `model_config: LLMModel | None` 和 `provider_config: LLMProvider | None` 属性
- MetaCmd: 添加 `/usage` 元命令以显示 Kimi Code 用户的 API 使用情况

## 0.64 (2025-12-15)

- UI: 修复 Windows 上的 UTF-16 代理字符输入
- Core: 添加 `/sessions` 元命令以列出现有会话并切换到选定会话
- CLI: 添加 `--session/-S` 选项以指定要恢复的会话 ID
- MCP: 添加 `kimi mcp` 子命令组以管理全局 MCP 配置文件 `~/.kimi/mcp.json`

## 0.63 (2025-12-12)

- Tool: 修复通过服务获取失败时 `FetchURL` 工具的输出不正确问题
- Tool: 在 `Shell` 工具中使用 `bash` 而非 `sh` 以获得更好的兼容性
- Tool: 修复 Windows 上 `Grep` 工具的 Unicode 解码错误
- ACP: 支持 ACP 会话继续（列出/加载会话）与 `kimi acp` 子命令
- Lib: 添加 `Session.find` 和 `Session.list` 静态方法以查找和列出现有会话
- ACP: 调用 `SetTodoList` 工具时在客户端更新 Agent 计划
- UI: 防止以 `/` 开头的正常消息被误认为是元命令

## 0.62 (2025-12-08)

- ACP: 修复工具结果（包括 Shell 工具输出）未在 ACP 客户端（如 Zed）中显示的问题
- ACP: 修复与最新版本 Zed IDE（0.215.3）的兼容性
- Tool: 在 Windows 上使用 PowerShell 而非 CMD 以获得更好的可用性
- Core: 修复工作目录中存在损坏符号链接时的启动崩溃问题
- Core: 添加内置 `okabe` Agent 文件，启用 `SendDMail` 工具
- CLI: 添加 `--agent` 选项以指定内置 Agent，如 `default` 和 `okabe`
- Core: 改进压缩逻辑以更好地保留相关信息

## 0.61 (2025-12-04)

- Lib: 修复作为库使用时的日志记录
- Tool: 加强文件路径检查以防止共享前缀逃逸
- LLM: 提高与某些第三方 OpenAI Responses 和 Anthropic API 提供商的兼容性

## 0.60 (2025-12-01)

- LLM: 修复 Kimi 和 OpenAI 兼容提供商的交错思考

## 0.59 (2025-11-28)

- Core: 将上下文文件位置移动到 `.kimi/sessions/{workdir_md5}/{session_id}/context.jsonl`
- Lib: 将 `WireMessage` 类型别名移动到 `kimi_cli.wire.message`
- Lib: 添加 `kimi_cli.wire.message.Request` 类型别名用于请求消息（目前仅包括 `ApprovalRequest`）
- Lib: 添加 `kimi_cli.wire.message.is_event`、`is_request` 和 `is_wire_message` 工具函数以检查 Wire 消息类型
- Lib: 添加 `kimi_cli.wire.serde` 模块用于 Wire 消息的序列化和反序列化
- Lib: 将 `StatusUpdate` Wire 消息更改为不使用 `kimi_cli.soul.StatusSnapshot`
- Core: 将 Wire 消息记录到会话目录中的 JSONL 文件
- Core: 引入 `TurnBegin` Wire 消息以标记每个 Agent 回合的开始
- UI: 在 shell 模式中使用面板再次打印用户输入
- Lib: 添加 `Session.dir` 属性以获取会话目录路径
- UI: 当有多个并行子 Agent 时改进"为会话批准"体验
- Wire: 重新实现 Wire 服务器模式（通过 `--wire` 选项启用）
- Lib: 将 `ShellApp` 重命名为 `Shell`、`PrintApp` 重命名为 `Print`、`ACPServer` 重命名为 `ACP`、`WireServer` 重命名为 `WireOverStdio` 以保持一致性
- Lib: 将 `KimiCLI.run_shell_mode` 重命名为 `run_shell`、`run_print_mode` 重命名为 `run_print`、`run_acp_server` 重命名为 `run_acp`、`run_wire_server` 重命名为 `run_wire_stdio` 以保持一致性
- Lib: 添加 `KimiCLI.run` 方法以使用给定用户输入运行一个回合并生成 Wire 消息
- Print: 修复 stream-json print 模式未正确刷新输出的问题
- LLM: 提高与某些 OpenAI 和 Anthropic API 提供商的兼容性
- Core: 修复使用 Anthropic API 时压缩后的聊天提供商错误

## 0.58 (2025-11-21)

- Core: 修复使用 `extend` 时 Agent 规格文件的字段继承问题
- Core: 支持在子 Agent 中使用 MCP 工具
- Tool: 添加 `CreateSubagent` 工具以动态创建子 Agent（默认 Agent 中未启用）
- Tool: 在 Kimi Code 计划中于 `FetchURL` 工具使用 MoonshotFetch 服务
- Tool: 截断 Grep 工具输出以避免超出令牌限制

## 0.57 (2025-11-20)

- LLM: 修复当思考开关未打开时的 Google GenAI 提供商问题
- UI: 改进审批请求措辞
- Tool: 移除 `PatchFile` 工具
- Tool: 将 `Bash`/`CMD` 工具重命名为 `Shell` 工具
- Tool: 将 `Task` 工具移动到 `kimi_cli.tools.multiagent` 模块

## 0.56 (2025-11-19)

- LLM: 添加对 Google GenAI 提供商的支持

## 0.55 (2025-11-18)

- Lib: 添加 `kimi_cli.app.enable_logging` 函数以在直接使用 `KimiCLI` 类时启用日志记录
- Core: 修复 Agent 规格文件中的相对路径解析
- Core: 防止 LLM API 连接失败时出现崩溃
- Tool: 优化 `FetchURL` 工具以获得更好的内容提取
- Tool: 将 MCP 工具调用超时增加到 60 秒
- Tool: 当模式为 `**` 时在 `Glob` 工具中提供更好的错误消息
- ACP: 修复思考内容显示不正确的问题
- UI: Shell 模式中的微小 UI 改进

## 0.54 (2025-11-13)

- Lib: 将 `WireMessage` 从 `kimi_cli.wire.message` 移动到 `kimi_cli.wire`
- Print: 修复 `stream-json` 输出格式丢失最后一条助手消息的问题
- UI: 当 API 密钥被 `KIMI_API_KEY` 环境变量覆盖时添加警告
- UI: 当有审批请求时播放提示音
- Core: 修复 Windows 上的上下文压缩和清除问题

## 0.53 (2025-11-12)

- UI: 移除控制台输出中不必要的尾部空格
- Core: 当存在不支持的消息部分时抛出错误
- MetaCmd: 添加 `/yolo` 元命令以在启动后启用 YOLO 模式
- Tool: 为 MCP 工具添加审批请求
- Tool: 在默认 Agent 中禁用 `Think` 工具
- CLI: 当未指定 `--thinking` 时从上次恢复思考模式
- CLI: 修复由 PyInstaller 打包的二进制文件中 `/reload` 不工作的问题

## 0.52 (2025-11-10)

- CLI: 移除 `--ui` 选项，改用 `--print`、`--acp` 和 `--wire` 标志（shell 仍是默认）
- CLI: 更直观的会话继续行为
- Core: 为 LLM 空响应添加重试
- Tool: 在 Windows 上将 `Bash` 工具更改为 `CMD` 工具
- UI: 修复退格后的补全问题
- UI: 修复浅色背景下的代码块渲染问题

## 0.51 (2025-11-08)

- Lib: 将 `Soul.model` 重命名为 `Soul.model_name`
- Lib: 将 `LLMModelCapability` 重命名为 `ModelCapability` 并移动到 `kimi_cli.llm`
- Lib: 向 `ModelCapability` 添加 `"thinking"`
- Lib: 移除 `LLM.supports_image_in` 属性
- Lib: 添加必需的 `Soul.model_capabilities` 属性
- Lib: 将 `KimiSoul.set_thinking_mode` 重命名为 `KimiSoul.set_thinking`
- Lib: 添加 `KimiSoul.thinking` 属性
- UI: 更好地检查和通知 LLM 模型能力
- UI: 为 `/clear` 元命令清屏
- Tool: 支持在 Windows 上自动下载 ripgrep
- CLI: 添加 `--thinking` 选项以在思考模式下启动
- ACP: 在 ACP 模式下支持思考内容

## 0.50 (2025-11-07)

- 改进 UI 外观和感觉
- 改进 Task 工具可观测性

## 0.49 (2025-11-06)

- 细微的 UX 改进

## 0.48 (2025-11-06)

- 支持 Kimi K2 思考模式

## 0.47 (2025-11-05)

- 修复在某些环境中 Ctrl-W 不工作的问题
- 当搜索服务未配置时不加载 SearchWeb 工具

## 0.46 (2025-11-03)

- 引入用于本地 IPC 的 Wire over stdio（实验性，可能变更）
- 支持 Anthropic 提供商类型

- 修复由 PyInstaller 打包的二进制文件因入口点错误而无法工作的问题

## 0.45 (2025-10-31)

- 允许 `KIMI_MODEL_CAPABILITIES` 环境变量覆盖模型能力
- 添加 `--no-markdown` 选项以禁用 markdown 渲染
- 支持 `openai_responses` LLM 提供商类型

- 修复继续会话时的崩溃问题

## 0.44 (2025-10-30)

- 改进启动时间

- 修复用户输入中可能出现的无效字节

## 0.43 (2025-10-30)

- 基础 Windows 支持（实验性）
- 当 base URL 或 API 密钥被环境变量覆盖时显示警告
- 如果 LLM 模型支持则支持图片输入
- 继续会话时回放最近的上下文历史

- 确保执行 shell 命令后换行

## 0.42 (2025-10-28)

- 支持 Ctrl-J 或 Alt-Enter 插入新行

- 将模式切换快捷键从 Ctrl-K 更改为 Ctrl-X
- 提高整体健壮性

- 修复 ACP 服务器 `no attribute` 错误

## 0.41 (2025-10-26)

- 修复当未找到匹配文件时 Glob 工具的 bug
- 确保使用 UTF-8 编码读取文件

- 在 shell 模式下禁用从 stdin 读取命令/查询
- 在 `/setup` 元命令中明确 API 平台选择

## 0.40 (2025-10-24)

- 支持 `ESC` 键中断 Agent 循环

- 修复某些罕见情况下的 SSL 证书验证错误
- 修复 Bash 工具中可能的解码错误

## 0.39 (2025-10-24)

- 修复上下文压缩阈值检查
- 修复 shell 会话中设置 SOCKS 代理时的崩溃问题

## 0.38 (2025-10-24)

- 细微的 UX 改进

## 0.37 (2025-10-24)

- 修复更新检查

## 0.36 (2025-10-24)

- 添加 `/debug` 元命令以调试上下文
- 添加自动上下文压缩
- 添加审批请求机制
- 添加 `--yolo` 选项以自动批准所有操作
- 渲染 markdown 内容以获得更好的可读性

- 修复中断元命令时的 "unknown error" 消息

## 0.35 (2025-10-22)

- 细微的 UI 改进
- 如果系统中未找到 ripgrep 则自动下载
- 在 `--print` 模式下始终批准工具调用
- 添加 `/feedback` 元命令

## 0.34 (2025-10-21)

- 添加 `/update` 元命令以检查更新并后台自动更新
- 支持在 raw shell 模式下运行交互式 shell 命令
- 添加 `/setup` 元命令以设置 LLM 提供商和模型
- 添加 `/reload` 元命令以重新加载配置

## 0.33 (2025-10-18)

- 添加 `/version` 元命令
- 添加 raw shell 模式，可通过 Ctrl-K 切换
- 在底部状态行显示快捷键

- 修复日志重定向
- 合并重复输入历史

## 0.32 (2025-10-16)

- 添加底部状态行
- 支持文件路径自动补全（`@filepath`）

- 不在用户输入中间自动补全元命令

## 0.31 (2025-10-14)

- 真正修复由 Ctrl-C 中断步骤的问题

## 0.30 (2025-10-14)

- 添加 `/compact` 元命令以允许手动压缩上下文

- 修复上下文为空时的 `/clear` 元命令

## 0.29 (2025-10-14)

- 支持在 shell 模式下使用 Enter 键接受补全
- 在 shell 模式下跨会话记住用户输入历史
- 添加 `/reset` 元命令作为 `/clear` 的别名

- 修复由 Ctrl-C 中断步骤的问题

- 在 Kimi Koder Agent 中禁用 `SendDMail` 工具

## 0.28 (2025-10-13)

- 添加 `/init` 元命令以分析代码库并生成 `AGENTS.md` 文件
- 添加 `/clear` 元命令以清除上下文

- 修复 `ReadFile` 输出

## 0.27 (2025-10-11)

- 添加 `--mcp-config-file` 和 `--mcp-config` 选项以加载 MCP 配置

- 将 `--agent` 选项重命名为 `--agent-file`

## 0.26 (2025-10-11)

- 修复 `--output-format stream-json` 模式下可能的编码错误

## 0.25 (2025-10-11)

- 将包名 `ensoul` 重命名为 `kimi-cli`
- 将 `ENSOUL_*` 内置系统提示词参数重命名为 `KIMI_*`
- 进一步解耦 `App` 与 `Soul`
- 拆分 `Soul` 协议和 `KimiSoul` 实现以获得更好的模块化

## 0.24 (2025-10-10)

- 修复 ACP `cancel` 方法

## 0.23 (2025-10-09)

- 向 Agent 文件添加 `extend` 字段以支持 Agent 文件扩展
- 向 Agent 文件添加 `exclude_tools` 字段以支持排除工具
- 向 Agent 文件添加 `subagents` 字段以支持定义子 Agent

## 0.22 (2025-10-09)

- 改进 `SearchWeb` 和 `FetchURL` 工具调用可视化
- 改进搜索结果输出格式

## 0.21 (2025-10-09)

- 添加 `--print` 选项作为 `--ui print` 的快捷方式，`--acp` 选项作为 `--ui acp` 的快捷方式
- 支持 `--output-format stream-json` 以 JSON 格式打印输出
- 添加 `SearchWeb` 工具，使用 `services.moonshot_search` 配置。需要在配置文件中配置 `"services": {"moonshot_search": {"api_key": "your-search-api-key"}}`。
- 添加 `FetchURL` 工具
- 添加 `Think` 工具
- 添加 `PatchFile` 工具，在 Kimi Koder Agent 中未启用
- 在 Kimi Koder Agent 中启用 `SendDMail` 和 `Task` 工具并改进工具提示词
- 添加 `ENSOUL_NOW` 内置系统提示词参数

- 更好看的 `/release-notes`
- 改进工具描述
- 改进工具输出截断

## 0.20 (2025-09-30)

- 添加 `--ui acp` 选项以启动 Agent Client Protocol（ACP）服务器

## 0.19 (2025-09-29)

- 为 print UI 支持管道 stdin
- 为管道 JSON 输入支持 `--input-format=stream-json`

- 当 `SendDMail` 未启用时不将 `CHECKPOINT` 消息包含在上下文中

## 0.18 (2025-09-29)

- 在 LLM 模型配置中支持 `max_context_size` 以配置最大上下文大小（令牌数）

- 改进 `ReadFile` 工具描述

## 0.17 (2025-09-29)

- 修复超过最大步骤时错误消息中的步骤计数
- 修复 `kimi_run` 中的历史文件断言错误
- 修复 print 模式和单命令 shell 模式中的错误处理
- 为 LLM API 连接错误和超时错误添加重试

- 将默认 max-steps-per-run 增加到 100

## 0.16.0 (2025-09-26)

- 添加 `SendDMail` 工具（在 Kimi Koder 中禁用，可在自定义 Agent 中启用）

- 创建新会话时可通过 `_history_file` 参数指定会话历史文件

## 0.15.0 (2025-09-26)

- 改进工具健壮性

## 0.14.0 (2025-09-25)

- 添加 `StrReplaceFile` 工具

- 强调使用与用户相同的语言

## 0.13.0 (2025-09-25)

- 添加 `SetTodoList` 工具
- 在 LLM API 调用中添加 `User-Agent`

- 更好的系统提示词和工具描述
- 更好的 LLM 错误消息

## 0.12.0 (2025-09-24)

- 添加 `print` UI 模式，可通过 `--ui print` 选项使用
- 添加日志记录和 `--debug` 选项

- 捕获 EOF 错误以获得更好的体验

## 0.11.1 (2025-09-22)

- 将 `max_retry_per_step` 重命名为 `max_retries_per_step`

## 0.11.0 (2025-09-22)

- 添加 `/release-notes` 命令
- 为 LLM API 错误添加重试
- 添加循环控制配置，例如 `{"loop_control": {"max_steps_per_run": 50, "max_retry_per_step": 3}}`

- 更好地处理 `read_file` 工具中的极端情况
- 防止 Ctrl-C 退出 CLI，强制使用 Ctrl-D 或 `exit` 代替

## 0.10.1 (2025-09-18)

- 使斜杠命令看起来稍微好一点
- 改进 `glob` 工具

## 0.10.0 (2025-09-17)

- 添加 `read_file` 工具
- 添加 `write_file` 工具
- 添加 `glob` 工具
- 添加 `task` 工具

- 改进工具调用可视化
- 改进会话管理
- `--continue` 会话时恢复上下文使用

## 0.9.0 (2025-09-15)

- 移除 `--session` 和 `--continue` 选项

## 0.8.1 (2025-09-14)

- 修复配置模型转储

## 0.8.0 (2025-09-14)

- 添加 `shell` 工具和基础系统提示词
- 添加工具调用可视化
- 添加上下文使用计数
- 支持中断 Agent 循环
- 支持项目级 `AGENTS.md`
- 支持使用 YAML 定义的自定义 Agent
- 通过 `kimi -c` 支持一次性任务
