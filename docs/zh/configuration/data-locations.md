# 数据路径

Kimi CLI 将所有数据存储在用户主目录下的 `~/.kimi/` 目录中。本页介绍各类数据文件的位置和用途。

## 目录结构

```
~/.kimi/
├── config.toml           # 主配置文件
├── kimi.json             # 元数据
├── mcp.json              # MCP 服务器配置
├── sessions/             # 会话数据
│   └── <work-dir-hash>/
│       └── <session-id>/
│           ├── context.jsonl
│           └── wire.jsonl
├── user-history/         # 输入历史
│   └── <work-dir-hash>.jsonl
└── logs/                 # 日志
    └── kimi.log
```

## 配置与元数据

### `config.toml`

主配置文件，存储供应商、模型、服务和运行参数。详见 [配置文件](./config-files.md)。

可以通过 `--config-file` 参数指定其他位置的配置文件。

### `kimi.json`

元数据文件，存储 Kimi CLI 的运行状态，包括：

- `work_dirs`: 工作目录列表及其最后使用的会话 ID
- `thinking`: 上次会话是否启用 thinking 模式

此文件由 Kimi CLI 自动管理，通常不需要手动编辑。

### `mcp.json`

MCP 服务器配置文件，存储通过 `kimi mcp add` 命令添加的 MCP 服务器。详见 [MCP](../customization/mcp.md)。

示例结构：

```json
{
  "mcpServers": {
    "context7": {
      "url": "https://mcp.context7.com/mcp",
      "transport": "http",
      "headers": {
        "CONTEXT7_API_KEY": "ctx7sk-xxx"
      }
    }
  }
}
```

## 会话数据

会话数据按工作目录分组存储在 `~/.kimi/sessions/` 下。每个工作目录对应一个以路径 MD5 哈希命名的子目录，每个会话对应一个以会话 ID 命名的子目录。

### `context.jsonl`

上下文历史文件，以 JSONL 格式存储会话的消息历史。每行是一条消息（用户输入、模型回复、工具调用等）。

Kimi CLI 使用此文件在 `--continue` 或 `--session` 时恢复会话上下文。

### `wire.jsonl`

Wire 消息记录文件，以 JSONL 格式存储会话中的 Wire 事件。用于会话回放和提取会话标题。

## 输入历史

用户输入历史存储在 `~/.kimi/user-history/` 目录下。每个工作目录对应一个以路径 MD5 哈希命名的 `.jsonl` 文件。

输入历史用于 Shell 模式下的历史浏览（上下方向键）和搜索（Ctrl-R）。

## 日志

运行日志存储在 `~/.kimi/logs/kimi.log`。默认日志级别为 INFO，使用 `--debug` 参数可启用 TRACE 级别。

日志文件用于排查问题。如需报告 bug，请附上相关日志内容。

## 清理数据

删除 `~/.kimi/` 目录可以完全清理 Kimi CLI 的所有数据，包括配置、会话和历史。

如只需清理部分数据：

| 需求 | 操作 |
| --- | --- |
| 重置配置 | 删除 `~/.kimi/config.toml` |
| 清理所有会话 | 删除 `~/.kimi/sessions/` 目录 |
| 清理特定工作目录的会话 | 在 Shell 模式下使用 `/sessions` 查看并删除 |
| 清理输入历史 | 删除 `~/.kimi/user-history/` 目录 |
| 清理日志 | 删除 `~/.kimi/logs/` 目录 |
| 清理 MCP 配置 | 删除 `~/.kimi/mcp.json` 或使用 `kimi mcp remove` |

