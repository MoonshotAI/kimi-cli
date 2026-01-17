# Model Context Protocol

[Model Context Protocol (MCP)](https://modelcontextprotocol.io/) 是一个开放协议，让 AI 模型可以安全地与外部工具和数据源交互。Gitrekt CLI 支持连接 MCP 服务器，扩展 AI 的能力。

## MCP 是什么

MCP 服务器提供「工具」给 AI 使用。例如，一个数据库 MCP 服务器可以提供查询工具，让 AI 能够执行 SQL 查询；一个浏览器 MCP 服务器可以让 AI 控制浏览器进行自动化操作。

Gitrekt CLI 内置了一些工具（文件读写、Shell 命令、网页抓取等），通过 MCP 你可以添加更多工具，比如：

- 访问特定 API 或数据库
- 控制浏览器或其他应用
- 与第三方服务集成（GitHub、Linear、Notion 等）

## MCP 服务器管理

使用 [`Gitrekt mcp`](../reference/Gitrekt-mcp.md) 命令管理 MCP 服务器。

**添加服务器**

添加 HTTP 服务器：

```sh
# 基本用法
Gitrekt mcp add --transport http context7 https://mcp.context7.com/mcp

# 带 Header
Gitrekt mcp add --transport http context7 https://mcp.context7.com/mcp \
  --header "CONTEXT7_API_KEY: your-key"

# 使用 OAuth 认证
Gitrekt mcp add --transport http --auth oauth linear https://mcp.linear.app/mcp
```

添加 stdio 服务器（本地进程）：

```sh
Gitrekt mcp add --transport stdio chrome-devtools -- npx chrome-devtools-mcp@latest
```

**列出服务器**

```sh
Gitrekt mcp list
```

在 Gitrekt CLI 运行时，也可以输入 `/mcp` 查看已连接的服务器和加载的工具。

**移除服务器**

```sh
Gitrekt mcp remove context7
```

**OAuth 授权**

对于使用 OAuth 的服务器，需要先完成授权：

```sh
Gitrekt mcp auth linear
```

这会打开浏览器完成 OAuth 流程。授权成功后，Gitrekt CLI 会保存 token 供后续使用。

**测试服务器**

```sh
Gitrekt mcp test context7
```

## MCP 配置文件

MCP 服务器配置存储在 `~/.Gitrekt/mcp.json`，格式与其他 MCP 客户端兼容：

```json
{
  "mcpServers": {
    "context7": {
      "url": "https://mcp.context7.com/mcp",
      "headers": {
        "CONTEXT7_API_KEY": "your-key"
      }
    },
    "chrome-devtools": {
      "command": "npx",
      "args": ["chrome-devtools-mcp@latest"],
      "env": {
        "SOME_VAR": "value"
      }
    }
  }
}
```

**临时加载配置**

使用 `--mcp-config-file` 参数可以加载其他位置的配置文件：

```sh
Gitrekt --mcp-config-file /path/to/mcp.json
```

使用 `--mcp-config` 参数可以直接传入 JSON 配置：

```sh
Gitrekt --mcp-config '{"mcpServers": {"test": {"url": "https://..."}}}'
```

## 安全性

MCP 工具可能会访问和操作外部系统，需要注意安全风险。

**审批机制**

Gitrekt CLI 对敏感操作（如文件修改、命令执行）会请求用户确认。MCP 工具也遵循同样的审批机制，所有 MCP 工具调用都会弹出确认提示。

**提示词注入风险**

MCP 工具返回的内容可能包含恶意指令，试图诱导 AI 执行危险操作。Gitrekt CLI 会对工具返回内容进行标记，帮助 AI 区分工具输出和用户指令，但你仍应：

- 只使用可信来源的 MCP 服务器
- 检查 AI 提议的操作是否合理
- 对于高风险操作保持手动审批

::: warning 注意
在 YOLO 模式下，MCP 工具的操作也会被自动批准。建议仅在完全信任 MCP 服务器的情况下使用 YOLO 模式。
:::
