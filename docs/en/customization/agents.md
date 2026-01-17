# Agents and Subagents

An agent defines the AI's behavior, including system prompts, available tools, and subagents. You can use built-in agents or create custom agents.

## Built-in agents

Gitrekt CLI provides two built-in agents. You can select one at startup with the `--agent` flag:

```sh
Gitrekt --agent okabe
```

### `default`

The default agent, suitable for general use. Enabled tools:

`Task`, `SetTodoList`, `Shell`, `ReadFile`, `Glob`, `Grep`, `WriteFile`, `StrReplaceFile`, `SearchWeb`, `FetchURL`

### `okabe`

An experimental agent for testing new prompts and tools. Adds `SendDMail` on top of `default`.

## Custom agent files

Agents are defined in YAML format. Load a custom agent with the `--agent-file` flag:

```sh
Gitrekt --agent-file /path/to/my-agent.yaml
```

**Basic structure**

```yaml
version: 1
agent:
  name: my-agent
  system_prompt_path: ./system.md
  tools:
    - "gitrekt_cli.tools.shell:Shell"
    - "gitrekt_cli.tools.file:ReadFile"
    - "gitrekt_cli.tools.file:WriteFile"
```

**Inheritance and overrides**

Use `extend` to inherit another agent's configuration and only override what you need to change:

```yaml
version: 1
agent:
  extend: default  # Inherit from default agent
  system_prompt_path: ./my-prompt.md  # Override system prompt
  exclude_tools:  # Exclude certain tools
    - "gitrekt_cli.tools.web:SearchWeb"
    - "gitrekt_cli.tools.web:FetchURL"
```

`extend: default` inherits from the built-in default agent. You can also specify a relative path to inherit from another agent file.

**Configuration fields**

| Field | Description | Required |
|-------|-------------|----------|
| `extend` | Agent to inherit from, can be `default` or a relative path | No |
| `name` | Agent name | Yes (optional when inheriting) |
| `system_prompt_path` | System prompt file path, relative to agent file | Yes (optional when inheriting) |
| `system_prompt_args` | Custom arguments passed to system prompt, merged when inheriting | No |
| `tools` | Tool list, format is `module:ClassName` | Yes (optional when inheriting) |
| `exclude_tools` | Tools to exclude | No |
| `subagents` | Subagent definitions | No |

## System prompt built-in parameters

The system prompt file is a Markdown template that can use `${VAR}` syntax to reference variables. Built-in variables include:

| Variable | Description |
|----------|-------------|
| `${GITREKT_NOW}` | Current time (ISO format) |
| `${GITREKT_WORK_DIR}` | Working directory path |
| `${GITREKT_WORK_DIR_LS}` | Working directory file list |
| `${GITREKT_AGENTS_MD}` | AGENTS.md file content (if exists) |
| `${GITREKT_SKILLS}` | Loaded skills list |

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

You are a helpful assistant. Current time: ${GITREKT_NOW}.

Working directory: ${GITREKT_WORK_DIR}

${MY_VAR}
```

## Defining subagents in agent files

Subagents can handle specific types of tasks. After defining subagents in an agent file, the main agent can launch them via the `Task` tool:

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

Subagent files are also standard agent format, typically inheriting from the main agent and excluding certain tools:

```yaml
# coder-sub.yaml
version: 1
agent:
  extend: ./agent.yaml  # Inherit from main agent
  system_prompt_args:
    ROLE_ADDITIONAL: |
      You are now running as a subagent...
  exclude_tools:
    - "gitrekt_cli.tools.multiagent:Task"  # Exclude Task tool to avoid nesting
```

## How subagents run

Subagents launched via the `Task` tool run in an isolated context and return results to the main agent when complete. Advantages of this approach:

- Isolated context, avoiding pollution of main agent's conversation history
- Multiple independent tasks can be processed in parallel
- Subagents can have targeted system prompts

## Dynamic subagent creation

`CreateSubagent` is an advanced tool that allows AI to dynamically define new subagent types at runtime (not enabled by default). To use it, add to your agent file:

```yaml
agent:
  tools:
    - "gitrekt_cli.tools.multiagent:CreateSubagent"
