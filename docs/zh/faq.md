# 常见问题

## 安装与鉴权

### `/setup` 时模型列表为空

如果在运行 `/setup` 命令时看到 "No models available for the selected platform" 错误，可能是以下原因：

- **API 密钥无效或过期**：检查你输入的 API 密钥是否正确，以及是否仍有效。
- **网络连接问题**：确认能正常访问 API 服务地址（如 `api.kimi.com` 或 `api.moonshot.cn`）。

### API 密钥无效

API 密钥无效可能的原因：

- **密钥输入错误**：检查是否有多余的空格或遗漏的字符。
- **密钥已过期或被撤销**：在平台控制台确认密钥状态。
- **环境变量覆盖**：检查是否有 `KIMI_API_KEY` 或 `OPENAI_API_KEY` 环境变量覆盖了配置文件中的密钥。可以运行 `echo $KIMI_API_KEY` 检查。

### 会员过期或配额用尽

如果你使用 Kimi Code 平台，可以通过 `/usage` 命令查看当前的配额和会员状态。如果配额用尽或会员过期，需要在 [Kimi Code](https://kimi.com/coding) 续费或升级。

## 交互问题

### Shell 模式中 `cd` 命令无效

在 Shell 模式中执行 `cd` 命令不会改变 Kimi CLI 的工作目录。这是因为每次 Shell 命令在独立的子进程中执行，目录切换只在该进程内生效。

如果需要切换工作目录：

- **退出并重新启动**：在目标目录中重新运行 `kimi` 命令。
- **使用 `--work-dir` 参数**：启动时指定工作目录，如 `kimi --work-dir /path/to/project`。
- **在命令中使用绝对路径**：直接使用绝对路径执行命令，如 `ls /path/to/dir`。

### 粘贴图片失败

使用 `Ctrl-V` 粘贴图片时，如果提示 "Current model does not support image input"，说明当前模型不支持图片输入。

解决方法：

- **切换到支持图片的模型**：使用支持 `image_in` 能力的模型。
- **检查剪贴板内容**：确保剪贴板中确实有图片数据，而非图片文件的路径。

## ACP 问题

### IDE 无法连接到 Kimi CLI

如果 IDE（如 Zed 或 JetBrains IDE）无法连接到 Kimi CLI，请检查以下几点：

- **确认 Kimi CLI 已安装**：运行 `kimi --version` 确认安装成功。
- **检查配置路径**：确保 IDE 配置中的 Kimi CLI 路径正确。通常可以使用 `kimi acp` 作为命令。
- **检查 uv 路径**：如果使用 uv 安装，确保 `~/.local/bin` 在 PATH 中。可以使用绝对路径，如 `/Users/yourname/.local/bin/kimi acp`。
- **查看日志**：检查 `~/.kimi/logs/kimi.log` 中的错误信息。

## MCP 问题

### MCP 服务启动失败

添加 MCP 服务器后，如果工具未加载或报错，可能是以下原因：

- **命令不存在**：对于 stdio 类型的服务器，确保命令（如 `npx`）在 PATH 中。可以使用绝对路径配置。
- **配置格式错误**：检查 `~/.kimi/mcp.json` 是否为有效的 JSON 格式。运行 `kimi mcp list` 查看当前配置。

调试步骤：

```sh
# 查看已配置的服务器
kimi mcp list

# 测试服务器是否正常
kimi mcp test <server-name>
```

### OAuth 授权失败

对于需要 OAuth 授权的 MCP 服务器（如 Linear），如果授权失败：

- **检查网络连接**：确保能访问授权服务器。
- **重新授权**：运行 `kimi mcp auth <server-name>` 重新进行授权。
- **重置授权**：如果授权信息损坏，可以运行 `kimi mcp reset-auth <server-name>` 清除后重试。

### Header 格式错误

添加 HTTP 类型的 MCP 服务器时，Header 格式应为 `KEY: VALUE`（冒号后有空格）。例如：

```sh
# 正确
kimi mcp add --transport http context7 https://mcp.context7.com/mcp --header "CONTEXT7_API_KEY: your-key"

# 错误（缺少空格或使用等号）
kimi mcp add --transport http context7 https://mcp.context7.com/mcp --header "CONTEXT7_API_KEY=your-key"
```

## Print/Wire 模式问题

### JSONL 输入格式无效

使用 `--input-format stream-json` 时，输入必须是有效的 JSONL（每行一个 JSON 对象）。常见问题：

- **JSON 格式错误**：确保每行是完整的 JSON 对象，没有语法错误。
- **编码问题**：确保输入使用 UTF-8 编码。
- **换行符问题**：Windows 用户注意检查换行符是否为 `\n` 而非 `\r\n`。

正确的输入格式示例：

```json
{"role": "user", "content": "你好"}
```

### Print 模式无输出

如果 `--print` 模式下没有输出，可能是：

- **未提供输入**：需要通过 `--prompt`（或 `--command`）或 stdin 提供输入。例如：`kimi --print --prompt "你好"`。
- **输出被缓冲**：尝试使用 `--output-format stream-json` 获取流式输出。
- **配置未完成**：确保已通过 `/setup` 配置 API 密钥和模型。

## 更新与升级

### macOS 首次运行缓慢

macOS 的 Gatekeeper 安全机制会在首次运行新程序时进行检查，导致启动变慢。解决方法：

- **等待检查完成**：首次运行时耐心等待，后续启动会恢复正常。
- **添加到开发者工具**：在「系统设置 → 隐私与安全性 → 开发者工具」中添加你的终端应用。

### 如何升级 Kimi CLI

使用 uv 升级到最新版本：

```sh
uv tool upgrade kimi-cli --no-cache
```

添加 `--no-cache` 参数可以确保获取最新版本。

### 如何禁用自动更新检查

如果不希望 Kimi CLI 在后台检查更新，可以设置环境变量：

```sh
export KIMI_CLI_NO_AUTO_UPDATE=1
```

可以将此行添加到你的 shell 配置文件（如 `~/.zshrc` 或 `~/.bashrc`）中。
