# 在 IDE 中使用

Kimi CLI 支持通过 [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) 集成到 IDE 中，让你在编辑器内直接使用 AI 辅助编程。

## 前置准备

在配置 IDE 之前，请确保已安装 Kimi CLI 并完成 `/setup` 配置。

## 在 Zed 中使用

[Zed](https://zed.dev/) 是一个支持 ACP 的现代 IDE。

在 Zed 的配置文件 `~/.config/zed/settings.json` 中添加：

```json
{
  "agent_servers": {
    "Kimi CLI": {
      "type": "custom",
      "command": "kimi",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

配置说明：

- `type`：固定值 `"custom"`
- `command`：Kimi CLI 的命令路径，如果 `kimi` 不在 PATH 中，需要使用完整路径
- `args`：启动参数，`acp` 启用 ACP 模式
- `env`：环境变量，通常留空即可

保存配置后，在 Zed 的 Agent 面板中就可以创建 Kimi CLI 会话了。

## 在 JetBrains IDE 中使用

JetBrains 系列 IDE（IntelliJ IDEA、PyCharm、WebStorm 等）通过 AI 聊天插件支持 ACP。

如果你没有 JetBrains AI 订阅，可以在注册表中启用 `llm.enable.mock.response` 来使用 AI 聊天功能。连按两次 Shift 搜索 "注册表" 即可打开。

在 AI 聊天面板的菜单中点击 "Configure ACP agents"，添加以下配置：

```json
{
  "agent_servers": {
    "Kimi CLI": {
      "command": "~/.local/bin/kimi",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

`command` 需要使用完整路径，可以在终端中运行 `which kimi` 获取。保存后，在 AI 聊天的 Agent 选择器中就可以选择 Kimi CLI 了。
