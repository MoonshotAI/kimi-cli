# Breaking changes and migration

This page documents breaking changes in Kimi Code CLI releases and provides migration guidance.

## Unreleased

## 1.39.0

### `merge_all_available_skills` default flipped to `true`

The `merge_all_available_skills` config option default has changed from `false` to `true`. kimi-cli now merges all existing user- and project-level brand skill directories (`.kimi/skills`, `.claude/skills`, `.codex/skills`) by default instead of only using the first one found. Users who keep skills in multiple brand directories — for example both `~/.kimi/skills` and `~/.claude/skills` — will see every skill out of the box after upgrading.

- **Affected**: Users who maintain multiple brand skill directories and relied on the first-match behavior to hide duplicates
- **Migration**: Set `merge_all_available_skills = false` in your config to restore the previous first-match behavior

## 1.25.0

### Wire protocol 1.6 — subagent and approval field changes

The `SubagentEvent` field `task_tool_call_id` has been renamed to `parent_tool_call_id`, and new optional fields (`agent_id`, `subagent_type`) have been added. `ApprovalRequest` gains `source_kind`, `source_id`, `agent_id`, `subagent_type`, and `source_description` fields. `ApprovalResponse` gains a `feedback` field.

- **Affected**: Wire mode clients that parse `SubagentEvent` or `ApprovalRequest`/`ApprovalResponse` payloads
- **Migration**: Rename `task_tool_call_id` to `parent_tool_call_id` in your event handlers; handle the new optional fields as needed

### `CreateSubagent` and `Task` (multiagent) tools removed

The `CreateSubagent` and `Task` tools under `kimi_cli.tools.multiagent` have been removed. Use the new `Agent` tool instead.

- **Affected**: Custom agent configurations referencing `kimi_cli.tools.multiagent:Task` or `kimi_cli.tools.multiagent:CreateSubagent`
- **Migration**: Replace with `kimi_cli.tools.agent:Agent` in your agent YAML `allowed_tools`

### `TaskOutput` `block` parameter default changed

The `block` parameter of the `TaskOutput` tool now defaults to `false` (previously `true`). `TaskOutput` returns a non-blocking status/output snapshot by default.

- **Affected**: Custom agents or Wire mode clients relying on `TaskOutput` blocking by default
- **Migration**: Explicitly pass `block=true` if you need to wait for task completion

## 0.81 - Prompt Flow replaced by Flow Skills

### `--prompt-flow` option removed

The `--prompt-flow` CLI option has been removed. Use flow skills instead.

- **Affected**: Scripts and automation using `--prompt-flow` to load Mermaid/D2 flowcharts
- **Migration**: Create a flow skill with embedded Agent Flow in `SKILL.md` and invoke via `/flow:<skill-name>`

### `/begin` command replaced

The `/begin` slash command has been replaced with `/flow:<skill-name>` commands.

- **Affected**: Users who used `/begin` to start a loaded Prompt Flow
- **Migration**: Use `/flow:<skill-name>` to invoke flow skills directly

## 0.77 - Thinking mode and CLI option changes

### Thinking mode setting migration change

After upgrading from `0.76`, the thinking mode setting is no longer automatically preserved. The previous `thinking` state stored in `~/.kimi/kimi.json` is no longer used; instead, thinking mode is now managed via the `default_thinking` configuration option in `~/.kimi/config.toml`, but values are not automatically migrated from legacy `metadata`.

- **Affected**: Users who previously had thinking mode enabled
- **Migration**: Reconfigure thinking mode after upgrading:
  - Use the `/model` command to select model and set thinking mode (interactive)
  - Or manually add to `~/.kimi/config.toml`:

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

The `--acp` option has been deprecated. Use the `kimi acp` subcommand instead.

- **Affected**: Scripts and IDE configurations using `kimi --acp`
- **Migration**: `kimi --acp` → `kimi acp`

## 0.66 - Config file and provider type

### Config file format migration

The config file format has been migrated from JSON to TOML.

- **Affected**: Users with `~/.kimi/config.json`
- **Migration**: Kimi Code CLI will automatically read the old JSON config, but manual migration to TOML is recommended
- **New location**: `~/.kimi/config.toml`

JSON config example:

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

Equivalent TOML config:

```toml
default_model = "kimi-k2-0711"

[providers.kimi]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
api_key = "your-key"
```

### `google_genai` provider type renamed

The provider type for Gemini Developer API has been renamed from `google_genai` to `gemini`.

- **Affected**: Users with `type = "google_genai"` in their config
- **Migration**: Change the `type` value to `"gemini"`
- **Compatibility**: `google_genai` still works but updating is recommended

## 0.57 - Tool changes

### `Shell` tool

The `Bash` tool (or `CMD` on Windows) has been unified and renamed to `Shell`.

- **Affected**: Agent files referencing `Bash` or `CMD` tools
- **Migration**: Change tool references to `Shell`

### `Task` tool moved to `multiagent` module

The `Task` tool has been moved from `kimi_cli.tools.task` to `kimi_cli.tools.multiagent`.

- **Affected**: Custom tools importing the `Task` tool
- **Migration**: Change import path to `from kimi_cli.tools.multiagent import Task`

### `PatchFile` tool removed

The `PatchFile` tool has been removed.

- **Affected**: Agent configs using the `PatchFile` tool
- **Alternative**: Use `StrReplaceFile` tool for file modifications

## 0.52 - CLI option changes

### `--ui` option removed

The `--ui` option has been removed in favor of separate flags.

- **Affected**: Scripts using `--ui print`, `--ui acp`, or `--ui wire`
- **Migration**:
  - `--ui print` → `--print`
  - `--ui acp` → `kimi acp`
  - `--ui wire` → `--wire`

## 0.42 - Keyboard shortcut changes

### Mode switch shortcut

The agent/shell mode toggle shortcut has changed from `Ctrl-K` to `Ctrl-X`.

- **Affected**: Users accustomed to using `Ctrl-K` for mode switching
- **Migration**: Use `Ctrl-X` to toggle modes

## 0.27 - CLI option rename

### `--agent` option renamed

The `--agent` option has been renamed to `--agent-file`.

- **Affected**: Scripts using `--agent` to specify custom agent files
- **Migration**: Change `--agent` to `--agent-file`
- **Note**: `--agent` is now used to specify built-in agents (e.g., `default`, `okabe`)

## 0.25 - Package name change

### Package renamed from `ensoul` to `kimi-cli`

- **Affected**: Code or scripts using the `ensoul` package name
- **Migration**:
  - Installation: `pip install ensoul` → `pip install kimi-cli` or `uv tool install kimi-cli`
  - Command: `ensoul` → `kimi`

### `ENSOUL_*` parameter prefix changed

The system prompt built-in parameter prefix has changed from `ENSOUL_*` to `KIMI_*`.

- **Affected**: Custom agent files using `ENSOUL_*` parameters
- **Migration**: Change parameter prefix to `KIMI_*` (e.g., `ENSOUL_NOW` → `KIMI_NOW`)
