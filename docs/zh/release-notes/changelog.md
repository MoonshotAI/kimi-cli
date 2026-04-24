# 变更记录

本页面记录 Kimi Code CLI 各版本的变更内容。

## 未发布

- Shell：在提示框状态栏显示当前正在运行的后台 Agent 任务数——原有的 `⚙ bash: N` 徽章只统计后台 Shell 任务，把后台 Agent 子代理过滤掉了，所以多个子代理同时在跑时提示框看起来像空闲，用户无法判断工作是否还在进行；现在状态栏会渲染 `⚙ bash: N` 与 `⚙ agent: N` 两个相互独立的徽章（任一计数为 0 时自动隐藏），终端太窄无法同时容纳两者时优先丢弃 agent 徽章
- Auth：修复 OAuth 用户 access token 过期时托管模型列表刷新静默失败的问题——后台 `/models` 同步任务现在会检测 401 响应，强制进行 OAuth token 刷新并用刷新后的 token 重试；如果刷新本身失败或刷新后的 token 仍被拒绝，则回退到最初配置的静态 API 密钥，而不是跳过该 provider
- Core：修复连接恢复后重试返回 401 时未能触发 OAuth 刷新的问题——在 `APIConnectionError` 或 `APITimeoutError` 后重建 HTTP 客户端时，重试现在会重新进入完整恢复路径，使得后续的 401 能正确刷新 OAuth token，而不是作为不可恢复的错误直接抛给用户

## 1.39.0 (2026-04-24)

- Skill：修复项目级 Skill 被忽略、用户级 Skill 在同名冲突时静默获胜的问题——系统提示现在会把发现到的 Skill 按 `### Project` / `### User` / `### Extra` / `### Built-in` 四个分组呈现，让模型能分辨出每个 Skill 来自哪一层；当同一 Skill 名称同时存在于多个作用域时，越具体的作用域优先（Project > User > Extra > Built-in），项目自身的 `.kimi/skills/foo` 或 `.claude/skills/foo` 现在能正确覆盖用户级或内置的同名 `foo`，而不是被它们覆盖
- Skill：除了标准的 `<name>/SKILL.md` 子目录结构之外，现在也会识别 Skills 目录下的扁平 `<name>.md` 单文件 Skill——便于将扁平 Markdown 集合迁移到 Skills 目录；`name` 默认取文件名去掉 `.md` 后的部分（frontmatter 里显式写了 `name:` 时以 frontmatter 为准），描述解析与子目录形式统一走同一条三级链（frontmatter `description:` → 正文第一个非空行，超过 240 字符会截断 → `"No description provided."` 兜底）；当同目录下扁平 `.md` 和子目录形式同名时，以子目录为准，并记录一条警告日志
- Skill：新增 `extra_skill_dirs` 配置项，用于在内置 / 用户级 / 项目级自动发现的基础上追加自定义 Skills 目录——每一项可以是绝对路径、`~` 前缀路径（会按 `$HOME` 展开），或相对于项目根的路径（即 `work_dir` 向上第一个包含 `.git` 的目录，不是当前工作目录）；不存在的条目会被静默跳过，同一路径的软链接或带尾部斜杠的写法会被 canonicalize 归并为一条根，避免同一目录在系统提示里重复出现
- Skill：强化 Skill 发现对 `is_dir` / `iterdir` 抛出 `OSError` 的容错（例如 `extra_skill_dirs` 指向一个权限受限的目录）——受影响的条目会被记录并跳过，不会让整轮 Skill 发现失败中断
- Core：修复 DeepSeek V4（以及其它走 `openai_legacy` 的 OpenAI 兼容 Thinking 模式后端）在思考轮次后紧跟工具调用时，被 API 以 400 `The reasoning_content in the thinking mode must be passed back to the API` 拒绝的问题——`openai_legacy` 供应商现在默认 `reasoning_key = "reasoning_content"`，模型响应中的推理内容会被正确存入历史，并在后续轮次自动回传给 API。同时给 `LLMProvider` 新增可选字段 `reasoning_key`，便于覆盖字段名（例如非标网关使用的 `"reasoning"`）或设置为 `""` 完全关闭推理内容回传
- Core：新增 `skip_yolo_prompt_injection` 配置项，用于抑制 yolo 模式下注入的系统提示词——基于 `KimiSoul` 构建自定义应用且不需要该提示时很有用
- Kimi：新增环境变量 `KIMI_MODEL_THINKING_KEEP`，将其值原样作为 `thinking.keep` 字段发送给 Moonshot API，用于启用 Preserved Thinking（例如 `export KIMI_MODEL_THINKING_KEEP=all` 可让模型在多轮之间保留历史 `reasoning_content`）；仅对支持 Preserved Thinking 的 Moonshot 模型（如 `kimi-k2.6` / `kimi-k2-thinking`）生效，未设置或空字符串时请求体不携带该字段、等同当前默认行为，且仅在当前模型真正处于 Thinking 模式时才注入，以避免 API 收到只有 `thinking.keep` 而缺少 `thinking.type` 的无效请求体。注意 `keep=all` 会因为重新发送历史推理内容而显著增加输入 token 与 API 费用
- Kosong：修复 `Kimi.with_extra_body` 在后续调用新增其它 `thinking.*` 字段时静默丢掉已有 `thinking.type` 的问题——`thinking` 子对象现在按字段合并，而不是被整体浅覆盖，使得 `with_thinking(...)` 与 `with_extra_body({"thinking": {...}})` 组合使用时两次设置的字段都能保留
- Kosong：修复 Kimi provider 在 `tool_calls` 旁发送空 `content` 导致 Moonshot API 返回 400 "text content is empty" 错误的问题。当 Assistant 消息带有工具调用且可见内容实际为空（无文本或仅包含空白 / think 部分）时，现在会完全省略 `content` 字段
- Shell：修复审批请求反馈文本输入的光标渲染问题——光标块现在根据实际光标位置正确渲染，不再始终固定在行尾；当光标位于文本中间时，光标所在字符会以反色显示（模拟终端原生块光标效果）
- Kosong：修复接入某些 MCP 服务端（如 JetBrains Rider MCP 的 `truncateMode`）时，Moonshot API 以 `400 At path 'properties.X': type is not defined` 拒绝每次请求导致会话完全无法使用的问题——这些 MCP 工具的参数 schema 里有仅声明 `enum`/`const` 或根本没有类型提示的属性，符合 JSON Schema 规范但过不了 Moonshot 的严格校验；现在 Kimi 供应商会在发送前为每个工具 schema 补齐 JSON Schema `type`（尽量从 `enum`/`const` 值推断，否则默认 `"string"`），OpenAI 和 Anthropic 路径不受影响
- Skill：项目级 Skill 发现现在会先向上查找最近的 `.git` 祖先目录，再查 `.kimi/skills` / `.claude/skills` / `.codex/skills` / `.agents/skills`，这样即使从子目录（例如 monorepo 的某个 package 内部）启动 kimi-cli，也能正确识别仓库根目录下定义的 Skills；找不到 `.git` 标记时，回退到工作目录本身，避免误入无关的上层目录
- Skill：`merge_all_available_skills` 的默认值从 `false` 改为 `true`。kimi-cli 现在默认会合并用户级和项目级所有已存在的品牌 Skills 目录（`.kimi/skills`、`.claude/skills`、`.codex/skills`），而不是仅使用找到的第一个——让同时拥有多个品牌目录（例如同时保留 `~/.kimi/skills` 和 `~/.claude/skills`）的用户开箱即看到所有 Skills。**行为变更**：依赖旧默认（仅取第一个）的用户可通过在配置中显式设置 `merge_all_available_skills = false` 恢复旧行为。

## 1.38.0 (2026-04-22)

- Shell：修复 approval 弹窗超时后被误报为 `Rejected by user` 的问题——300 秒安全超时后，工具调用会以 `Rejected: approval timed out` 拒绝，让离开电脑一段时间后回来的用户能分辨出这是超时而非自己的手动拒绝。经常长时间离开的话可以加 `--yolo`/`-y` 自动批准工具调用
- Auth：修复 OAuth 用户因并发实例的 refresh token 轮换竞态被反复要求 `/login` 的问题——当另一个并发运行的 kimi-cli 实例（终端、VS Code 插件或 `kimi -p` 一次性命令）合法地轮换了 refresh token，当前实例手里过期的 refresh 请求会从服务端拿回 401，“别的实例是否刚轮换过”的磁盘检查与 `delete_tokens` 调用之间存在 TOCTOU 竞态，即使磁盘上马上会被写入一份有效的新 token，凭证文件也会被误删，迫使用户重新登录；现在依旧清理内存缓存（真正失效的 token 会在下一次请求时浮现），但保留文件，让并发实例刚写入的新 token 有机会被恢复，最终的 `/login` 仍会原子覆盖该文件
- Kosong：修复 Anthropic 供应商将并行工具结果拆分到多个 user message 的问题——现在会将仅包含工具结果的连续 user message 合并为单条消息，以符合 Anthropic Messages API 规范（assistant 一轮中的所有 `tool_use` 必须在同一条 user message 内回答）；修复了严格兼容后端（如 DeepSeek `/anthropic` 接口）返回 400 错误的问题，并避免官方后端静默地引导模型放弃并行工具调用

## 1.37.0 (2026-04-20)

