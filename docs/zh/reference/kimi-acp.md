# `kimi acp` 命令

`kimi acp` 命令启动一个支持多会话的 ACP (Agent Client Protocol) 服务器。

```sh
kimi acp
```

## 说明

ACP 是一种标准化协议，允许 IDE 和其他客户端与 AI Agent 进行交互。与 `kimi --acp` 不同，`kimi acp` 启动的是多会话服务器，可以同时处理多个独立的会话。

::: warning 注意
多会话 ACP 服务器目前处于实验阶段，尚未被 ACP 客户端广泛支持。大多数场景下建议使用 `kimi --acp` 启动单会话服务器。
:::

## 使用场景

- IDE 插件集成（如 JetBrains、Zed）
- 自定义 ACP 客户端开发
- 多会话并发处理

## 与 `kimi --acp` 的区别

| 特性 | `kimi --acp` | `kimi acp` |
|------|-------------|------------|
| 会话模式 | 单会话 | 多会话 |
| 兼容性 | 广泛支持 | 实验性 |
| 适用场景 | IDE 集成 | 高级用例 |

如需在 IDE 中使用 Kimi CLI，请参阅 [在 IDE 中使用](/zh/guides/ides)。
