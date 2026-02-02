# Agents and subagents

Agents define how the AI behaves, including the system prompt, available tools, and subagents. You can use built-in agents or create custom agents.

## Built-in agents

Kimi Code CLI provides two built-in agents. You can select one at startup using the `--agent` parameter:

```sh
kimi --agent okabe
```

### `default`

The default agent, suitable for general use. Enabled tools:

`Task`, `SetTodoList`, `Shell`, `ReadFile`, `ReadMediaFile`, `Glob`, `Grep`, `WriteFile`, `StrReplaceFile`, `SearchWeb`, `FetchURL`

### `okabe`

An experimental agent for testing new prompts and tools. Enables `SendDMail` in addition to the `default` tools.

## Custom agent files

Agents are defined in YAML format. Load a custom agent using the `--agent-file` parameter:

```sh
kimi --agent-file /path/to/my-agent.yaml
```

**Basic structure**

```yaml
version: 1
agent:
  name: my-agent
  system_prompt_path: ./system.md
  tools:
    - "kimi_cli.tools.shell:Shell"
    - "kimi_cli.tools.file:ReadFile"
    - "kimi_cli.tools.file:WriteFile"
```

**Inheritance and overrides**

Use `extend` to inherit configuration from another agent, overriding only the parts you need:

```yaml
version: 1
agent:
  extend: default  # Inherit from the default agent
  system_prompt_path: ./my-prompt.md  # Override system prompt
  exclude_tools:  # Exclude certain tools
    - "kimi_cli.tools.web:SearchWeb"
    - "kimi_cli.tools.web:FetchURL"
```

`extend: default` inherits the built-in default agent. You can also specify a relative path to inherit from another agent file.

**Configuration fields**

| Field | Description | Required |
|-------|-------------|----------|
| `extend` | Agent to inherit from, can be `default` or a relative path | No |
| `name` | Agent name | Yes (can be omitted when inheriting) |
| `system_prompt_path` | Path to system prompt file, relative to the agent file | Yes (can be omitted when inheriting) |
| `system_prompt_args` | Custom parameters passed to the system prompt, merged when inheriting | No |
| `tools` | List of tools in `module:ClassName` format | Yes (can be omitted when inheriting) |
| `exclude_tools` | Tools to exclude | No |
| `subagents` | Subagent definitions | No |

## Built-in system prompt parameters

The system prompt file is a Markdown template that can reference variables using `${VAR}` syntax. Built-in variables include:

| Variable | Description |
|----------|-------------|
| `${KIMI_NOW}` | Current time (ISO format) |
| `${KIMI_WORK_DIR}` | Working directory path |
| `${KIMI_WORK_DIR_LS}` | Working directory file list |
| `${KIMI_AGENTS_MD}` | AGENTS.md file content (if exists) |
| `${KIMI_SKILLS}` | List of loaded skills |

You can also define custom parameters via `system_prompt_args`:

```yaml
agent:
  system_prompt_args:
    MY_VAR: "custom value"
```

Then use `${MY_VAR}` in the prompt.

**System prompt example**

```markdown
# My Agent

You are a helpful assistant. Current time: ${KIMI_NOW}.

Working directory: ${KIMI_WORK_DIR}

${MY_VAR}
```

## Defining subagents in agent files

Subagents can handle specific types of tasks. Once defined in the agent file, the main agent can launch them via the `Task` tool:

```yaml
version: 1
agent:
  extend: default
  subagents:
    coder:
      path: ./coder-sub.yaml
      description: "Handle coding tasks"
    reviewer:
      path: ./reviewer-sub.yaml
      description: "Code review expert"
```

Subagent files also follow the standard agent format, typically inheriting from the main agent and excluding certain tools:

```yaml
# coder-sub.yaml
version: 1
agent:
  extend: ./agent.yaml  # Inherit from main agent
  system_prompt_args:
    ROLE_ADDITIONAL: |
      You are now running as a subagent...
  exclude_tools:
    - "kimi_cli.tools.multiagent:Task"  # Exclude Task tool to avoid nesting
```

## How subagents run

Subagents launched via the `Task` tool run in an isolated context and return results to the main agent upon completion. Advantages of this approach:

- Isolated context prevents polluting the main agent's conversation history
- Multiple independent tasks can be processed in parallel
- Subagents can have tailored system prompts

## Dynamic subagent creation

`CreateSubagent` is an advanced tool that allows the AI to dynamically define new subagent types at runtime (disabled by default). To use it, add to your agent file:

```yaml
agent:
  tools:
    - "kimi_cli.tools.multiagent:CreateSubagent"
```

## Built-in tool list

Here are all the built-in tools in Kimi Code CLI.

### `Task`

- **Path**: `kimi_cli.tools.multiagent:Task`
- **Description**: Dispatch subagents to execute tasks. Subagents cannot access the main agent's context; all necessary information must be provided in the prompt.

| Parameter | Type | Description |
|-----------|------|-------------|
| `description` | string | Brief task description (3-5 words) |
| `subagent_name` | string | Subagent name |
| `prompt` | string | Detailed task description |

### `SetTodoList`

- **Path**: `kimi_cli.tools.todo:SetTodoList`
- **Description**: Manage todo list to track task progress