- Print：退出前等待后台任务完成——在单次 `--print` 模式下，进程现在会等待仍在运行的后台 Agent 完成并让模型处理它们的结果，而不是直接退出并杀死它们。等待时长上限为 `min(max(active_task.timeout_s or agent_task_timeout_s), print_wait_ceiling_s)`（默认上限 1 小时）；超时后杀死任务并通过 `<system-reminder>` 给模型最后一轮机会向用户总结后再退出
- Shell/Print：退出时 CLI 会在 stderr 列出每个即将被 kill 的后台任务（id + 描述），等待配置的 grace period 后再汇报未达到终态的任务（区分为"still terminating"即 worker 正在退出 vs "stop request failed"即真正泄漏的任务）；`keep_alive_on_exit=true` 仍会完全跳过此路径
- Auth：OAuth 登录用户启动时自动刷新托管模型列表——Shell 启动时会以后台任务形式请求 provider 的 `/models` 接口拉取最新模型，新上线的模型无需重新登录即可使用；失败时静默降级、不会阻塞启动；使用 `--config` 指定自定义配置文件的会话保持原有行为
- Shell：托管模型现在统一展示 provider 返回的 `display_name`（如 `k2.6-code-preview`），覆盖欢迎界面、提示框状态栏、`/model` 选单和 `/model` 切换确认消息；若后端未返回 `display_name`，则回落到内部模型 ID

## 1.36.0 (2026-04-17)

- Anthropic：修复 Claude Opus 4.7 返回 `invalid_request_error` 的问题——Opus 4.7 拒绝旧的 `{type: "enabled", budget_tokens: N}` 思考配置，现在会正确路由到 adaptive thinking，并显式设置 `display: "summarized"`，使思考内容仍能通过流返回（Opus 4.7 默默将该默认值改为 `"omitted"`）；Bedrock / Vertex 命名变体（如 `aws/claude-opus-4-7`、`anthropic.claude-opus-4-7-v1:0`）以及 `claude-mythos-preview` 也会被正确识别；未来的 Claude ≥ 4.6 版本会通过版本号外推自动识别，无需改代码
- Web：修复 Web 界面中 Markdown 渲染的间距问题——恢复段落、列表、代码块、引用块和标题之间的合理垂直间距，不再将所有外边距压缩为零
- Shell：修复活跃 turn 期间加载指示器缺失的问题——月亮 spinner 现在作为兜底指示器，在模型仍在工作但没有其他指示器可见时自动显示，覆盖了工具调用完成后、turn 开始到首个 step 之间、以及 provider 发送空 thinking block 时的空白期
- Core：将 `max_steps_per_turn` 默认值从 100 提高到 500，开箱即可支持更长的无中断 agent 运行
- Web：修复代码块右上角复制、下载和预览按钮点击无响应的问题

## 1.35.0 (2026-04-15)

- Shell：将 `show_thinking_stream` 默认值改为 `true`，全新安装开箱即可看到流式思考预览；如需保留 1.32 的紧凑指示器，可在配置中将其设为 `false`
- Web：修复流式 watchdog 在待处理审批请求或问题时误触发重连的问题——当用户正在处理审批请求或回答问题时，45 秒无消息 watchdog 不再强制重连，避免交互被打断
- Web：修复会话流错误后的恢复问题——当会话进程退出或 read loop 发生异常时，现在在广播错误前先清除过期的 in-flight prompt ID，使前端能够发送新消息而非收到 "Session is busy"；活动状态指示器现在也会显示来自流的具体错误信息
- Core：修复 Wire 服务端 prompt 处理未捕获异常导致会话永远卡在忙碌状态的问题——SSL 错误、连接错误及其他意外失败现在会被 fallback 处理器捕获并返回 INTERNAL_ERROR，避免异常逃逸导致会话无限挂起

## 1.34.0 (2026-04-14)

- Core：修复 `TaskStop` 取消卡住的后台 agent 时 CLI 崩溃的问题——终端不再打印 `Unhandled exception in event loop / Exception None` 并冻结；已取消的 task 现在会保留在管理器的 live-tasks 字典中，直到 runner 完成清理，避免 Python GC 在 task 仍处 pending 时回收它
- Shell：修复包含 tab 的行内 Diff 高亮偏移错位的问题——原始代码的 Diff 偏移量现在通过 expandtabs 列跟踪映射到渲染后的位置，确保 tab 展开后高亮区间落在正确位置
- Shell：新增 `show_thinking_stream` 配置项，可恢复旧版的流式思考预览体验——设为 `true` 后，Live 区域会显示经典的 `Thinking...` spinner 以及 6 行原始思考文本的滚动预览，思考块结束时把完整的思考 markdown 写入历史记录；默认为 `false`，保持 1.32 版本引入的紧凑指示器

## 1.33.0 (2026-04-13)

- Shell：将托管模型显示统一为 "Kimi for Code"，移除欢迎界面和 `/login` 提示中硬编码的 `kimi-k2.5` 版本号

## 1.32.0 (2026-04-13)

- Core：将 MCP 工具输出截断至 10 万字符以防止上下文溢出——所有内容类型（文本和内联媒体如 image/audio/video data URL）共享同一字符预算；Playwright 等返回完整 DOM（500KB+）或大型 base64 截图的工具现在会被截断并附加提示信息；超出预算的媒体部分会被丢弃；不支持的 MCP 内容类型会被优雅处理而非导致当前轮次崩溃
- CLI：修复 PyInstaller 二进制包缺少延迟加载 CLI 子命令的问题——`kimi info`、`kimi export`、`kimi mcp`、`kimi plugin`、`kimi vis` 和 `kimi web` 现在在独立二进制分发中可正常使用
- Shell：将思考指示器精简为紧凑的单行布局——显示 `Thinking` 标签、动画点、耗时、token 数和实时的 tokens/秒脉冲；结束后在历史中留下 `Thought for Xs · N tokens` 痕迹

## 1.31.0 (2026-04-10)

- Core：限制 `list_directory` 输出为深度受限的树形结构，防止大目录导致 token 超限——将无上限的扁平列表替换为 2 级树（根级最多 30 条、每个子目录最多 10 条），按目录优先的字母序排列，截断处显示 `"... and N more"` 提示以引导模型进一步探索（修复 #1809）
- Shell：新增交互式 Shell 启动时的阻断式更新提醒——当检测到有新版本可用（来自已有的后台检查缓存）时，在 Shell 加载之前显示阻断提示，提供 `[Enter]` 立即升级、`[q]` 暂时跳过下次继续提醒、`[s]` 跳过该版本后续提醒；支持 `KIMI_CLI_NO_AUTO_UPDATE` 环境变量；替代了之前可用更新的重复 toast 通知
- Auth：加固 OAuth 令牌刷新以防止不必要的重新登录——401 错误现在会自动触发令牌刷新并重试，而非强制 `/login`；多个同时运行的 CLI 实例通过跨进程文件锁协调刷新以避免竞争条件；令牌持久化使用原子写入配合 `fsync` 防止损坏；新增动态刷新阈值、令牌刷新过程中的 5xx 重试，以及正确的令牌吊销清理
- Core：修复模型响应仅包含思考内容时 agent loop 静默停止的问题——将仅含思考内容（无文本或工具调用）的响应检测为不完整响应错误并自动重试
- Core：修复长时间 streaming 过程中网络断连导致崩溃的问题——当 OpenAI SDK 在流式传输中途抛出基类 `APIError`（而非 `APIConnectionError`）时，现在能正确识别为可重试错误，自动触发重试和连接恢复，而不再直接崩溃退出
- Shell：从 `/sessions` 选择器中排除空的当前会话——完全为空的会话（既无对话记录也无自定义标题）不再显示在会话列表中；有自定义标题的会话仍然正常显示
- Shell：修复斜杠命令补全 Enter 键行为——接受补全后现在通过一次 Enter 即可提交命令；自动提交仅限于斜杠命令补全，文件引用（`@`）补全接受后不提交以便继续编辑；接受补全时抑制重新补全，防止过时的补全状态
- Shell：为 `/sessions` 会话选择器新增目录范围切换功能——按 `Ctrl+A` 可在"仅当前工作目录"和"所有已知目录"之间切换会话列表；采用全屏会话选择器 UI，顶部显示当前范围，底部显示快捷键提示
- Shell：新增 `/btw` 侧问命令——在 streaming 期间提出快速问题，不打断主对话；使用相同的系统提示词和工具定义以对齐 Prompt 缓存；响应在可滚动的模态面板中显示，支持流式输出
- Shell：重新设计底部动态区——将单体 `visualize.py`（1865 行）拆分为模块化包（`visualize/`），包含输入路由、交互式提示、审批/提问面板和 btw 模态面板等独立模块；通过 `classify_input()` 统一输入语义，实现一致的命令路由
- Shell：新增 streaming 期间的排队和 steer 双通道输入——Enter 将消息排队，在当前轮次结束后发送；Ctrl+S 将消息立即注入到正在运行的轮次上下文中；排队消息在提示区域显示计数指示器，可通过 ↑ 键召回编辑
- Shell：新增 `BtwBegin`/`BtwEnd` Wire 事件，支持跨客户端侧问
- Shell：改进 spinner 中的耗时格式——超过 60 秒的时长现在显示为 `"1m 23s"` 而非 `"83s"`；低于 1 秒的显示为 `"<1s"`
- Shell：修复 btw 面板中的 Rich markup 注入问题——包含 `[`/`]` 字符的用户问题现在会被转义，防止 spinner 文本和面板标题出现渲染错误或样式注入
- Core：改进错误诊断——丰富内部日志覆盖，在 `kimi export` 导出的归档中包含相关日志文件和系统信息，并为常见错误（认证、网络、超时、配额）提供可操作的提示消息
- Shell：当工作目录在会话期间不可访问时优雅退出并显示崩溃报告——检测 CWD 丢失场景（外置硬盘拔出、目录被删除或文件系统卸载），打印包含会话 ID 和工作目录的恢复面板后干净退出
- Shell：使用 `git ls-files` 进行 `@` 文件引用发现——文件补全器现在优先使用 `git ls-files --recurse-submodules` 查询文件列表（5 秒超时），非 Git 仓库则回退到 `os.walk`；此修复解决了大型仓库（如包含 6.5 万+文件的 apache/superset）中 1000 文件限制导致字母顺序靠后的目录无法访问的问题（修复 #1375）
- Core：新增共享的 `file_filter` 模块——通过 `src/kimi_cli/utils/file_filter.py` 统一 Shell 和 Web 的文件引用逻辑，提供一致的路径过滤、忽略目录排除和 Git 感知文件发现
- Shell：防止文件引用 scope 参数的路径遍历——文件补全器请求中的 `scope` 参数现在会经过验证，防止目录遍历攻击
- Web：恢复文件浏览器 API 中的未过滤目录列表——文件浏览器端点不再应用 Git 感知过滤，确保 Web UI 文件选择器中显示所有文件
- Todo：重构 `SetTodoList` 工具，支持状态持久化并防止工具调用风暴——待办事项现在会持久化到会话状态（主 Agent）和独立状态文件（子 Agent）；新增查询模式（省略 `todos` 参数可读取当前状态）和清空模式（传 `[]` 清空）；工具描述中增加了防风暴指导，防止在没有实际进展的情况下反复调用（修复 #1710）
- ReadFile：每次读取返回文件总行数，并支持负数 `line_offset` 实现 tail 模式——工具现在会在消息中报告 `Total lines in file: N.`，方便模型规划后续读取；负数 `line_offset`（如 `-100`）通过滑动窗口读取文件末尾 N 行，适用于无需 Shell 命令即可查看最新日志输出的场景；绝对值上限为 1000（MAX_LINES）
- Shell：修复 Markdown 渲染中行内代码和代码块出现黑色背景的问题——`NEUTRAL_MARKDOWN_THEME` 现在将所有 Rich 默认的 `markdown.*` 样式覆盖为 `"none"`，防止 Rich 内置的 `"cyan on black"` 在非黑色背景终端上泄露

