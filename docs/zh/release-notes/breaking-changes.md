# 破坏性变更与迁移说明

本页面记录 Kimi Code CLI 各版本中的破坏性变更及对应的迁移指引。

## 未发布

### Windows Shell 后端从 PowerShell 切换为 Git Bash

Windows 上的 Shell 工具现在通过 `bash.exe`（POSIX 语义）执行命令，不再使用 `powershell.exe`。Windows 用户获得与 Linux/macOS 一致的 Unix 风格命令语法，但需要先安装 Git for Windows。

- **受影响**：所有 Windows 用户；依赖 PowerShell 专属语法（`Get-ChildItem`、`Where-Object`、`cmdlet -Foo Bar` 参数风格、仅 `;` 链式命令、`NUL` 重定向等）经由 Shell 工具执行的集成、agent 规格或保存的代码片段
- **迁移**：
  1. 如果尚未安装，先安装 [Git for Windows](https://git-scm.com/downloads/win)；其自带的 `bash.exe`（通常位于 `C:\Program Files\Git\bin\bash.exe`）会通过 `where.exe git` 或标准安装位置自动发现
  2. 如果 `bash.exe` 在非标准位置，启动 kimi-cli 前把 `KIMI_CLI_GIT_BASH_PATH` 环境变量设为它的绝对路径
  3. 把任何硬编码 PowerShell 语法的自定义提示词、agent 规格或代码片段改为 Unix shell 语法（Shell 命令内用正斜杠路径，`/dev/null` 代替 `NUL`，控制流用 `&&` 和 `||`，文本工具用 `grep`/`sed`/`awk` 而非 PowerShell cmdlet）
  4. 注意：从 bash 中调用 `python.exe`、`node.exe` 等原生 Windows 程序时仍需要传入原生 Windows 路径（例如 `python C:\path\to\script.py`）；只有 POSIX-aware 工具（cat、ls、grep 等）才能识别 `/c/path/...` 形式
  5. 如果 kimi-cli 找不到 `bash.exe`，现在会在启动时打印安装提示并退出，而不是回退到 PowerShell

## 1.40.0

### `--print` 现在使用 runtime AFK 语义而不是 YOLO 语义

Print 模式仍然是非交互运行，并且会自动处理审批，但现在设置的是仅本次调用生效的 AFK 覆盖，而不是启用 YOLO。也就是说，`--print` 会把用户视为不在场并自动 dismiss `AskUserQuestion`，但之后以交互方式恢复同一会话时，不会仅仅因为之前运行过 Print 模式而继承 AFK。

- **受影响**：通过显式 YOLO 标志推断 Print 模式行为的脚本、包装器或自定义集成
- **迁移**：把 `--print` / `--quiet` 视为非交互 AFK 运行。只有在用户仍可回应、但希望绕过权限审批时才使用 `--yolo`

### `skip_yolo_prompt_injection` 替换为 `skip_afk_prompt_injection`

YOLO 不再注入模型指导，因此旧的 `skip_yolo_prompt_injection` 配置键会被忽略。剩余的非交互提示属于 AFK 模式，可以通过 `skip_afk_prompt_injection` 关闭。

- **受影响**：设置了 `skip_yolo_prompt_injection` 的配置文件或嵌入式应用
- **迁移**：如果需要抑制 AFK 模式提示，请把 `skip_yolo_prompt_injection = true` 替换为 `skip_afk_prompt_injection = true`

## 1.39.0

### `merge_all_available_skills` 默认值翻转为 `true`

`merge_all_available_skills` 配置项的默认值从 `false` 改为 `true`。kimi-cli 现在默认会合并用户级和项目级所有已存在的品牌 Skills 目录（`.kimi/skills`、`.claude/skills`、`.codex/skills`），而不是仅使用找到的第一个。升级后，同时维护多个品牌目录（例如同时保留 `~/.kimi/skills` 和 `~/.claude/skills`）的用户会开箱即看到全部 Skills。

- **受影响**：同时维护多个品牌 Skills 目录，并依赖旧的"仅取第一个"行为来隐藏重复项的用户
- **迁移**：在配置中显式设置 `merge_all_available_skills = false` 可恢复旧的仅匹配第一个目录的行为

## 1.25.0

### Wire 协议 1.6——子 Agent 与审批字段变更

`SubagentEvent` 的 `task_tool_call_id` 字段重命名为 `parent_tool_call_id`，新增可选字段 `agent_id`、`subagent_type`。`ApprovalRequest` 新增 `source_kind`、`source_id`、`agent_id`、`subagent_type`、`source_description` 字段。`ApprovalResponse` 新增 `feedback` 字段。

- **受影响**：解析 `SubagentEvent` 或 `ApprovalRequest`/`ApprovalResponse` 载荷的 Wire 模式客户端
- **迁移**：在事件处理器中将 `task_tool_call_id` 重命名为 `parent_tool_call_id`；根据需要处理新增的可选字段

### `CreateSubagent` 和 `Task`（multiagent）工具移除

`kimi_cli.tools.multiagent` 下的 `CreateSubagent` 和 `Task` 工具已移除，由新的 `Agent` 工具替代。

- **受影响**：在 Agent YAML 中引用 `kimi_cli.tools.multiagent:Task` 或 `kimi_cli.tools.multiagent:CreateSubagent` 的自定义 Agent 配置
- **迁移**：在 Agent YAML 的 `allowed_tools` 中替换为 `kimi_cli.tools.agent:Agent`

### `TaskOutput` `block` 参数默认值变更

`TaskOutput` 工具的 `block` 参数默认值从 `true` 改为 `false`。`TaskOutput` 现在默认返回非阻塞的状态/输出快照。

- **受影响**：依赖 `TaskOutput` 默认阻塞行为的自定义 Agent 或 Wire 模式客户端
- **迁移**：如需等待任务完成，显式传入 `block=true`

## 0.81 - Prompt Flow 被 Flow Skills 取代

### `--prompt-flow` 选项移除

`--prompt-flow` CLI 选项已移除，请改用 flow skills。

- **受影响**：使用 `--prompt-flow` 加载 Mermaid/D2 流程图的脚本和自动化
- **迁移**：创建包含嵌入式 Agent Flow 的 flow skill（在 `SKILL.md` 中），并通过 `/flow:<skill-name>` 调用

### `/begin` 命令被替换

`/begin` 斜杠命令已被 `/flow:<skill-name>` 命令替换。

- **受影响**：使用 `/begin` 启动已加载 Prompt Flow 的用户
- **迁移**：使用 `/flow:<skill-name>` 直接调用 flow skills

## 0.77 - Thinking 模式与 CLI 选项变更

### Thinking 模式设置迁移调整

从 `0.76` 升级后，Thinking 模式设置不再自动保留。此前保存在 `~/.kimi/kimi.json` 中的 `thinking` 状态不再使用，改为通过 `~/.kimi/config.toml` 中的 `default_thinking` 配置项管理，但不会自动从旧版 `metadata` 迁移。

- **受影响**：此前启用 Thinking 模式的用户
- **迁移**：升级后需重新设置 Thinking 模式：
  - 使用 `/model` 命令选择模型时设置 Thinking 模式（交互式）
  - 或手动在 `~/.kimi/config.toml` 中添加：

    ```toml
    default_thinking = true  # 如需默认启用 Thinking 模式
    ```

### `--query` 选项移除

`--query`（`-q`）已移除，改用 `--prompt` 作为主推参数，`--command` 作为别名。

- **受影响**：使用 `--query` 或 `-q` 的脚本与自动化
- **迁移**：
  - `--query` / `-q` → `--prompt` / `-p`
  - 或继续使用 `--command` / `-c`

## 0.74 - ACP 命令变更

### `--acp` 选项弃用

`--acp` 选项已弃用，请使用 `kimi acp` 子命令。

- **受影响**：使用 `kimi --acp` 的脚本和 IDE 配置
- **迁移**：`kimi --acp` → `kimi acp`

## 0.66 - 配置文件与供应商类型

### 配置文件格式迁移

配置文件格式从 JSON 迁移至 TOML。

- **受影响**：使用 `~/.kimi/config.json` 的用户
- **迁移**：Kimi Code CLI 会自动读取旧的 JSON 配置，但建议手动迁移到 TOML 格式
- **新位置**：`~/.kimi/config.toml`

JSON 配置示例：

```json
{
  "default_model": "kimi-k2-0711",
  "providers": {
    "kimi": {
      "type": "kimi",
      "base_url": "https://api.kimi.com/coding/v1",
      "api_key": "your-key"
    }
  }
}
```

对应的 TOML 配置：

```toml
default_model = "kimi-k2-0711"

[providers.kimi]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
api_key = "your-key"
```

### `google_genai` 供应商类型重命名

Gemini Developer API 的供应商类型从 `google_genai` 重命名为 `gemini`。

- **受影响**：配置中使用 `type = "google_genai"` 的用户
- **迁移**：将配置中的 `type` 值改为 `"gemini"`
- **兼容性**：`google_genai` 仍可使用，但建议更新

## 0.57 - 工具变更

### `Shell` 工具

`Bash` 工具（Windows 上为 `CMD`）统一重命名为 `Shell`。

- **受影响**：Agent 文件中引用 `Bash` 或 `CMD` 工具的配置
- **迁移**：将工具引用改为 `Shell`

### `Task` 工具移至 `multiagent` 模块

`Task` 工具从 `kimi_cli.tools.task` 移至 `kimi_cli.tools.multiagent` 模块。

- **受影响**：自定义工具中导入 `Task` 工具的代码
- **迁移**：将导入路径改为 `from kimi_cli.tools.multiagent import Task`

### `PatchFile` 工具移除

`PatchFile` 工具已移除。

- **受影响**：使用 `PatchFile` 工具的 Agent 配置
- **替代**：使用 `StrReplaceFile` 工具进行文件修改

## 0.52 - CLI 选项变更

### `--ui` 选项移除

`--ui` 选项已移除，改用独立的标志位。

- **受影响**：使用 `--ui print`、`--ui acp`、`--ui wire` 的脚本
- **迁移**：
  - `--ui print` → `--print`
  - `--ui acp` → `kimi acp`
  - `--ui wire` → `--wire`

## 0.42 - 快捷键变更

### 模式切换快捷键

Agent/Shell 模式切换快捷键从 `Ctrl-K` 改为 `Ctrl-X`。

- **受影响**：习惯使用 `Ctrl-K` 切换模式的用户
- **迁移**：使用 `Ctrl-X` 切换模式

## 0.27 - CLI 选项重命名

### `--agent` 选项重命名

`--agent` 选项重命名为 `--agent-file`。

- **受影响**：使用 `--agent` 指定自定义 Agent 文件的脚本
- **迁移**：将 `--agent` 改为 `--agent-file`
- **注意**：`--agent` 现在用于指定内置 Agent（如 `default`、`okabe`）

## 0.25 - 包名变更

### 包名从 `ensoul` 改为 `kimi-cli`

- **受影响**：使用 `ensoul` 包名的代码或脚本
- **迁移**：
  - 安装：`pip install ensoul` → `pip install kimi-cli` 或 `uv tool install kimi-cli`
  - 命令：`ensoul` → `kimi`

### `ENSOUL_*` 参数前缀变更

系统提示词内置参数前缀从 `ENSOUL_*` 改为 `KIMI_*`。

- **受影响**：自定义 Agent 文件中使用 `ENSOUL_*` 参数的配置
- **迁移**：将参数前缀改为 `KIMI_*`（如 `ENSOUL_NOW` → `KIMI_NOW`）
