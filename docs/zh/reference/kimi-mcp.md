# `kimi mcp` 子命令

`kimi mcp` 用于管理 MCP (Model Context Protocol) 服务器配置。关于 MCP 的概念和使用方式，详见 [Model Context Protocol](../customization/mcp.md)。

```sh
kimi mcp COMMAND [ARGS]
```

## `add`

添加 MCP 服务器配置。

```sh
kimi mcp add [OPTIONS] NAME [TARGET_OR_COMMAND...]
```

**参数**

| 参数 | 说明 |
|------|------|
| `NAME` | 服务器名称，用于标识和引用 |
| `TARGET_OR_COMMAND...` | `http` 模式为 URL；`stdio` 模式为命令（需以 `--` 开头） |

**选项**

| 选项 | 简写 | 说明 |
|------|------|------|
| `--transport TYPE` | `-t` | 传输类型：`stdio`（默认）或 `http` |
| `--env KEY=VALUE` | `-e` | 环境变量（仅 `stdio`），可多次指定 |
| `--header KEY:VALUE` | `-H` | HTTP Header（仅 `http`），可多次指定 |
| `--auth TYPE` | `-a` | 认证类型（如 `oauth`，仅 `http`） |

## `list`

列出所有已配置的 MCP 服务器。

```sh
kimi mcp list
```

输出包括：
- 配置文件路径
- 每个服务器的名称、传输类型和目标
- OAuth 服务器的授权状态

## `remove`

移除 MCP 服务器配置。

```sh
kimi mcp remove NAME
```

**参数**

| 参数 | 说明 |
|------|------|
| `NAME` | 要移除的服务器名称 |

## `auth`

对使用 OAuth 的 MCP 服务器进行授权。

```sh
kimi mcp auth NAME
```

执行后会打开浏览器进行 OAuth 授权流程。授权成功后，token 会被缓存以供后续使用。

**参数**

| 参数 | 说明 |
|------|------|
| `NAME` | 要授权的服务器名称 |

::: tip 提示
只有使用 `--auth oauth` 添加的服务器才需要执行此命令。
:::

## `reset-auth`

清除 MCP 服务器的 OAuth 缓存 token。

```sh
kimi mcp reset-auth NAME
```

**参数**

| 参数 | 说明 |
|------|------|
| `NAME` | 要重置授权的服务器名称 |

清除后需要重新执行 `kimi mcp auth` 进行授权。

## `test`

测试与 MCP 服务器的连接并列出可用工具。

```sh
kimi mcp test NAME
```

**参数**

| 参数 | 说明 |
|------|------|
| `NAME` | 要测试的服务器名称 |

输出包括：
- 连接状态
- 可用工具数量
- 工具名称和描述