## 1.30.0 (2026-04-02)

- Shell：细化空闲时后台完成的自动触发行为——恢复的 Shell 会话在用户发送消息前，不会因为历史遗留的后台通知而自动启动新的前景轮次；当用户正在输入时，新的后台完成事件也会短暂延后触发，避免抢占提示符或打断 CJK 输入法组合态
- Core：修复前景轮次在中断后残留不平衡 Wire 事件的问题——轮次因取消或步骤中断退出时，现在也会补发 `TurnEnd`，避免恢复多次后会话 `wire.jsonl` 越来越脏
- Core：提升会话启动恢复的鲁棒性——`--continue`/`--resume` 现在可容忍损坏的 `context.jsonl` 记录，以及损坏的子 Agent、后台任务或通知持久化工件；CLI 会尽可能跳过无效状态并继续恢复会话，而不是直接启动失败
- CLI：改进 `kimi export` 会话导出体验——`kimi export` 现在默认预览并确认当前工作目录的上一个会话，显示会话 ID、标题和最后一条用户消息时间；新增 `--yes` 跳过确认；同时修复显式会话 ID 时 `--output` 放在参数后面会被错误解析为子命令的问题
- Grep：新增 `include_ignored` 参数，支持搜索被 `.gitignore` 排除的文件——设为 `true` 时启用 ripgrep 的 `--no-ignore` 标志，可搜索构建产物或 `node_modules` 等通常被忽略的文件；敏感文件（如 `.env`）仍由敏感文件保护层过滤；默认 `false`，不影响现有行为
- Core：为 Grep 和 Read 工具添加敏感文件保护——`.env`、SSH 私钥（`id_rsa`、`id_ed25519`、`id_ecdsa`）和云凭据（`.aws/credentials`、`.gcp/credentials`）会被检测并拦截；Grep 从结果中过滤并显示警告，Read 直接拒绝读取；`.env.example`/`.env.sample`/`.env.template` 不受影响
- Core：修复并行 foreground 子 Agent 审批请求导致会话挂死的问题——在交互式 Shell 模式下，`_set_active_approval_sink` 不再将待处理的审批请求 flush 到 live view sink（该 sink 无法渲染审批弹窗）；请求保留在 pending 队列中由 prompt modal 路径处理；同时为 `wait_for_response` 增加 300 秒超时，确保未被 resolve 的审批请求最终抛出 `ApprovalCancelledError` 而非永久挂起
- CLI：新增 `--session`/`--resume`（`-S`/`-r`）参数用于恢复会话——不带参数时打开交互式会话选择器（仅 Shell UI）；带会话 ID 时恢复指定会话；以统一的可选值参数设计替代了被回退的 `--pick-session`/`--list-sessions`
- CLI：新增 CJK 安全的 `shorten()` 工具函数——替换所有 `textwrap.shorten` 调用，使不含空格的中日韩文本能优雅截断，而非被折叠成仅剩省略号
- Core：修复当通用目录（如 `~/.config/agents/skills/`）存在但为空时，品牌目录（如 `~/.kimi/skills/`）中的 Skills 静默消失的问题——Skill 目录发现现在独立搜索品牌组和通用组目录并合并结果，而非在所有候选目录中找到第一个就停止
- Core：新增 `merge_all_available_skills` 配置项——启用后，所有存在的品牌目录（`~/.kimi/skills/`、`~/.claude/skills/`、`~/.codex/skills/`）中的 Skills 都会被加载并合并，而非仅使用找到的第一个；同名 Skill 按 kimi > claude > codex 的优先级解析；默认关闭
- CLI：新增 `--plan` 启动参数和 `default_plan_mode` 配置项——通过 `kimi --plan` 或在 `~/.kimi/config.toml` 中设置 `default_plan_mode = true` 可让新会话直接进入计划模式；恢复的会话保留其原有的计划模式状态
- Shell：新增 `/undo` 和 `/fork` 命令用于会话分支——`/undo` 支持选择一个历史轮次并 fork 出新会话，被选中轮次的用户消息会预填到输入框供重新编辑；`/fork` 将当前完整对话历史复制到新会话；原会话始终保留不丢失
- CLI：新增 `-r` 作为 `--session` 的简写别名，并在会话退出时输出恢复提示（`kimi -r <session-id>`）——覆盖正常退出、Ctrl-C、`/undo`、`/fork` 和 `/sessions` 切换等场景，确保用户始终能找到回到会话的方式
- Core：修复 `custom_headers` 未传递给非 Kimi provider 的问题——OpenAI、Anthropic、Google GenAI 和 Vertex AI provider 现在能正确转发 `providers.*.custom_headers` 中配置的自定义请求头

## 1.29.0 (2026-04-01)

- Core：支持层级化 `AGENTS.md` 加载——CLI 现在会从 git 项目根目录到工作目录逐层发现并合并 `AGENTS.md` 文件，包括每层目录中的 `.kimi/AGENTS.md`；在 32 KiB 预算上限下，更深层目录的文件优先保留，确保最具体的指令不会被截断
- Core：修复空会话在退出后残留在磁盘上的问题——创建但未使用的会话现在会在所有退出路径（失败退出、会话切换、异常错误）中被清理，而不仅限于成功退出
- Shell：新增 `KIMI_CLI_PASTE_CHAR_THRESHOLD` 和 `KIMI_CLI_PASTE_LINE_THRESHOLD` 环境变量，控制粘贴文本折叠为占位符的阈值——降低这些阈值可规避部分终端（如通过 SSH 连接的 XShell）在粘贴多行文本后 CJK 输入法失效的问题
- Shell：修复不支持 truecolor 的终端（如 Xshell）上 diff 面板渲染异常的问题——`render_to_ansi` 不再硬编码 24 位色；Rich 现在通过 `COLORTERM`/`TERM` 环境变量自动检测终端颜色能力
- Web：修复 CLI 升级后浏览器缓存旧 `index.html` 导致白屏的问题——服务端现在对 HTML 返回 `Cache-Control: no-cache`，对带 hash 的静态资源返回 `immutable`，防止因 chunk 文件名变更而产生 404
- Core：修复 Windows 上文件写入时 LF 被转换为 CRLF 的问题——`writetext` 现在以 `newline=""` 打开文件，防止 Python 的通用换行符转换将 `\n` 静默转为 `\r\n`
- Core：支持 `socks://` 代理协议——V2RayN 等代理工具会设置 `ALL_PROXY=socks://...`，但 httpx/aiohttp 不识别该协议；CLI 现在会在启动时将 `socks://` 归一化为 `socks5://`，确保所有 HTTP 客户端和子进程在 SOCKS 代理环境下正常工作
- Shell：新增 `/title`（别名 `/rename`）命令，支持手动设置会话标题——标题现在统一存储在 `state.json` 中；旧版 `metadata.json` 会在首次加载时自动迁移
- Shell：修复设置 `MANPAGER`（如 `bat`）后分页器输出乱码的问题——控制台分页器现在忽略 `MANPAGER`，委托给 `pydoc.pager()` 处理，保留 `PAGER` 及所有平台特定的回退逻辑
- Explore：增强 explore Agent 的专家角色、搜索深度等级和自动环境上下文——explore Agent 启动时会自动获取仓库环境信息以提升调研质量；主 Agent 被引导优先使用 explore 进行代码库研究，Plan 模式鼓励先用 explore 调研再制定方案
- Shell：修复工具调用显示中出现原始 OSC 8 转义字节（如 `8;id=391551;https://…`）的问题——超链接序列现在被包装为零宽转义以兼容 prompt_toolkit，在支持的终端中保留可点击链接
- Core：在系统提示词中添加操作系统和 Shell 信息——模型现在能感知当前运行平台，Windows 上会收到优先使用内置工具而非 Shell 命令的指引，避免在 PowerShell 中执行 Linux 命令导致报错
- Shell：修复 `command` 参数描述在所有平台上都写着 "bash command" 的问题——描述现在与平台无关
- Web：修复自动标题覆盖手动会话重命名的问题——用户通过 Web UI 重命名会话后，新标题现在会被保留，不再被自动生成的标题替换
## 1.28.0 (2026-03-30)

