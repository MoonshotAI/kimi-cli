# Plugins

The plugin system allows you to add custom tools to Kimi Code CLI, extending the AI's capabilities. Unlike MCP servers, plugins are lightweight local toolkits ideal for packaging project-specific scripts and utilities.

## What are plugins

A plugin is a directory containing a `plugin.json` file. Plugins can declare multiple "tools," where each tool is an executable command (Python, TypeScript, shell script, etc.) that the AI can invoke to perform specific tasks.

For example, you can create a plugin to:

- Wrap internal API call scripts
- Provide project-specific code generation tools
- Integrate with proprietary services or database queries

Difference between plugins and Agent Skills:

- **Skills**: Provide knowledge-based guidance through `SKILL.md`; the AI reads and follows the specifications
- **Plugins**: Declare executable tools through `plugin.json`; the AI can directly invoke tools to get results

## Installing plugins

Use the `kimi plugin` command to manage plugins.

**Install from a local directory**

```sh
kimi plugin install /path/to/my-plugin
```

**Install from a ZIP file**

```sh
kimi plugin install my-plugin.zip
```

**Install from a Git repository**

```sh
# Install the root plugin
kimi plugin install https://github.com/user/repo.git

# Install a plugin from a subdirectory (multi-plugin repo)
kimi plugin install https://github.com/user/repo.git/plugins/my-plugin

# Specify a branch
kimi plugin install https://github.com/user/repo.git/plugins/my-plugin/tree/develop
```

When a Git repository has no `plugin.json` at the root, Kimi Code CLI scans subdirectories and lists available plugins for you to choose from.

**List installed plugins**

```sh
kimi plugin list
```

**View plugin details**

```sh
kimi plugin info my-plugin
```

**Remove a plugin**

```sh
kimi plugin remove my-plugin
```

## Creating a plugin

Creating a plugin requires three steps:

1. Create a directory
2. Write a `plugin.json` file
3. Implement the tool scripts

**Directory structure**

```
my-plugin/
├── plugin.json       # Plugin configuration (required)
├── config.json       # Plugin config (optional, for credential injection)
└── scripts/          # Tool scripts
    ├── greet.py
    └── calc.ts
```

**`plugin.json` format**

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "My custom plugin for project X",
  "config_file": "config.json",
  "inject": {
    "api_key": "api_key",
    "endpoint": "base_url"
  },
  "tools": [
    {
      "name": "greet",
      "description": "Generate a greeting message",
      "command": ["python3", "scripts/greet.py"],
      "parameters": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string",
            "description": "Name to greet"
          }
        },
        "required": ["name"]
      }
    }
  ]
}
```

**Field descriptions**

| Field | Description | Required |
|-------|-------------|----------|
| `name` | Plugin name; lowercase letters, numbers, and hyphens only | Yes |
| `version` | Plugin version; semantic version format | Yes |
| `description` | Plugin description | No |
| `config_file` | Config file path for credential injection | No |
| `inject` | Credential injection mapping; key is target path, value is source variable name | No |
| `tools` | List of tools | No |

**Tool field descriptions**

| Field | Description | Required |
|-------|-------------|----------|
| `name` | Tool name | Yes |
| `description` | Tool description | Yes |
| `command` | Command to execute; array of strings | Yes |
| `parameters` | Parameter definition in JSON Schema format | No |

## Credential injection

If your plugin needs to call LLM APIs, you can use the `inject` configuration to automatically receive Kimi Code CLI's credentials.

**`inject` configuration example**

```json
{
  "config_file": "config.json",
  "inject": {
    "llm.api_key": "api_key",
    "llm.endpoint": "base_url"
  }
}
```

**Supported injection variables**

| Variable | Description |
|----------|-------------|
| `api_key` | LLM provider API key; supports OAuth tokens and static API keys |
| `base_url` | LLM API base URL |

**`config.json` template**

```json
{
  "llm": {
    "api_key": "",
    "endpoint": ""
  }
}
```

During installation, Kimi Code CLI injects the currently configured API key and base URL into the specified config file. If OAuth is configured, a valid token is automatically obtained and injected.

::: warning Note
Credential injection happens once during installation. If you later switch LLM providers or re-authorize, you need to reinstall the plugin to update credentials.
:::

## Tool script specification

Tool scripts receive parameters via standard input and return results via standard output.

**Input format**

Scripts receive a JSON object from `stdin`:

```json
{
  "name": "World"
}
```

**Output format**

Scripts output a JSON object to `stdout`:

```json
{
  "content": "Hello, World!"
}
```

**Python example**

```python
#!/usr/bin/env python3
import json
import sys

params = json.load(sys.stdin)
name = params.get("name", "Guest")

result = {"content": f"Hello, {name}!"}
print(json.dumps(result))
```

**TypeScript example**

```typescript
#!/usr/bin/env tsx
import * as readline from "readline";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

let input = "";
rl.on("line", (line) => {
  input += line;
});

rl.on("close", () => {
  const params = JSON.parse(input);
  const name = params.name || "Guest";
  console.log(JSON.stringify({ content: `Hello, ${name}!` }));
});
```

## Complete example

```json
{
  "name": "sample-plugin",
  "version": "1.0.0",
  "description": "Sample plugin demonstrating Skills + Tools",
  "tools": [
    {
      "name": "py_greet",
      "description": "Generate a greeting message (Python tool)",
      "command": ["python3", "scripts/greet.py"],
      "parameters": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string",
            "description": "Name to greet"
          },
          "lang": {
            "type": "string",
            "enum": ["en", "zh", "ja"],
            "description": "Language"
          }
        },
        "required": ["name"]
      }
    },
    {
      "name": "ts_calc",
      "description": "Evaluate a math expression (TypeScript tool)",
      "command": ["npx", "tsx", "scripts/calc.ts"],
      "parameters": {
        "type": "object",
        "properties": {
          "expression": {
            "type": "string",
            "description": "Math expression to evaluate"
          }
        },
        "required": ["expression"]
      }
    }
  ]
}
```

## Plugin installation location

Plugins are installed in the `~/.kimi/plugins/` directory. Each plugin is an independent subdirectory containing the complete `plugin.json` and script files.

::: info Note
Plugins and MCP servers are complementary extension mechanisms:

- **MCP**: Suitable for services that need to run continuously, complex tool orchestration, or cross-process communication
- **Plugins**: Suitable for simple script wrappers, project-specific tools, or rapid prototyping
:::
