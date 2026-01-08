# 破坏性变更与迁移说明

本页面记录 Kimi CLI 各版本中的破坏性变更及对应的迁移指引。

## 未发布 - ACP 命令变更

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