- Core：修复文件写入/替换工具冻结事件循环的问题——diff 计算（`build_diff_blocks`）现在通过 `asyncio.to_thread` 转移到线程中执行，防止编辑大文件时 UI 卡死
- Shell：修复 `_watch_root_wire_hub` 在处理异常时静默退出的问题——观察者现在会捕获并记录异常（与 `wire/server.py` 中的模式一致），并优雅处理 `QueueShutDown`，防止审批流程在会话中途静默中断
- Core：对超大文件（>10000 行）跳过 O(n²) diff 计算——超过阈值的文件现在显示摘要块而非计算完整 diff，未变化的文件会立即短路返回
- Wire：为 `DiffDisplayBlock` 新增 `is_summary` 字段（Wire 1.8）——标记包含行数摘要而非实际 diff 内容的块，便于客户端做差异化渲染
- Web：渲染大文件 diff 摘要——当 diff 块标记为 `is_summary` 时，Web UI 显示紧凑的"文件过大无法内联 diff"提示及行数，而非尝试计算 diff
- Auth：修复 OAuth 用户执行 Skill 或空闲后出现 "incorrect API KEY" 的问题——401 错误现在会显示清晰的 "请 /login" 提示，而不是原始的 API 错误信息；ACP 层会正确触发 VS Code 扩展的重新登录流程
- Web：修复 OAuth 用户的会话标题生成始终失败的问题——标题生成器现在会使用 OAuth 令牌，并在调用模型前刷新过期令牌
- Core：为 Agent 工具和 HTTP 请求添加超时保护——所有 `aiohttp` 会话现在默认 120 秒总超时 / 60 秒读取超时；Agent 工具新增可选 `timeout` 参数（前台默认 10 分钟，后台默认 15 分钟）；后台 Agent 任务超时后标记为 `timed_out` 并正确触发通知
- Grep：修复工具卡死且无法中断的问题——将阻塞的 `ripgrepy.run()` 替换为异步子进程执行；工具现在可响应 Ctrl-C 立即中断，并设有 20 秒超时保护，超时后返回部分结果
- Grep：新增 Token 效率优化——默认 `head_limit` 为 250 并支持 `offset` 分页、启用 `--hidden` 搜索同时排除 VCS 目录、`files_with_matches` 按修改时间排序、输出相对路径、非 content 模式限制最大列宽 500
- Grep：content 模式的 `line_number`（`-n`）现在默认为 `true`——默认包含行号，以便模型引用精确的代码位置
- Grep：`count_matches` 模式现在在 message 中包含汇总信息——例如 "Found 30 total occurrences across 10 files."
- ACP：修复通过 `kimi-code` 或 `kimi-cli` 入口启动 ACP 时 `ValueError: list.index(x): x not in list` 崩溃的问题（如 JetBrains AI Assistant 场景）
- Core：修复 OpenAI 兼容 API（如 One API）在多轮对话中返回 400 错误的问题——当服务端默认返回 `reasoning_content` 时，现在会在历史消息包含思考内容且配置了 `reasoning_key` 的情况下自动设置 `reasoning_effort` 为 `"medium"`
- Shell：新增 `/theme` 命令和深色/浅色主题支持——使用浅色终端背景的用户可通过 `/theme light` 或在 `config.toml` 中设置 `theme = "light"` 切换到浅色配色方案；diff 高亮、任务浏览器、提示符 UI 和 MCP 状态颜色均会跟随所选主题自动适配
- Core：修复压缩前上下文溢出问题——工具结果的 Token 数现在会被估算并纳入自动压缩触发检查，防止大量工具输出在 API 调用间隙将上下文推超模型限制时出现"exceeded model token limit"错误
- Core：新增 hooks 系统（Beta）——在 `config.toml` 中配置 `[[hooks]]`，可在 13 个生命周期事件（包括 `PreToolUse`、`PostToolUse`、`SessionStart`、`Stop` 等）运行自定义 shell 命令；支持正则匹配、超时处理和通过退出码 2 阻塞操作
- Shell：新增 `/hooks` 命令——列出所有已配置的 hooks 及其事件计数
- Wire：新增 `HookTriggered` 和 `HookResolved` 事件类型（Wire 1.7）——在 hooks 开始和完成执行时通知客户端，包含事件类型、目标、操作（允许/阻塞）和耗时
- Wire：新增 `HookRequest` 和 `HookResponse` 消息类型——允许 Wire 客户端订阅 hook 事件并提供自己的处理逻辑，返回允许或阻塞的决策
- Shell：修复通知消息泄漏到会话回放和导出中的问题——后台任务通知标签（`<notification>`、`<task-notification>`）在恢复会话（`/sessions`）以及导出（`/export`）或导入（`/import`）对话历史时现在会被正确过滤
- CLI：`--skills-dir` 现在支持多个目录并覆盖默认发现——指定后，这些目录将替代用户/项目 Skills 发现（可重复的标志）
- Web：工作区顶部的 "Open" 按钮现在会记住上次使用的应用——点击 "Open" 直接以上次选择的应用打开，点击下拉箭头可重新选择其他应用
- Web：修复 Archived 会话计数仅显示已加载页面大小的问题——当存在更多 Archived 会话时，计数标签现在显示 "100+"
- Shell：修复粘贴文本占位符在模态回答中未展开的问题——粘贴到审批面板或问题面板中的剪贴板内容现在会在发送给模型前正确插值
- Vis：新增 `--network / -n` 启动参数——在所有网络接口上启动可视化工具并自动探测和显示 LAN IP 地址，与 `kimi web` 行为一致
- Vis：新增 `/vis` 斜杠命令——在交互式 Shell 中一步切换到 Tracing 可视化工具，与现有 `/web` 命令对称
- Vis：改进会话列表性能——后端异步扫描、请求并发限制、无限滚动分页，防止大量会话时浏览器卡顿
- Vis：补齐 7 个缺失的 Wire 事件类型——`SteerInput`、`MCPLoadingBegin/End`、`Notification`、`PlanDisplay`、`ToolCallRequest` 和 `QuestionRequest` 现在以正确的颜色和摘要显示
- Vis：StatusUpdate 显示 Token 和缓存详情——每个状态更新现在显示上下文 Token 数、最大 Token 数、输入 Token 分解及缓存命中率、MCP 连接状态
- Vis：工具调用显示结构化摘要——`ReadFile`、`Shell`、`Glob`、`Grep`、`Agent` 等工具调用直接在行内显示文件路径、命令或搜索模式，而非仅显示函数名
- Vis：Context Messages 新增 System Prompt 卡片——`_system_prompt` 条目以专用蓝色卡片渲染，显示估算的 Token 数并支持展开查看完整内容
- Vis：会话头部显示缓存命中率——统计栏现在在 Token 数旁显示整体缓存效率（如 `89% cache`）
- Vis：高亮慢操作——时间间隔超过 10 秒以琥珀色显示，超过 60 秒以红色显示，使性能瓶颈一目了然
- Vis：ToolResult 摘要优先显示人类可读的 `message` 字段——结果现在显示如 "Command executed successfully" 等描述性文本，而非原始输出
- Vis：显示审批拒绝反馈——`ApprovalResponse` 摘要在工具调用被拒绝时包含用户的修正文本

## 1.27.0 (2026-03-28)

- Shell：新增 `/feedback` 命令——可直接在 CLI 会话中提交反馈，网络错误或超时时自动回退到打开 GitHub Issues 页面
- Shell：重新设计工具结果中的 diff 渲染——文件 diff 现在显示行号、背景色（绿色/红色）、语法高亮和行内字符级变更标记；审批预览仅显示变更行以提供紧凑视图；Ctrl-E 翻页器使用相同的统一风格
- Shell：更新语法高亮主题——将原本大量使用品红色的配色方案替换为更均衡的 ANSI 调色板，兼容各种终端；改善色彩多样性和在深色/亮色终端背景下的可读性
- Shell：修复多个 Subagent 运行时审批面板不可见的问题——审批面板和问题面板现在渲染在 Live 视图顶部，确保即使工具调用输出超出终端高度时仍然可见
- CLI：修复 `--print` 模式在出错时退出码为 0 的问题——Print 模式现在对永久性错误（认证失败、配置无效等）返回退出码 1，对可重试错误（429 速率限制、5xx 服务端错误、连接超时）返回退出码 75，使 CI/Eval 运行器能够检测失败并决定是否重试
- Plan：计划内容现在直接显示在聊天记录中，而非隐藏在翻页器后——计划以带边框的面板形式渲染在对话历史中，并展示计划文件路径供参考
- Plan：Plan 审批新增 "Reject and Exit" 选项——用户现在可以一步拒绝计划并退出 Plan 模式，除现有的 Approve、Revise 和 Reject 选项外
- Wire：新增 `PlanDisplay` 事件类型（Wire 1.7）——携带计划内容和文件路径，供客户端内联渲染
- Shell：流式输出 Markdown 内容——已完成的 Markdown 块（段落、列表、代码块、表格）现在会在流式传输过程中即时渲染并输出到终端，而非缓冲到整个轮次结束后才显示
- Shell：在 Thinking/Composing 加载动画上显示耗时和估算 Token 数——加载动画现在会显示 `Thinking... 5s · 312 tokens`，计数在生成过程中实时更新
- Shell：为 Thinking 内容添加滚动预览——模型思考过程的最后 6 行会以灰色斜体实时显示在加载动画下方
- Shell：将输入区域预留空间从 10 行缩减至 6 行
- Glob：`Glob` 工具现在可以访问 Skills 目录——除工作区外，该工具现在还可以搜索已发现的 Skill 根目录
- Glob：`Glob` 工具现在在验证目录路径前会展开 `~` 为用户主目录

