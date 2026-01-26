# Using in IDEs

Kimi Code CLI supports integration with IDEs through the [Agent Client Protocol (ACP)](https://agentclientprotocol.com/), allowing you to use AI-assisted programming directly within your editor.

## Prerequisites

Before configuring your IDE, make sure you have installed Kimi Code CLI and completed the `/setup` configuration.

## Using in Zed

[Zed](https://zed.dev/) is a modern IDE that supports ACP.

Add the following to Zed's configuration file `~/.config/zed/settings.json`:

```json
{
  "agent_servers": {
    "Kimi Code CLI": {
      "type": "custom",
      "command": "kimi",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

Configuration notes:

- `type`: Fixed value `"custom"`
- `command`: Path to the Kimi Code CLI command. If `kimi` is not in PATH, use the full path
- `args`: Startup arguments. `acp` enables ACP mode
- `env`: Environment variables, usually left empty

After saving the configuration, you can create Kimi Code CLI sessions in Zed's Agent panel.

## Using in JetBrains IDEs

JetBrains IDEs (IntelliJ IDEA, PyCharm, WebStorm, etc.) support ACP through the AI Chat plugin.

If you don't have a JetBrains AI subscription, you can enable `llm.enable.mock.response` in the Registry to use the AI Chat feature. Press Shift twice to search for "Registry" to open it.

In the AI Chat panel menu, click "Configure ACP agents" and add the following configuration:

```json
{
  "agent_servers": {
    "Kimi Code CLI": {
      "command": "~/.local/bin/kimi",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

`command` needs to be the full path. You can run `which kimi` in the terminal to get it. After saving, you can select Kimi Code CLI in the AI Chat Agent selector.