| Parameter | Type | Description |
|-----------|------|-------------|
| `todos` | array | Todo list |
| `todos[].title` | string | Todo title |
| `todos[].status` | string | Status: `pending`, `in_progress`, `done` |

### `Shell`

- **Path**: `kimi_cli.tools.shell:Shell`
- **Description**: Execute shell commands. Requires user approval. Uses the appropriate shell for the OS (bash/zsh on Unix, PowerShell on Windows).

| Parameter | Type | Description |
|-----------|------|-------------|
| `command` | string | Command to execute |
| `timeout` | int | Timeout in seconds, default 60, max 300 |

### `ReadFile`

- **Path**: `kimi_cli.tools.file:ReadFile`
- **Description**: Read text file content. Reads up to 1000 lines per request, max 2000 characters per line. Files outside the working directory require absolute paths.

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | File path |
| `line_offset` | int | Starting line number, default 1 |
| `n_lines` | int | Number of lines to read, default/max 1000 |

### `ReadMediaFile`

- **Path**: `kimi_cli.tools.file:ReadMediaFile`
- **Description**: Read image or video files. Max file size 100MB. Only available when the model supports image/video input. Files outside the working directory require absolute paths.

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | File path |

### `Glob`

- **Path**: `kimi_cli.tools.file:Glob`
- **Description**: Match files and directories by pattern. Returns up to 1000 matches, patterns starting with `**` are not allowed.

| Parameter | Type | Description |
|-----------|------|-------------|
| `pattern` | string | Glob pattern (e.g., `*.py`, `src/**/*.ts`) |
| `directory` | string | Search directory, defaults to working directory |
| `include_dirs` | bool | Whether to include directories, default true |

### `Grep`

- **Path**: `kimi_cli.tools.file:Grep`
- **Description**: Search file content using regular expressions, based on ripgrep

| Parameter | Type | Description |
|-----------|------|-------------|
| `pattern` | string | Regular expression pattern |
| `path` | string | Search path, defaults to current directory |
| `glob` | string | File filter (e.g., `*.js`) |
| `type` | string | File type (e.g., `py`, `js`, `go`) |
| `output_mode` | string | Output mode: `files_with_matches` (default), `content`, `count_matches` |
| `-B` | int | Show N lines before each match |
| `-A` | int | Show N lines after each match |
| `-C` | int | Show N lines before and after each match |
| `-n` | bool | Show line numbers |
| `-i` | bool | Case insensitive search |
| `multiline` | bool | Enable multiline matching |
| `head_limit` | int | Limit output lines |

### `WriteFile`

- **Path**: `kimi_cli.tools.file:WriteFile`
- **Description**: Write to a file. Write operations require user approval. When writing files outside the working directory, an absolute path must be used.

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | Absolute path |
| `content` | string | File content |
| `mode` | string | `overwrite` (default) or `append` |

### `StrReplaceFile`

- **Path**: `kimi_cli.tools.file:StrReplaceFile`
- **Description**: Edit files using string replacement. Edit operations require user approval. When editing files outside the working directory, an absolute path must be used.

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | Absolute path |
| `edit` | object/array | Single edit or list of edits |
| `edit.old` | string | String to be replaced |
| `edit.new` | string | Replacement string |
| `edit.replace_all` | bool | Whether to replace all matches, default false |

### `SearchWeb`

- **Path**: `kimi_cli.tools.web:SearchWeb`
- **Description**: Search the web. Requires search service configuration (automatically configured on Kimi Code platform).

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | Search query |
| `limit` | int | Number of results, default 5, max 20 |
| `include_content` | bool | Whether to include page content, default false |

### `FetchURL`

- **Path**: `kimi_cli.tools.web:FetchURL`
- **Description**: Fetch web page content and return the extracted main text. If a fetch service is configured, it will be used preferentially; otherwise, local HTTP requests will be used.

| Parameter | Type | Description |
|-----------|------|-------------|
| `url` | string | URL to fetch |

### `Think`

- **Path**: `kimi_cli.tools.think:Think`
- **Description**: Let the agent record thinking process, useful for complex reasoning scenarios

| Parameter | Type | Description |
|-----------|------|-------------|
| `thought` | string | Thinking content |

### `SendDMail`

- **Path**: `kimi_cli.tools.dmail:SendDMail`
- **Description**: Send delayed message (D-Mail), used for checkpoint rollback scenarios

| Parameter | Type | Description |
|-----------|------|-------------|
| `message` | string | Message to send |
| `checkpoint_id` | int | Checkpoint ID to send back to (>= 0) |

### `CreateSubagent`

- **Path**: `kimi_cli.tools.multiagent:CreateSubagent`
- **Description**: Dynamically create subagents

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | string | Unique name for the subagent, used to reference in the `Task` tool |
| `system_prompt` | string | System prompt defining the agent's role, capabilities, and boundaries |

## Tool safety boundaries

**Working directory restrictions**

- File read/write typically occurs within the working directory
- Reading files outside the working directory requires absolute paths
- Write and edit operations require user approval; when operating on files outside the working directory, absolute paths must be used

**Approval mechanism**

The following operations require user approval:

| Operation | Approval requirement |
|-----------|---------------------|
| Shell command execution | Every execution |
| File write/edit | Every operation |
| MCP tool calls | Every call |