## 1.26.0 (2026-03-25)

- Kosong：修复 Google GenAI 提供商在 `FunctionCall`/`FunctionResponse` 中包含 `id` 字段的问题——Gemini API 在包含 `id` 时返回 HTTP 400；从 wire 格式中移除该字段，同时保持内部 `tool_call_id` 跟踪不变
- Core：修复 MCP 服务器 stderr 污染问题——stderr 重定向现在在 MCP 服务器启动前安装，子进程日志（如 `mcp-remote` 的 OAuth 调试输出）将被捕获到日志文件，而非输出到终端
- Shell：修复子进程遇到交互式提示时挂起的问题——`Shell` 工具现在会立即关闭 stdin 并设置 `GIT_TERMINAL_PROMPT=0`，使需要凭证的命令（如通过 HTTPS 执行 `git push`）快速失败，而非阻塞至超时
- Core：修复 LLM 工具调用参数包含未转义控制字符时 JSON 解析失败的问题——在所有 LLM 输出解析路径使用 `json.loads(strict=False)`，防止工具执行失败和会话永久损坏
- Shell：空闲时自动响应后台任务完成——Shell 现在会检测后台 Bash 命令或 Agent 任务的完成，并自动发起新的 Agent 轮次处理结果，无需等待用户输入
- Core：修复 Print 模式下 `QuestionRequest` 导致挂起的问题——`AskUserQuestion`、`EnterPlanMode` 和 `ExitPlanMode` 在非交互（yolo）模式下自动处理，避免 `--print` 会话中工具调用无限挂起
- Core：修复后台 Agent 任务运行期间无法查看输出的问题——`/task` 浏览器和 `TaskOutput` 工具现在可实时显示后台 Agent 任务的输出，通过在执行期间同步写入任务日志替代完成后拷贝的方式实现
- Core：增强系统提示词以鼓励工具调用——Agent 现在默认优先使用工具执行操作，而非将代码作为纯文本输出
- Core：修复生成过程中遇到 `httpx.ProtocolError` 或 `504 Gateway Timeout` 时不重试的问题——流式协议断连和瞬时 `504` 响应现在会走既有重试路径，而不是在网络不稳定时直接中断当前轮次
- Kosong：修复 Anthropic 提供商在流式传输期间 `httpx.ReadTimeout` 异常泄漏的问题——异常现在正确转换为 `APITimeoutError`，使此前被绕过的重试逻辑能够正常触发

## 1.25.0 (2026-03-23)

- Core：新增插件系统（Skills + Tools）——插件通过 `plugin.json` 为 Kimi Code CLI 扩展自定义工具；工具是在独立子进程中运行的命令，其 stdout 返回给 Agent；插件支持通过 `inject` 配置自动注入凭证
- Core：支持多插件仓库——`kimi plugin install` 接受带 subpath 的 Git URL，从 monorepo 中安装特定插件（如 `https://github.com/org/repo.git/plugins/my-plugin`）；当未提供 subpath 且根目录无 `plugin.json` 时，CLI 会列出直接子目录中可用的插件
- Core：统一插件凭证注入——插件可在 `plugin.json` 中声明 `inject` 字段，从主机的 LLM 提供商配置接收 `api_key` 和 `base_url`；支持 OAuth 托管 token 和静态 API key 两种凭证类型
- Core：新增 `Agent` 工具支持子 Agent 委派——Agent 现在可以创建持久的子 Agent 实例，内置三种类型（`coder`、`explore`、`plan`）处理聚焦的子任务；每个实例在会话内维护独立的上下文历史，支持前台或后台运行并自动汇总结果
- Core：统一审批运行时——前台工具调用和后台子 Agent 的审批请求现在通过统一的运行时协调，并由根 UI 通道呈现；拒绝响应可包含反馈文本以指导模型的下一次尝试
- Shell：新增交互式审批请求面板——内联面板展示工具调用详情（Diff、Shell 命令等），提供批准一次、批准本次会话、拒绝或附带反馈文字拒绝等选项
- Wire：协议版本升级至 1.6——`SubagentEvent` 新增 `agent_id`、`subagent_type`、`parent_tool_call_id` 字段；`ApprovalRequest` 包含来源元数据（`source_kind`、`source_id`）；`ApprovalResponse` 支持 `feedback` 字段
- Vis：新增 Agents 面板——`kimi vis` 中新增 "Agents" 标签页，可查看子 Agent 实例及其事件，并按 Agent 范围筛选 Wire 时间线
- Core：`TaskOutput` 的 `block` 参数默认值从 `true` 改为 `false`——`TaskOutput` 现在默认返回非阻塞的状态/输出快照；仅在需要等待任务完成时设置 `block=true`
- Shell：在提示工具栏中显示当前工作目录、Git 分支、脏状态以及与远端的 ahead/behind 同步状态
- Shell：在工具栏中显示活跃后台 Bash 任务数量，按时间轮换快捷键提示，并在窄终端中优雅截断内容以避免溢出
- Web：修复取消和审批时工具执行状态同步问题——停止生成时工具现在正确过渡到 `output-denied` 状态，审批通过后执行期间显示加载动画（而非勾选图标）
- Web：会话重放时消除过期的审批和问答对话框——重放会话或后端报告 idle/stopped/error 状态时，所有待处理的审批/问答对话框现在会被正确消除，防止产生孤立的交互元素
- Web：支持行内数学公式渲染——除块级数学公式（`$$...$$`）外，新增支持单美元符号行内数学公式（`$...$`）
- Web：优化 Switch 切换开关的比例和对齐——切换轨道现在更大（36×20），拇指按钮保持 16px 并具备更平滑的 16px 位移动画
- Web：在活动面板中显示子 Agent 类型标签——子 Agent 活动现在显示其类型（如 "Coder agent working"）而非通用的 "Agent" 标签
- Web：审批对话框新增反馈模式——按 `4` 可附带反馈文字拒绝，指导模型的下一次尝试；来自子 Agent 的审批请求会显示来源标签和预览内容（Diff、命令等）
- Web：视觉区分子 Agent 来源的工具调用——来自子 Agent 的 Tool 消息以左边框和来源类型标签渲染，便于区分归属

## 1.24.0 (2026-03-18)

- Shell：提高长文本粘贴自动折叠阈值至 1000 字符或 15 行（之前为 300 字符或 3 行），改善语音/无键盘输入等场景下的体验
- Core：Plan 模式现在支持多选方案——当 Agent 的计划包含多个不同路径时，`ExitPlanMode` 可展示 2–3 个带标签的选项供用户选择执行哪一个方案；用户选择的方案会作为选定路径返回给 Agent
- Core：跨进程重启持久化 Plan 会话 ID 和文件路径——Plan 会话标识符和文件 slug 保存到 `SessionState`，重启 Kimi Code 后会继续使用 `~/.kimi/plans/` 下的同一计划文件，而非创建新文件
- Core：Plan 模式现在支持增量编辑计划文件——Agent 可以使用 `StrReplaceFile` 精准更新计划文件的特定部分，而无需通过 `WriteFile` 重写整个文件；同时非计划文件的编辑现在会被直接阻止，而非弹出审批请求
- Core：延迟 MCP 启动并展示加载进度——MCP 服务器现在在 Shell UI 启动后异步初始化，并提供实时进度指示器显示连接状态；Shell 在状态区域显示连接中和就绪状态，Web 显示服务器连接状态
- Core：优化轻量级启动路径——对 CLI 子命令和版本元数据实现延迟加载，显著缩短 `--version` 和 `--help` 等常用命令的启动时间
- Build：修复 Nix `FileCollisionError` for `bin/kimi`——从 `kimi-code` 包中移除重复的入口点，使 `kimi-cli` 独占 `bin/kimi`
- Shell：Agent 运行期间保留用户未提交的输入——在模型运行时在提示符中键入的文本不再在轮次结束时丢失，用户可以按回车键将草稿作为下一条消息提交
- Shell：修复 Agent 运行结束后 Ctrl-C 和 Ctrl-D 无法正常工作的问题——键盘中断和 EOF 信号被静默吞没，而非显示提示信息或退出 Shell

## 1.23.0 (2026-03-17)

- Shell：新增后台 Bash——`Shell` 工具现在支持 `run_in_background=true` 参数，可将耗时命令（构建、测试、服务）作为后台任务启动，Agent 无需等待即可继续工作；新增 `TaskList`、`TaskOutput`、`TaskStop` 工具管理任务生命周期，任务到达终止态时系统自动通知 Agent
- Shell：新增 `/task` 斜杠命令与交互式任务浏览器——三列 TUI 界面，支持查看、监控和管理后台任务，提供实时刷新、输出预览和键盘驱动的任务停止操作
- Web：修复切换模型后其他标签页全局配置未刷新的问题——在某个标签页中切换模型时，其他标签页现在能检测到配置更新并自动刷新全局配置

