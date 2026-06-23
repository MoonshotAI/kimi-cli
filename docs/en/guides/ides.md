# Using in IDEs

Kimi Code CLI supports integration with IDEs through the [Agent Client Protocol (ACP)](https://agentclientprotocol.com/), allowing you to use AI-assisted programming directly within your editor.

## Prerequisites

Before configuring your IDE, make sure you have installed Kimi Code CLI and completed the `/login` configuration.

## Using in Zed

[Zed](https://zed.dev/) is a modern IDE that supports ACP. To use Kimi CLI within Zed, you can install it via the [ACP registry](https://agentclientprotocol.com/get-started/registry) in Zed by launching the command palette and typing `zed: acp registry`.

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
