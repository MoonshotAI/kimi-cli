# `kimi acp` 子命令

`kimi acp` 命令启动一个支持多会话的 ACP (Agent Client Protocol) 服务器。

```sh
kimi acp
```

## 说明

ACP 是一种标准化协议，允许 IDE 和其他客户端与 AI Agent 进行交互。

## 使用场景

- IDE 插件集成（如 JetBrains、Zed）
- 自定义 ACP 客户端开发
- 多会话并发处理

如需在 IDE 中使用 Kimi Code CLI，请参阅 [在 IDE 中使用](../guides/ides.md)。

## 认证

ACP 服务器在创建或加载会话前会检查用户认证状态。如果未登录，服务器会返回 `AUTH_REQUIRED` 错误（错误码 `-32000`），并携带可用的认证方式信息。

客户端收到此错误后，应引导用户在终端中执行 `kimi login` 命令完成登录。登录成功后，后续的 ACP 请求即可正常执行。