## 1.22.0 (2026-03-13)

- Shell：长文本粘贴自动折叠为 `[Pasted text #n]` 占位符——通过 `Ctrl-V` 或括号粘贴输入的超过 300 字符或 3 行的文本在提示缓冲区中显示为紧凑的占位符标记，完整内容在发送给模型时展开；外部编辑器（`Ctrl-O`）打开时自动展开占位符，保存后重新折叠
- Shell：粘贴的图片缓存为附件占位符——从剪贴板粘贴的图片存储到磁盘，在提示中显示为 `[image:…]` 标记，保持输入缓冲区整洁
- Shell：修复粘贴文本中 UTF-16 surrogate 字符导致序列化错误的问题——来自 Windows 剪贴板的孤立 surrogate 字符现在在存储前即被清洗，防止历史记录写入和 JSON 序列化时出现 `UnicodeEncodeError`
- Shell：重新设计斜杠命令补全菜单——使用全宽自定义菜单替代默认的补全弹窗，展示命令名称和多行描述，支持高亮和滚动
- Shell：修复取消的 Shell 命令未正确终止子进程的问题——当运行中的命令被取消时，子进程现在会被显式杀死，防止产生孤儿进程

## 1.21.0 (2026-03-12)

- Shell：新增内联运行提示与 steer 输入——模型运行时 Agent 输出直接渲染在提示区域内，用户无需等待轮次结束即可输入并发送后续消息（steer）；审批请求和问答面板支持内联键盘交互
- Core：将 steer 注入方式从合成工具调用改为常规 User 消息——steer 内容现作为标准 User 消息追加到上下文，而非伪造的 `_steer` 工具调用/工具结果对，改善了上下文序列化和可视化的兼容性
- Wire：新增 `SteerInput` 事件——当用户在运行中的轮次发送后续 steer 消息时触发的新 Wire 协议事件
- Shell：Agent 模式下提交后回显用户输入——提示符和输入文本会打印回终端，使对话记录更清晰
- Shell：改进会话回放对 steer 输入的支持——回放现在能正确重建并展示 steer 消息与常规轮次，并过滤内部 system-reminder 消息
- Shell：修复 toast 通知中升级命令不一致的问题——升级命令文本统一从 `UPGRADE_COMMAND` 常量获取
- Core：在 `context.jsonl` 中持久化系统提示词——系统提示词作为上下文文件的第一条记录写入，并在会话生命周期内冻结，使可视化工具能读取完整对话上下文，会话恢复时复用原始提示词而非重新生成
- Vis：为 `kimi vis` 新增会话目录快捷操作——可在会话页面直接打开当前会话文件夹，使用 `Copy DIR` 复制原始会话目录路径，并支持在 macOS 和 Windows 上打开目录
- Shell：优化 API 密钥登录体验——验证密钥时显示加载动画，当 401 错误可能因选错平台导致时显示提示信息，登录成功后展示配置摘要，并将 Thinking 模式默认设为开启

## 1.20.0 (2026-03-11)

- Web：新增 Web UI 中的 Plan 模式切换——在输入工具栏中添加开关控件，Plan 模式激活时输入框显示蓝色虚线边框，并支持通过 `set_plan_mode` Wire 协议方法设置 Plan 模式
- Core：Plan 模式状态跨会话持久化——将 `plan_mode` 保存到 `SessionState`，会话恢复时自动还原
- Core：修复工具触发的 Plan 模式变更未正确反映在 StatusUpdate 中的问题——在 `EnterPlanMode`/`ExitPlanMode` 工具执行后发送更新的 `StatusUpdate`，确保客户端看到最新状态
- Core：修复部分 Linux 系统（如内核版本 6.8.0-101）上 HTTP 请求头包含尾部空白/换行符导致连接错误的问题——发送前对 ASCII 请求头值执行空白裁剪
- Core：修复 OpenAI Responses provider 隐式发送 `reasoning.effort=null` 导致需要推理的 Responses 兼容端点报错的问题——现在仅在显式设置时才发送推理参数
- Vis：新增会话下载、导入、导出与删除功能——在会话浏览器和详情页支持一键 ZIP 下载，支持将 ZIP 文件导入到独立的 `~/.kimi/imported_sessions/` 目录并通过"Imported"筛选器切换查看，新增 `kimi export <session_id>` CLI 命令，支持删除导入的会话并提供 AlertDialog 二次确认
- Core：修复对话包含媒体内容（图片、音频、视频）时上下文压缩失败的问题——将过滤策略从黑名单（排除 `ThinkPart`）改为白名单（仅保留 `TextPart`），防止不支持的内容类型被发送到压缩 API
- Web：修复 `@` 文件提及索引在切换会话或工作区文件变更后不刷新的问题——切换会话时重置索引，30 秒过期自动刷新，输入路径前缀可查找超出 500 文件上限的文件

## 1.19.0 (2026-03-10)

- Core：新增 Plan 模式——AI 在编码前先制定实施方案并提交审批。Plan 模式下仅允许使用只读工具（`Glob`、`Grep`、`ReadFile`）探索代码库，将方案写入 plan 文件后通过 `ExitPlanMode` 提交审批，用户可批准、拒绝或提供修改意见；支持 `Shift-Tab` 快捷键和 `/plan` 斜杠命令切换
- Vis：新增 `kimi vis` 命令，启动交互式可视化仪表板以检查会话追踪——包括 Wire 事件时间线、上下文查看器、会话浏览器和用量统计
- Web：修复会话流状态管理问题——修复状态重置时的空引用错误，并在切换会话时保留斜杠命令，避免初始化响应返回前出现短暂的空白

## 1.18.0 (2026-03-09)

- ACP：支持 ACP 模式下的嵌入式资源内容，使 Zed 的 `@` 文件引用能够正确包含文件内容
- Core：在 Google GenAI provider 中使用 `parameters_json_schema` 替代 `parameters`，绕过 Pydantic 校验对 MCP 工具中标准 JSON Schema 元数据字段的拒绝
- Shell：增强 `Ctrl-V` 剪贴板粘贴功能，支持粘贴视频文件——视频文件路径以文本形式插入输入框，同时修复剪贴板数据为 `None` 时的崩溃问题
- Core：将会话 ID 作为 `user_id` 元数据传递给 Anthropic API
- Web：修复 WebSocket 重连时斜杠命令丢失的问题，并为会话初始化添加自动重试逻辑

## 1.17.0 (2026-03-03)

- Core：新增 `/export` 命令，支持将当前会话上下文（消息、元数据）导出为 Markdown 文件；新增 `/import` 命令，支持从文件或其他会话 ID 导入上下文到当前会话
- Shell：在状态栏上下文用量旁显示 Token 数量（已用/总量），如 `context: 42.0% (4.2k/10.0k)`
- Shell：工具栏快捷键提示改为轮转显示——每次提交后循环展示不同快捷键提示，节省横向空间
- MCP：为 MCP 服务器连接添加加载指示器——Shell 在连接 MCP 服务器时显示 "Connecting to MCP servers..." 加载动画，Web 在 MCP 工具加载期间显示状态消息
- Web：修复工具栏变更面板中文件列表滚动溢出的问题
- Core：新增 `compaction_trigger_ratio` 配置项（默认 `0.85`），用于控制自动压缩的触发时机——当上下文用量达到配置比例或剩余空间低于 `reserved_context_size` 时触发压缩，以先满足的条件为准
- Core：`/compact` 命令支持自定义指令（如 `/compact keep database discussions`），可指导压缩时重点保留的内容
- Web：新增 URL 操作参数（`?action=create` 打开创建会话对话框，`?action=create-in-dir&workDir=xxx` 直接创建会话）用于外部集成，支持 Cmd/Ctrl+点击新建会话按钮在新标签页中打开会话创建
- Web：在提示输入工具栏中添加待办列表显示——当 `SetTodoList` 工具激活时，显示任务进度并支持展开面板查看详情
- ACP：为会话操作添加认证检查，未认证时返回 `AUTH_REQUIRED` 错误响应，支持终端登录流程

## 1.16.0 (2026-02-27)

- Web：更新 ASCII Logo 横幅为新的样式设计
- Core：新增 `--add-dir` CLI 选项和 `/add-dir` 斜杠命令，支持将额外目录添加到工作区范围——添加的目录可被所有文件工具（读取、写入、glob、替换）访问，跨会话持久化保存，并在系统提示词中展示
- Shell：新增 `Ctrl-O` 快捷键，在外部编辑器中编辑当前输入内容（`$VISUAL`/`$EDITOR`），支持自动检测 VS Code、Vim、Vi 或 Nano
- Shell：新增 `/editor` 斜杠命令，可交互式配置和切换默认外部编辑器，设置持久保存到配置文件
- Shell：新增 `/new` 斜杠命令，无需重启 Kimi Code CLI 即可创建并切换到新会话
- Wire：当客户端不支持 `supports_question` 能力时，自动隐藏 `AskUserQuestion` 工具，避免 LLM 调用不受支持的交互
- Core：在压缩后估算上下文 Token 数量，使上下文用量百分比不再显示为 0%
- Web：上下文用量百分比显示精确到一位小数，提升精度

## 1.15.0 (2026-02-27)