```

## Built-in tools list

The following are all built-in tools in Gitrekt CLI.

### `Task`

- **Path**: `gitrekt_cli.tools.multiagent:Task`
- **Description**: Dispatch a subagent to execute a task. Subagents cannot access the main agent's context; all necessary information must be provided in the prompt.

| Parameter | Type | Description |
|-----------|------|-------------|
| `description` | string | Short task description (3-5 words) |
| `subagent_name` | string | Subagent name |
| `prompt` | string | Detailed task description |

### `SetTodoList`

- **Path**: `gitrekt_cli.tools.todo:SetTodoList`
- **Description**: Manage todo list, track task progress

| Parameter | Type | Description |
|-----------|------|-------------|
| `todos` | array | Todo list items |
| `todos[].title` | string | Todo item title |
| `todos[].status` | string | Status: `pending`, `in_progress`, `done` |

### `Shell`

- **Path**: `gitrekt_cli.tools.shell:Shell`
- **Description**: Execute shell commands. Requires user approval. Uses the appropriate shell for the OS (bash/zsh on Unix, PowerShell on Windows).

| Parameter | Type | Description |
|-----------|------|-------------|
| `command` | string | Command to execute |
| `timeout` | int | Timeout in seconds, default 60, max 300 |

### `ReadFile`

- **Path**: `gitrekt_cli.tools.file:ReadFile`
- **Description**: Read file content. Supports text, image, and video files. For text files, max 1000 lines per read, max 2000 characters per line; for image/video files, max 80MB. Files outside working directory require absolute paths.

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | File path |
| `line_offset` | int | Starting line number, default 1 (text files only) |
| `n_lines` | int | Number of lines to read, default/max 1000 (text files only) |

### `Glob`

- **Path**: `gitrekt_cli.tools.file:Glob`
- **Description**: Match files and directories by pattern. Returns max 1000 matches, patterns starting with `**` not allowed.

| Parameter | Type | Description |
|-----------|------|-------------|
| `pattern` | string | Glob pattern (e.g., `*.py`, `src/**/*.ts`) |
| `directory` | string | Search directory, defaults to working directory |
| `include_dirs` | bool | Include directories, default true |

### `Grep`

- **Path**: `gitrekt_cli.tools.file:Grep`
- **Description**: Search file content with regular expressions, based on ripgrep

| Parameter | Type | Description |
|-----------|------|-------------|
| `pattern` | string | Regular expression pattern |
| `path` | string | Search path, defaults to current directory |
| `glob` | string | File filter (e.g., `*.js`) |
| `type` | string | File type (e.g., `py`, `js`, `go`) |
| `output_mode` | string | Output mode: `files_with_matches` (default), `content`, `count_matches` |
| `-B` | int | Show N lines before match |
| `-A` | int | Show N lines after match |
| `-C` | int | Show N lines before and after match |
| `-n` | bool | Show line numbers |
| `-i` | bool | Case insensitive |
| `multiline` | bool | Enable multiline matching |
| `head_limit` | int | Limit output lines |

### `WriteFile`

- **Path**: `gitrekt_cli.tools.file:WriteFile`
- **Description**: Write files. Can only write to files within working directory, must use absolute paths, requires user approval.

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | Absolute path |
| `content` | string | File content |
| `mode` | string | `overwrite` (default) or `append` |

### `StrReplaceFile`

- **Path**: `gitrekt_cli.tools.file:StrReplaceFile`
- **Description**: Edit files using string replacement. Can only edit files within working directory, must use absolute paths, requires user approval.

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | Absolute path |
| `edit` | object/array | Single edit or list of edits |
| `edit.old` | string | Original string to replace |
| `edit.new` | string | Replacement string |
| `edit.replace_all` | bool | Replace all matches, default false |

### `SearchWeb`

- **Path**: `gitrekt_cli.tools.web:SearchWeb`
- **Description**: Search the web. Requires search service configuration (auto-configured on Gitrekt Code platform).

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | Search keywords |
| `limit` | int | Number of results, default 5, max 20 |
| `include_content` | bool | Include page content, default false |

### `FetchURL`

- **Path**: `gitrekt_cli.tools.web:FetchURL`
- **Description**: Fetch webpage content, returns extracted main text. Uses fetch service if configured, otherwise uses local HTTP request.

| Parameter | Type | Description |
|-----------|------|-------------|
| `url` | string | URL to fetch |

### `Think`

- **Path**: `gitrekt_cli.tools.think:Think`
- **Description**: Let the agent record thinking process, suitable for complex reasoning scenarios

| Parameter | Type | Description |
|-----------|------|-------------|
| `thought` | string | Thinking content |

### `SendDMail`

- **Path**: `gitrekt_cli.tools.dmail:SendDMail`
- **Description**: Send delayed message (D-Mail), for checkpoint rollback scenarios

| Parameter | Type | Description |
|-----------|------|-------------|
| `message` | string | Message to send |
| `checkpoint_id` | int | Checkpoint ID to send back to (>= 0) |

### `CreateSubagent`

- **Path**: `gitrekt_cli.tools.multiagent:CreateSubagent`
- **Description**: Dynamically create subagents

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | string | Unique name for the subagent, used to reference in `Task` tool |
| `system_prompt` | string | System prompt defining agent's role, capabilities, and boundaries |

## Tool security boundaries

**Working directory restrictions**

- File writing and editing can only be done within the working directory
- Files outside working directory can be read, but require absolute paths

**Approval mechanism**

The following operations require user approval:

| Operation | Approval required |
|-----------|-------------------|
| Shell command execution | Each execution |
| File write/edit | Each operation |
| MCP tool calls | Each call |
