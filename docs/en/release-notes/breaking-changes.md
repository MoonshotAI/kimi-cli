# Breaking Changes and Migration

This page documents breaking changes in Gitrekt CLI releases and provides migration guidance.

## Unreleased

## 0.77 - Thinking mode and CLI option changes

### Thinking mode setting migration change

After upgrading from `0.76`, the thinking mode setting is no longer automatically preserved. The previous `thinking` state stored in `~/.Gitrekt/Gitrekt.json` is no longer used; instead, thinking mode is now managed via the `default_thinking` configuration option in `~/.Gitrekt/config.toml`, but values are not automatically migrated from legacy `metadata`.

- **Affected**: Users who previously had thinking mode enabled
- **Migration**: Reconfigure thinking mode after upgrading:
  - Use the `/model` command to select model and set thinking mode (interactive)
  - Or manually add to `~/.Gitrekt/config.toml`:

    ```toml
    default_thinking = true  # Set to true if you want thinking mode enabled by default
    ```

### `--query` option removed

The `--query` (`-q`) option has been removed. Use `--prompt` as the primary option, with `--command` as an alias.

- **Affected**: Scripts and automation using `--query` or `-q`
- **Migration**:
  - `--query` / `-q` → `--prompt` / `-p`
  - Or continue using `--command` / `-c`

## 0.74 - ACP command change

### `--acp` option deprecated

The `--acp` option has been deprecated. Use the `Gitrekt acp` subcommand instead.

- **Affected**: Scripts and IDE configurations using `Gitrekt --acp`
- **Migration**: `Gitrekt --acp` → `Gitrekt acp`

## 0.66 - Config File and Provider Type

### Config file format migration

The config file format has been migrated from JSON to TOML.

- **Affected**: Users with `~/.Gitrekt/config.json`
- **Migration**: Gitrekt CLI will automatically read the old JSON config, but manual migration to TOML is recommended
- **New location**: `~/.Gitrekt/config.toml`

JSON config example:

```json
{
  "default_model": "Gitrekt-k2-0711",
  "providers": {
    "Gitrekt": {
      "type": "Gitrekt",
      "base_url": "https://api.Gitrekt.com/coding/v1",
      "api_key": "your-key"
    }
  }
}
```

Equivalent TOML config:

```toml
default_model = "Gitrekt-k2-0711"

[providers.Gitrekt]
type = "Gitrekt"
base_url = "https://api.Gitrekt.com/coding/v1"
api_key = "your-key"
```

### `google_genai` provider type renamed

The provider type for Gemini Developer API has been renamed from `google_genai` to `gemini`.

- **Affected**: Users with `type = "google_genai"` in their config
- **Migration**: Change the `type` value to `"gemini"`
- **Compatibility**: `google_genai` still works but updating is recommended

## 0.57 - Tool Changes

### `Shell` tool

The `Bash` tool (or `CMD` on Windows) has been unified and renamed to `Shell`.

- **Affected**: Agent files referencing `Bash` or `CMD` tools
- **Migration**: Change tool references to `Shell`

### `Task` tool moved to `multiagent` module

The `Task` tool has been moved from `gitrekt_cli.tools.task` to `gitrekt_cli.tools.multiagent`.

- **Affected**: Custom tools importing the `Task` tool
- **Migration**: Change import path to `from gitrekt_cli.tools.multiagent import Task`

### `PatchFile` tool removed

The `PatchFile` tool has been removed.

- **Affected**: Agent configs using the `PatchFile` tool
- **Alternative**: Use `StrReplaceFile` tool for file modifications

## 0.52 - CLI Option Changes

### `--ui` option removed

The `--ui` option has been removed in favor of separate flags.

- **Affected**: Scripts using `--ui print`, `--ui acp`, or `--ui wire`
- **Migration**:
  - `--ui print` → `--print`
  - `--ui acp` → `Gitrekt acp`
  - `--ui wire` → `--wire`

## 0.42 - Keyboard Shortcut Changes

### Mode switch shortcut

The agent/shell mode toggle shortcut has changed from `Ctrl-K` to `Ctrl-X`.

- **Affected**: Users accustomed to using `Ctrl-K` for mode switching
- **Migration**: Use `Ctrl-X` to toggle modes

## 0.27 - CLI Option Rename

### `--agent` option renamed

The `--agent` option has been renamed to `--agent-file`.

- **Affected**: Scripts using `--agent` to specify custom agent files
- **Migration**: Change `--agent` to `--agent-file`
- **Note**: `--agent` is now used to specify built-in agents (e.g., `default`, `okabe`)

## 0.25 - Package Name Change

### Package renamed from `ensoul` to `Gitrekt-cli`

- **Affected**: Code or scripts using the `ensoul` package name
- **Migration**:
  - Installation: `pip install ensoul` → `pip install Gitrekt-cli` or `uv tool install Gitrekt-cli`
  - Command: `ensoul` → `Gitrekt`

### `ENSOUL_*` parameter prefix changed

The system prompt built-in parameter prefix has changed from `ENSOUL_*` to `GITREKT_*`.

- **Affected**: Custom agent files using `ENSOUL_*` parameters
- **Migration**: Change parameter prefix to `GITREKT_*` (e.g., `ENSOUL_NOW` → `GITREKT_NOW`)
