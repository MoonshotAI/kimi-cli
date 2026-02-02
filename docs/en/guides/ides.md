# Using in IDEs

Kimi Code CLI supports integration into IDEs via the [Agent Client Protocol (ACP)](https://agentclientprotocol.com/), allowing you to use AI-assisted programming directly within your editor.

## Prerequisites

Before configuring your IDE, ensure that Kimi Code CLI is installed and you have completed the `/login` configuration.

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

Configuration details:

- `type`: Fixed value `"custom"`
- `command`: The command path for Kimi Code CLI; use the full path if `kimi` is not in PATH
- `args`: Startup arguments; `acp` enables ACP mode
- `env`: Environment variables; usually left empty

After saving the configuration, you can create Kimi Code CLI sessions in Zed's agent panel.

## Using in JetBrains IDEs

JetBrains IDEs (IntelliJ IDEA, PyCharm, WebStorm, etc.) support ACP through the AI chat plugin.

If you don't have a JetBrains AI subscription, you can enable `llm.enable.mock.response` in the registry to use the AI chat feature. Press Shift twice and search for "registry" to open it.

Click "Configure ACP agents" in the AI chat panel menu and add the following configuration:

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

`command` requires the full path; you can run `which kimi` in the terminal to get it. After saving, you can select Kimi Code CLI in the AI chat's agent selector.
