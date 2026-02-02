# Breaking changes and migration guide

This page documents breaking changes and corresponding migration instructions for each version of Kimi Code CLI.

## Unreleased

## 0.81 - Prompt Flow replaced by Flow Skills

### `--prompt-flow` option removed

The `--prompt-flow` CLI option has been removed. Please use flow skills instead.

- **Affected**: Scripts and automation using `--prompt-flow` to load Mermaid/D2 flowcharts
- **Migration**: Create a flow skill with embedded agent flow (in `SKILL.md`) and invoke via `/flow:<skill-name>`

### `/begin` command replaced

The `/begin` slash command has been replaced by the `/flow:<skill-name>` command.

- **Affected**: Users using `/begin` to start loaded Prompt Flow
- **Migration**: Use `/flow:<skill-name>` to directly invoke flow skills

## 0.77 - Thinking mode and CLI option changes

### Thinking mode setting migration adjustment

After upgrading from `0.76`, Thinking mode settings are no longer automatically preserved. The `thinking` state previously saved in `~/.kimi/kimi.json` is no longer used. It is now managed by the `default_thinking` configuration option in `~/.kimi/config.toml`, but will not be automatically migrated from the old `metadata`.

- **Affected**: Users who previously enabled Thinking mode
- **Migration**: Reconfigure Thinking mode after upgrade:
  - Use the `/model` command to set Thinking mode when selecting a model (interactive)
  - Or manually add to `~/.kimi/config.toml`:

    ```toml
    default_thinking = true  # To enable Thinking mode by default
    ```

### `--query` option removed

`--query` (`-q`) has been removed. Use `--prompt` as the main parameter, with `--command` as an alias.

- **Affected**: Scripts and automation using `--query` or `-q`
- **Migration**:
  - `--query` / `-q` → `--prompt` / `-p`
  - Or continue using `--command` / `-c`

## 0.74 - ACP command changes

### `--acp` option deprecated

The `--acp` option is deprecated. Please use the `kimi acp` subcommand.

- **Affected**: Scripts and IDE configurations using `kimi --acp`
- **Migration**: `kimi --acp` → `kimi acp`

## 0.66 - Configuration file and provider types

### Configuration file format migration

Configuration file format migrated from JSON to TOML.

- **Affected**: Users using `~/.kimi/config.json`
- **Migration**: Kimi Code CLI can automatically read old JSON configs, but manual migration to TOML format is recommended
- **New location**: `~/.kimi/config.toml`

JSON configuration example:

```json
{
  "default_model": "kimi-k2-0711",
  "providers": {
    "kimi": {
      "type": "kimi",
      "base_url": "https://api.kimi.com/coding/v1",
      "api_key": "your-key"
    }
  }
}
```

Corresponding TOML configuration:

```toml
default_model = "kimi-k2-0711"

[providers.kimi]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
api_key = "your-key"
```

### `google_genai` provider type renamed

The provider type for Gemini Developer API has been renamed from `google_genai` to `gemini`.

- **Affected**: Users with `type = "google_genai"` in their configuration
- **Migration**: Change the `type` value to `"gemini"` in your configuration
- **Compatibility**: `google_genai` still works but updating is recommended

## 0.57 - Tool changes

### `Shell` tool

The `Bash` tool (or `CMD` on Windows) has been unified and renamed to `Shell`.

- **Affected**: Agent files referencing `Bash` or `CMD` tools
- **Migration**: Change tool references to `Shell`

### `Task` tool moved to `multiagent` module

The `Task` tool has been moved from `kimi_cli.tools.task` to `kimi_cli.tools.multiagent`.

- **Affected**: Code importing `Task` tool in custom tools
- **Migration**: Change import path to `from kimi_cli.tools.multiagent import Task`

### `PatchFile` tool removed

The `PatchFile` tool has been removed.

- **Affected**: Agent configurations using `PatchFile` tool
- **Alternative**: Use `StrReplaceFile` tool for file modifications

## 0.52 - CLI option changes

### `--ui` option removed

The `--ui` option has been removed in favor of standalone flags.

- **Affected**: Scripts using `--ui print`, `--ui acp`, `--ui wire`
- **Migration**:
  - `--ui print` → `--print`
  - `--ui acp` → `kimi acp`
  - `--ui wire` → `--wire`

## 0.42 - Keyboard shortcut changes

### Mode switching shortcuts

The agent/shell mode switching shortcut has been changed from `Ctrl-K` to `Ctrl-X`.

- **Affected**: Users accustomed to using `Ctrl-K` to switch modes
- **Migration**: Use `Ctrl-X` to switch modes

## 0.27 - CLI option renamed

### `--agent` option renamed

The `--agent` option has been renamed to `--agent-file`.

- **Affected**: Scripts using `--agent` to specify custom agent files
- **Migration**: Change `--agent` to `--agent-file`
- **Note**: `--agent` is now used for specifying built-in agents (e.g., `default`, `okabe`)

## 0.25 - Package name changes

### Package name changed from `ensoul` to `kimi-cli`

- **Affected**: Code or scripts using the `ensoul` package name
- **Migration**:
  - Installation: `pip install ensoul` → `pip install kimi-cli` or `uv tool install kimi-cli`
  - Command: `ensoul` → `kimi`

### `ENSOUL_*` parameter prefix changed

System prompt built-in parameter prefixes have been changed from `ENSOUL_*` to `KIMI_*`.

- **Affected**: Agent configurations using `ENSOUL_*` parameters in custom agent files
- **Migration**: Change parameter prefixes to `KIMI_*` (e.g., `ENSOUL_NOW` → `KIMI_NOW`)
