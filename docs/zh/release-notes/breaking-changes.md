# 破坏性变更与迁移说明

本页面记录 Kimi CLI 各版本中的破坏性变更及对应的迁移指引。

## 未发布

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
- **迁移**：Kimi CLI 会自动读取旧的 JSON 配置，但建议手动迁移到 TOML 格式
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