- Shell：精简输入提示符，移除用户名前缀以获得更简洁的外观
- Shell：在工具栏中添加水平分隔线和更完整的键盘快捷键提示
- Shell：为问题面板和审批面板添加数字键（1–5）快速选择选项，并以带边框的面板和键盘提示重新设计交互界面
- Shell：为多问题面板添加标签式导航——使用左右方向键或 Tab 键在问题间切换，并以可视化指示器区分已答、当前和待答状态，重新访问已答问题时自动恢复选择状态
- Shell：在问题面板中支持使用空格键提交单选问题
- Web：为多问题对话框添加标签式导航，支持可点击标签栏、键盘导航，以及重新访问已答问题时恢复选择状态
- Core：将进程标题设置为 "Kimi Code"（在 `ps` / 活动监视器 / 终端标签页标题中可见），并将 Web Worker 子进程标记为 "kimi-code-worker"

## 1.14.0 (2026-02-26)

- Shell：在终端中将 `FetchURL` 工具的 URL 参数显示为可点击的超链接
- Tool：新增 `AskUserQuestion` 工具，支持在执行过程中向用户展示结构化问题和预定义选项，支持单选、多选和自定义文本输入
- Wire：新增 `QuestionRequest` / `QuestionResponse` 消息类型和能力协商机制，用于结构化问答交互
- Shell：新增 `AskUserQuestion` 交互式问题面板，支持键盘驱动的选项选择
- Web：新增 `QuestionDialog` 组件，支持在界面内展示并回答结构化问题，问题待回答时替代提示输入框
- Core：支持会话状态跨会话持久化——审批决策（YOLO 模式、自动批准的操作）和动态子 Agent 现在会被保存，并在恢复会话时自动还原
- Core：对元数据和会话状态文件使用原子化 JSON 写入，防止崩溃时数据损坏
- Wire：新增 `steer` 请求，可在 Agent 轮次进行中注入用户消息（协议版本 1.4）
- Web：支持在 `FetchURL` 工具的 URL 参数上使用 Cmd/Ctrl+点击在新标签页中打开链接，并显示适合当前平台的提示信息

## 1.13.0 (2026-02-24)

- Core：添加自动连接恢复机制，在连接错误和超时错误时重建 HTTP 客户端并重试，提升对瞬时网络故障的容错能力

## 1.12.0 (2026-02-11)

- Web：添加子 Agent 活动渲染，在 Task 工具消息中展示子 Agent 步骤（思考、工具调用、文本）
- Web：添加 Think 工具渲染，以轻量级推理风格块展示
- Web：将 emoji 状态指示器替换为 Lucide 图标，并为工具名称添加分类图标
- Web：改进 Reasoning 组件，优化思考标签和状态图标
- Web：改进 Todo 组件，添加状态图标并优化样式
- Web：实现 WebSocket 断线重连，支持自动重发请求和连接超时监控
- Web：改进创建会话对话框的命令值处理
- Web：支持会话工作目录路径中的波浪号（`~`）展开
- Web：修复 Assistant 消息内容溢出被裁剪的问题
- Wire：修复多个子 Agent 并发运行时的死锁问题，不再在审批请求和工具调用请求上阻塞 UI 循环
- Wire：Agent 轮次结束后清理残留的待处理请求
- Web：在提示输入框中显示引导占位文本，提示可使用斜杠命令和 @ 引用文件
- Web：修复在 uvicorn Web 服务器中 Ctrl+C 无法使用的问题，在 Shell 模式退出后恢复默认的 SIGINT 信号处理程序和终端状态
- Web：改进会话停止处理，使用正确的异步清理和超时机制
- ACP：添加协议版本协商框架，用于客户端与服务端之间的兼容性校验
- ACP：添加会话恢复方法，用于恢复会话状态（实验性）

## 1.11.0 (2026-02-10)

- Web：将上下文用量指示器从工作区标题栏移至提示工具栏，悬停时显示详细的 Token 用量明细
- Web：在文件变更面板底部添加文件夹指示器，显示工作目录路径
- Web：修复切换到 Web 模式时未恢复 stderr 的问题，该问题可能导致 Web 服务器的错误输出被抑制
- Web：修复端口可用性检查，在测试套接字上设置 SO_REUSEADDR

## 1.10.0 (2026-02-09)

- Web：为 Assistant 消息添加复制和分支(fork)操作按钮，支持快速复制内容和创建分支会话
- Web：为审批操作添加键盘快捷键——按 `1` 批准、`2` 本次会话批准、`3` 拒绝
- Web：添加消息队列功能——在 AI 处理过程中可排队发送后续消息，待当前回复完成后自动发送
- Web：将 Git diff 状态栏替换为统一的提示工具栏，以可折叠标签页展示活动状态、消息队列和文件变更
- Web：在 Web Worker 中加载全局 MCP 配置，使 Web 会话可以使用 MCP 工具
- Web：改进移动端提示输入框体验——缩小 textarea 最小高度、添加 `autoComplete="off"`、在小屏幕上禁用聚焦边框
- Web：处理部分模型先输出文本再输出思考过程的情况，确保思考消息始终显示在文本消息之前
- Web：在会话连接过程中显示更具体的状态信息（"Loading history..."、"Starting environment..." 替代通用的 "Connecting..."）
- Web：会话环境初始化失败时发送错误状态，而非让 UI 一直处于等待状态
- Web：历史回放完成后 15 秒内未收到会话状态时自动重连
- Web：会话流中使用非阻塞文件 I/O，避免历史回放期间阻塞事件循环

## 1.9.0 (2026-02-06)

- Config：添加 `default_yolo` 配置项，支持默认开启 YOLO（自动审批）模式
- Config：支持 `max_steps_per_turn` 和 `max_steps_per_run` 作为循环控制设置的别名
- Wire：新增 `replay` 请求，用于回放已记录的 Wire 事件（协议版本 1.3）
- Web：添加会话分支(fork)功能，可以从任意 Assistant 回复处创建新的分支会话
- Web：添加会话归档功能，自动归档超过 15 天的会话
- Web：添加多选模式，支持批量归档、取消归档和删除操作
- Web：添加工具结果的媒体预览（ReadMediaFile 的图片/视频），支持可点击缩略图
- Web：添加 Shell 命令和 Todo 列表的工具输出显示组件
- Web：添加活动状态指示器，显示 Agent 状态（处理中、等待审批等）
- Web：添加图片加载失败时的错误回退 UI
- Web：重新设计工具输入 UI，支持可展开参数和长值的语法高亮
- Web：上下文压缩时显示压缩指示器
- Web：改进聊天中的自动滚动行为，更流畅地跟随新内容
- Web：会话流开始时更新工作目录的最近会话 ID（`last_session_id`）
- Shell：移除 `Ctrl-/` 快捷键（此前用于触发 `/help` 命令）
- Rust：Rust 版实现迁移到 `MoonshotAI/kimi-agent-rs` 并独立发版；二进制更名为 `kimi-agent`
- Core：重新加载配置时保留会话 ID，确保会话正确恢复
- Shell：修复会话回放时显示已被 `/clear` 或 `/reset` 清除的消息的问题
- Web：修复会话中断或取消时审批请求状态未更新的问题
- Web：修复选择斜杠命令时的输入法组合问题
- Web：修复执行 `/clear`、`/reset` 或 `/compact` 命令后 UI 未清空消息的问题

## 1.8.0 (2026-02-05)

- CLI：修复启动错误（如无效的配置文件）被静默吞掉而不显示的问题

## 1.7.0 (2026-02-05)

- Rust：添加 `kagent`，Kimi Agent 内核的 Rust 实现，支持 Wire 模式（实验性）
- Auth：修复多个会话同时运行时的 OAuth 令牌刷新冲突
- Web：添加文件提及菜单（`@`），支持引用已上传附件和工作区文件，带自动补全功能
- Web：添加斜杠命令菜单，支持自动补全、键盘导航和别名匹配
- Web：修复认证令牌持久化问题，从 sessionStorage 切换到 localStorage 并设置 24 小时过期
- Web：创建会话时，若指定的路径不存在则提示创建目录
- Web：为会话列表添加服务端分页和虚拟滚动，提升性能
- Web：改进会话和工作目录加载，采用更智能的缓存和失效策略
- Web：修复历史记录回放时的 WebSocket 错误，发送前检查连接状态
- Web：Git diff 状态栏现在显示未跟踪文件（尚未添加到 git 的新文件）
- Web：仅在 public 模式下限制敏感 API；更新 origin 执行逻辑

## 1.6 (2026-02-03)

- Web：为网络模式添加基于 Token 的认证和访问控制（`--network`、`--lan-only`、`--public`）
- Web：添加安全选项：`--auth-token`、`--allowed-origins`、`--restrict-sensitive-apis`、`--dangerously-omit-auth`
- Web：变更 `--host` 选项，用于绑定到指定 IP 地址；添加自动网络地址检测
- Web：修复创建新会话时 WebSocket 断开连接的问题
- Web：将最大图片尺寸从 1024 提升至 4096 像素
- Web：通过增强的悬停效果和更好的布局处理改进 UI 响应性
- Wire：添加 `TurnEnd` 事件，用于标识 Agent 轮次的完成（协议版本 1.2）
- Core：修复包含 `$` 的自定义 Agent 提示词文件导致静默启动失败的问题

## 1.5 (2026-01-30)

- Web：添加 Git diff 状态栏，显示会话工作目录中的未提交更改
- Web：添加 "Open in" 菜单，用于在终端、VS Code、Cursor 或其他本地应用中打开文件/目录
- Web：添加会话搜索功能，支持按标题或工作目录过滤会话
- Web：改进会话标题显示，优化溢出处理

## 1.4 (2026-01-30)

