# `kimi acp` Command

The `kimi acp` command starts a multi-session ACP (Agent Client Protocol) server.

```sh
kimi acp
```

## Description

ACP is a standardized protocol that allows IDEs and other clients to interact with AI agents. Unlike `kimi --acp`, `kimi acp` starts a multi-session server that can handle multiple independent sessions simultaneously.

::: warning Note
The multi-session ACP server is currently experimental and not widely supported by ACP clients. For most scenarios, using `kimi --acp` to start a single-session server is recommended.
:::

## Use cases

- IDE plugin integration (e.g., JetBrains, Zed)
- Custom ACP client development
- Multi-session concurrent processing

## Differences from `kimi --acp`

| Feature | `kimi --acp` | `kimi acp` |
|---------|--------------|------------|
| Session mode | Single session | Multi-session |
| Compatibility | Widely supported | Experimental |
| Use case | IDE integration | Advanced use cases |

For using Kimi CLI in IDEs, see [Using in IDEs](/en/guides/ides).