- Shell：合并 `/login` 和 `/setup` 命令，`/setup` 现为 `/login` 的别名
- Shell：`/usage` 命令现在显示剩余配额百分比；添加 `/status` 别名
- Config：添加 `KIMI_SHARE_DIR` 环境变量，用于自定义共享目录路径（默认 `~/.kimi`）
- Web：新增 Web UI，支持基于浏览器的交互
- CLI：添加 `kimi web` 子命令以启动 Web UI 服务器
- Auth：修复设备名称或操作系统版本包含非 ASCII 字符时的编码错误
- Auth：OAuth 凭据现在存储在文件中而非 keyring；启动时自动迁移现有令牌
- Auth：修复系统休眠或睡眠后的授权失败问题

## 1.3 (2026-01-28)

- Auth：修复 Agent 轮次期间的认证问题
- Tool：为 `ReadMediaFile` 中的媒体内容添加描述性标签，提高路径可追溯性

## 1.2 (2026-01-27)

- UI：显示 `kimi-for-coding` 模型的说明

## 1.1 (2026-01-27)

- LLM：修复 `kimi-for-coding` 模型的能力

## 1.0 (2026-01-27)

- Shell：添加 `/login` 和 `/logout` 斜杠命令，用于登录和登出
- CLI：添加 `kimi login` 和 `kimi logout` 子命令
- Core：修复子 Agent 审批请求处理问题

## 0.88 (2026-01-26)

- MCP：移除连接 MCP 服务器时的 `Mcp-Session-Id` header 以修复兼容性问题

## 0.87 (2026-01-25)

- Shell：修复 HTML 块出现在元素外时的 Markdown 渲染错误
- Skills：添加更多用户级和项目级 Skills 目录候选
- Core：改进系统提示词中的媒体文件生成和处理任务指引
- Shell：修复 macOS 上从剪贴板粘贴图片的问题

## 0.86 (2026-01-24)

- Build：修复二进制构建问题

## 0.85 (2026-01-24)

- Shell：粘贴的图片缓存到磁盘，支持跨会话持久化
- Shell：基于内容哈希去重缓存的附件
- Shell：修复消息历史中图片/音频/视频附件的显示
- Tool：使用文件路径作为 `ReadMediaFile` 中的媒体标识符，提高可追溯性
- Tool：修复部分 MP4 文件无法识别为视频的问题
- Shell：执行斜杠命令时支持 Ctrl-C 中断
- Shell：修复 Shell 模式下输入不符合 Shell 语法的内容时的解析错误
- Shell：修复 MCP 服务器和第三方库的 stderr 输出污染 Shell UI 的问题
- Wire：优雅关闭，当连接关闭或收到 Ctrl-C 时正确清理待处理请求

## 0.84 (2026-01-22)

- Build：添加跨平台独立二进制构建，支持 Windows、macOS（含代码签名和公证）和 Linux（x86_64 和 ARM64）
- Shell：修复斜杠命令自动补全在输入完整命令/别名时仍显示建议的问题
- Tool：将 SVG 文件作为文本而非图片处理
- Flow：支持 D2 markdown 块字符串（`|md` 语法），用于 Flow Skill 中的多行节点标签
- Core：修复运行 `/reload`、`/setup` 或 `/clear` 后可能出现的 "event loop is closed" 错误
- Core：修复在续接会话中使用 `/clear` 时的崩溃问题

## 0.83 (2026-01-21)

- Tool：添加 `ReadMediaFile` 工具用于读取图片/视频文件；`ReadFile` 现在仅用于读取文本文件
- Skills：Flow Skills 现在也注册为 `/skill:<skill-name>` 命令（除了 `/flow:<skill-name>`）

## 0.82 (2026-01-21)

- Tool：`WriteFile` 和 `StrReplaceFile` 工具支持使用绝对路径编辑/写入工作目录外的文件
- Tool：使用 Kimi 供应商时，视频文件上传到 Kimi Files API，使用 `ms://` 引用替代 inline data URL
- Config：添加 `reserved_context_size` 配置项，自定义自动压缩触发阈值（默认 50000 tokens）

## 0.81 (2026-01-21)

- Skills：添加 Flow Skill 类型，在 SKILL.md 中内嵌 Agent Flow（Mermaid/D2），通过 `/flow:<skill-name>` 命令调用
- CLI：移除 `--prompt-flow` 选项，改用 Flow Skills
- Core：用 `/flow:<skill-name>` 命令替代原来的 `/begin` 命令

## 0.80 (2026-01-20)

- Wire：添加 `initialize` 方法，用于交换客户端/服务端信息、注册外部工具和公布斜杠命令
- Wire：支持通过 Wire 协议调用外部工具
- Wire：将 `ApprovalRequestResolved` 重命名为 `ApprovalResponse`（向后兼容）

## 0.79 (2026-01-19)

- Skills：添加项目级 Skills 支持，从 `.agents/skills/`（或 `.kimi/skills/`、`.claude/skills/`）发现
- Skills：统一 Skills 发现机制，采用分层加载（内置 → 用户 → 项目）；用户级 Skills 现在优先使用 `~/.config/agents/skills/`
- Shell：斜杠命令自动补全支持模糊匹配
- Shell：增强审批请求预览，显示 Shell 命令和 Diff 内容，使用 `Ctrl-E` 展开完整内容
- Wire：添加 `ShellDisplayBlock` 类型，用于在审批请求中显示 Shell 命令
- Shell：调整 `/help` 显示顺序，将键盘快捷键移至斜杠命令之前
- Wire：对无效请求返回符合 JSON-RPC 2.0 规范的错误响应

## 0.78 (2026-01-16)

- CLI：为 Prompt Flow 添加 D2 流程图格式支持（`.d2` 扩展名）

## 0.77 (2026-01-15)

- Shell：修复 `/help` 和 `/changelog` 全屏分页显示中的换行问题
- Shell：使用 `/model` 命令切换 Thinking 模式，取代 Tab 键
- Config：添加 `default_thinking` 配置项（升级后需运行 `/model` 选择 Thinking 模式）
- LLM：为始终使用 Thinking 模式的模型添加 `always_thinking` 能力
- CLI：将 `--command`/`-c` 重命名为 `--prompt`/`-p`，保留 `--command`/`-c` 作为别名，移除 `--query`/`-q`
- Wire：修复 Wire 模式下审批请求无法正常响应的问题
- CLI：添加 `--prompt-flow` 选项，加载 Mermaid 流程图文件作为 Prompt Flow
- Core：加载 Prompt Flow 后添加 `/begin` 斜杠命令以启动流程
- Core：使用基于 Prompt Flow 的实现替换旧的 Ralph 循环

## 0.76 (2026-01-12)

- Tool：让 `ReadFile` 工具描述根据模型能力动态反映图片/视频支持情况
- Tool：修复 TypeScript 文件（`.ts`、`.tsx`、`.mts`、`.cts`）被误识别为视频文件的问题
- Shell：允许在 Shell 模式下使用部分斜杠命令（`/help`、`/exit`、`/version`、`/changelog`、`/feedback`）
- Shell：改进 `/help` 显示，使用全屏分页器，展示斜杠命令、Skills 和键盘快捷键
- Shell：改进 `/changelog` 和 `/mcp` 显示，采用一致的项目符号格式
- Shell：在底部状态栏显示当前模型名称
- Shell：添加 `Ctrl-/` 快捷键显示帮助

## 0.75 (2026-01-09)

- Tool：改进 `ReadFile` 工具描述
- Skills：添加内置 `kimi-cli-help` Skill，解答 Kimi Code CLI 使用和配置问题

## 0.74 (2026-01-09)

- ACP：允许 ACP 客户端选择和切换模型（包含 Thinking 变体）
- ACP：添加 `terminal-auth` 认证方式，用于配置流程
- CLI：弃用 `--acp` 选项，请使用 `kimi acp` 子命令
- Tool：`ReadFile` 工具现支持读取图片和视频文件

## 0.73 (2026-01-09)

- Skills：添加随软件包发布的内置 skill-creator Skill
- Tool：在 `ReadFile` 路径中将 `~` 展开为用户主目录
- MCP：确保 MCP 工具加载完成后再开始 Agent 循环
- Wire：修复 Wire 模式无法接受有效 `cancel` 请求的问题
- Setup：`/model` 命令现在可以切换所选供应商的所有可用模型
- Lib：从 `kimi_cli.wire.types` 重新导出所有 Wire 消息类型，作为 `kimi_cli.wire.message` 的替代
- Loop：添加 `max_ralph_iterations` 循环控制配置，限制额外的 Ralph 迭代次数
- Config：将循环控制配置中的 `max_steps_per_run` 重命名为 `max_steps_per_turn`（向后兼容）
- CLI：添加 `--max-steps-per-turn`、`--max-retries-per-step` 和 `--max-ralph-iterations` 选项，覆盖循环控制配置
- SlashCmd：`/yolo` 命令现在切换 YOLO 模式
- UI：在 Shell 模式的提示符中显示 YOLO 标识

## 0.72 (2026-01-04)

- Python：修复在 Python 3.14 上的安装问题

## 0.71 (2026-01-04)

- ACP：通过 ACP 客户端路由文件读写和 Shell 命令，实现同步编辑/输出
- Shell：添加 `/model` 斜杠命令，在使用默认配置时切换默认模型并重新加载
- Skills：添加 `/skill:<name>` 斜杠命令，按需加载 `SKILL.md` 指引
- CLI：添加 `kimi info` 子命令，显示版本和协议信息（支持 `--json`）
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
- Lib：使 Kimi Code CLI 详细异常类扩展 `ValueError` 或 `RuntimeError`
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
- MetaCmd：添加 `/usage` 元命令，为 Kimi Code 用户显示 API 使用情况

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
- Tool：Kimi Code 方案在 `FetchURL` 工具中使用 MoonshotFetch 服务
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
