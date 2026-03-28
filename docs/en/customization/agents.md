# Agents and Subagents

An agent defines the AI's behavior, including system prompts, available tools, and subagents. You can use built-in agents or create custom agents.

## Built-in agents

Kimi Code CLI provides two built-in agents. You can select one at startup with the `--agent` flag:

```sh
kimi --agent okabe
```

### `default`

The default agent, suitable for general use. Enabled tools:

`Agent`, `AskUserQuestion`, `SetTodoList`, `Shell`, `ReadFile`, `ReadMediaFile`, `Glob`, `Grep`, `WriteFile`, `StrReplaceFile`, `SearchWeb`, `FetchURL`, `EnterPlanMode`, `ExitPlanMode`, `TaskList`, `TaskOutput`, `TaskStop`

### `okabe`

An experimental agent for testing new prompts and tools. Adds `SendDMail` on top of `default`.

## Custom agent files

Agents are defined in YAML format. Load a custom agent with the `--agent-file` flag:

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

Use `extend` to inherit another agent's configuration and only override what you need to change:

```yaml
version: 1
agent:
  extend: default  # Inherit from default agent
  system_prompt_path: ./my-prompt.md  # Override system prompt
  exclude_tools:  # Exclude certain tools
    - "kimi_cli.tools.web:SearchWeb"
    - "kimi_cli.tools.web:FetchURL"
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

The system prompt file is a Markdown template that can use `${VAR}` syntax to reference variables and supports the Jinja2 `{% include %}` directive to include other files. Built-in variables include:

| Variable | Description |
|----------|-------------|
| `${KIMI_NOW}` | Current time (ISO format) |
| `${KIMI_WORK_DIR}` | Working directory path |
| `${KIMI_WORK_DIR_LS}` | Working directory file list |
| `${KIMI_AGENTS_MD}` | AGENTS.md file content (if exists) |
| `${KIMI_SKILLS}` | Loaded skills list |
| `${KIMI_ADDITIONAL_DIRS_INFO}` | Information about additional directories added via `--add-dir` or `/add-dir` |

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

Subagents can handle specific types of tasks. After defining subagents in an agent file, the main agent can launch them via the `Agent` tool:

```yaml
version: 1
agent:
  extend: default
  subagents:
    coder:
      path: ./coder.yaml
      description: "Handle coding tasks"
    reviewer:
      path: ./reviewer.yaml
      description: "Code review expert"
```

Subagent files are also standard agent format, typically inheriting from the main agent:

```yaml
# coder.yaml
version: 1
agent:
  extend: ./agent.yaml  # Inherit from main agent
  system_prompt_args:
    ROLE_ADDITIONAL: |
      You are now running as a subagent...
```

## Built-in subagent types

The default agent configuration includes three built-in subagent types, each with different tool policies and use cases:

| Type | Purpose | Available tools |
|------|---------|----------------|
| `coder` | General software engineering: read/write files, run commands, search code | `Shell`, `ReadFile`, `Glob`, `Grep`, `WriteFile`, `StrReplaceFile`, `SearchWeb`, `FetchURL` |
| `explore` | Fast read-only codebase exploration: search, read, summarize | `Shell`, `ReadFile`, `Glob`, `Grep`, `SearchWeb`, `FetchURL` (no write tools) |
| `plan` | Implementation planning and architecture design: analyze files, create plans | `ReadFile`, `Glob`, `Grep`, `SearchWeb`, `FetchURL` (no Shell, no write tools) |

All subagent types are prohibited from nesting the `Agent` tool (subagents cannot create their own subagents). The `Agent` tool is only available to the root agent.

## How subagents run

Subagents launched via the `Agent` tool run in an isolated context and return results to the main agent when complete. Each subagent instance maintains its own context history and metadata under `subagents/<agent_id>/` in the session directory, and can be resumed across multiple invocations. Advantages of this approach:

- Isolated context, avoiding pollution of main agent's conversation history
- Multiple independent tasks can be processed in parallel
- Subagents can have targeted system prompts
- Persistent instances preserve context across multiple calls

## Built-in tools list

The following are all built-in tools in Kimi Code CLI.

### `Agent`

- **Path**: `kimi_cli.tools.agent:Agent`
- **Description**: Start or resume a subagent instance for a focused task. Three built-in subagent types are available: `coder` (general software engineering), `explore` (fast read-only codebase exploration), and `plan` (implementation planning and architecture design). Each instance maintains its own context history and supports foreground or background execution.

| Parameter | Type | Description |
|-----------|------|-------------|
| `description` | string | Short task description (3-5 words) |
| `prompt` | string | Detailed task description |
| `subagent_type` | string | Built-in subagent type, default `coder` |
| `model` | string | Optional model override |
| `resume` | string | Optional agent instance ID to resume an existing instance |
| `run_in_background` | bool | Whether to run in background, default false |

### `AskUserQuestion`

- **Path**: `kimi_cli.tools.ask_user:AskUserQuestion`
- **Description**: Present structured questions and options to the user during execution, collecting preferences or decisions. Suitable for scenarios where the user needs to choose between approaches, resolve ambiguous instructions, or provide requirements. Should not be overused — only call when the user's choice genuinely affects subsequent actions.

| Parameter | Type | Description |
|-----------|------|-------------|
| `questions` | array | Questions list (1–4 questions) |
| `questions[].question` | string | Question text, ending with `?` |
| `questions[].header` | string | Short label, max 12 characters (e.g., `Auth`, `Style`) |
| `questions[].options` | array | Available options (2–4), the system adds an "Other" option automatically |
| `questions[].options[].label` | string | Option label (1–5 words), append `(Recommended)` for recommended options |
| `questions[].options[].description` | string | Option description |
| `questions[].multi_select` | bool | Allow multiple selections, default false |

### `SetTodoList`

- **Path**: `kimi_cli.tools.todo:SetTodoList`
- **Description**: Manage todo list, track task progress

| Parameter | Type | Description |
|-----------|------|-------------|
| `todos` | array | Todo list items |
| `todos[].title` | string | Todo item title |
| `todos[].status` | string | Status: `pending`, `in_progress`, `done` |

### `Shell`

- **Path**: `kimi_cli.tools.shell:Shell`
- **Description**: Execute shell commands. Requires user approval. Uses the appropriate shell for the OS (bash/zsh on Unix, PowerShell on Windows).

| Parameter | Type | Description |
|-----------|------|-------------|
| `command` | string | Command to execute |
| `timeout` | int | Timeout in seconds, default 60, max 300 for foreground / 86400 for background |
| `run_in_background` | bool | Whether to run as a background task, default false |
| `description` | string | Short description for the background task, required when `run_in_background=true` |

When `run_in_background=true`, the command is launched as a background task and the tool immediately returns a task ID, allowing the AI to continue working. The system automatically sends a notification when the task completes. Ideal for long-running builds, tests, watchers, and servers.

### `ReadFile`

- **Path**: `kimi_cli.tools.file:ReadFile`
- **Description**: Read text file content. Max 1000 lines per read, max 2000 characters per line. Files outside working directory require absolute paths.

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | File path |
| `line_offset` | int | Starting line number, default 1 |
| `n_lines` | int | Number of lines to read, default/max 1000 |

### `ReadMediaFile`

- **Path**: `kimi_cli.tools.file:ReadMediaFile`
- **Description**: Read image or video files. Max file size 100MB. Only available when the model supports image/video input. Files outside working directory require absolute paths.

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | File path |

### `Glob`

- **Path**: `kimi_cli.tools.file:Glob`
- **Description**: Match files and directories by pattern. Returns max 1000 matches, patterns starting with `**` not allowed. Can also search within discovered skill roots, and `~` in paths is expanded to the user's home directory.

| Parameter | Type | Description |
|-----------|------|-------------|
| `pattern` | string | Glob pattern (e.g., `*.py`, `src/**/*.ts`) |
| `directory` | string | Search directory, defaults to working directory |
| `include_dirs` | bool | Include directories, default true |

### `Grep`

- **Path**: `kimi_cli.tools.file:Grep`
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

- **Path**: `kimi_cli.tools.file:WriteFile`
- **Description**: Write files. Requires user approval. Absolute paths are required when writing files outside the working directory.

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | Absolute path |
| `content` | string | File content |
| `mode` | string | `overwrite` (default) or `append` |

### `StrReplaceFile`

- **Path**: `kimi_cli.tools.file:StrReplaceFile`
- **Description**: Edit files using string replacement. Requires user approval. Absolute paths are required when editing files outside the working directory.

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | Absolute path |
| `edit` | object/array | Single edit or list of edits |
| `edit.old` | string | Original string to replace |
| `edit.new` | string | Replacement string |
| `edit.replace_all` | bool | Replace all matches, default false |

### `SearchWeb`

- **Path**: `kimi_cli.tools.web:SearchWeb`
- **Description**: Search the web. Requires search service configuration (auto-configured on Kimi Code platform).

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | Search keywords |
| `limit` | int | Number of results, default 5, max 20 |
| `include_content` | bool | Include page content, default false |

### `FetchURL`

- **Path**: `kimi_cli.tools.web:FetchURL`
- **Description**: Fetch webpage content, returns extracted main text. Uses fetch service if configured, otherwise uses local HTTP request.

| Parameter | Type | Description |
|-----------|------|-------------|
| `url` | string | URL to fetch |

### `Think`

- **Path**: `kimi_cli.tools.think:Think`
- **Description**: Let the agent record thinking process, suitable for complex reasoning scenarios

| Parameter | Type | Description |
|-----------|------|-------------|
| `thought` | string | Thinking content |

### `SendDMail`

- **Path**: `kimi_cli.tools.dmail:SendDMail`
- **Description**: Send delayed message (D-Mail), for checkpoint rollback scenarios

| Parameter | Type | Description |
|-----------|------|-------------|
| `message` | string | Message to send |
| `checkpoint_id` | int | Checkpoint ID to send back to (>= 0) |

### `EnterPlanMode`

- **Path**: `kimi_cli.tools.plan.enter:EnterPlanMode`
- **Description**: Request to enter plan mode. After calling, an approval request is presented to the user, who can approve or reject entering plan mode. In YOLO mode, this is only used when the user explicitly requests planning or when there is significant architectural ambiguity. See [Plan mode](../guides/interaction.md#plan-mode).

This tool takes no parameters.

### `ExitPlanMode`

- **Path**: `kimi_cli.tools.plan:ExitPlanMode`
- **Description**: Submit a plan for user approval while in plan mode. Before calling, the plan must be written to the plan file. This tool reads the plan file content and presents it to the user for approval. The user can select an implementation path (exit plan mode and start execution), reject (stay in plan mode and wait for feedback), or provide revision comments. See [Plan mode](../guides/interaction.md#plan-mode).

| Parameter | Type | Description |
|-----------|------|-------------|
| `options` | list \| null | When the plan contains multiple alternative implementation paths, list 2–3 options for the user to choose from. Each option has a `label` (1–8 word short name, may append "(Recommended)") and an optional `description` (brief summary). The labels "Approve", "Reject", and "Revise" are reserved and cannot be used. |

### `TaskList`

- **Path**: `kimi_cli.tools.background:TaskList`
- **Description**: List background tasks in the current session. Useful for re-enumerating task IDs after context compaction or checking which tasks are still running.

| Parameter | Type | Description |
|-----------|------|-------------|
| `active_only` | bool | List only active tasks, default true |
| `limit` | int | Maximum number of tasks to return (1–100), default 20 |

### `TaskOutput`

- **Path**: `kimi_cli.tools.background:TaskOutput`
- **Description**: Retrieve output and status of a background task. Returns a non-blocking status/output snapshot by default; use `ReadFile` with the returned `output_path` to read the full log if output is truncated.

| Parameter | Type | Description |
|-----------|------|-------------|
| `task_id` | string | Task ID to query |
| `block` | bool | Whether to wait for task completion, default false |
| `timeout` | int | Maximum wait time in seconds when `block=true` (0–3600), default 30 |

### `TaskStop`

- **Path**: `kimi_cli.tools.background:TaskStop`
- **Description**: Stop a running background task. Requires user approval. Use only when a task must be cancelled; for normal completion, wait for the automatic notification. Not available in plan mode.

| Parameter | Type | Description |
|-----------|------|-------------|
| `task_id` | string | Task ID to stop |
| `reason` | string | Reason for stopping (optional), default "Stopped by TaskStop" |


## Tool security boundaries

**Workspace scope**

- File reading and writing are typically done within the working directory (and additional directories added via `--add-dir` or `/add-dir`)
- Absolute paths are required when reading files outside the workspace
- Write and edit operations require user approval; absolute paths are required when operating on files outside the workspace

**Approval mechanism**

The following operations require user approval:

| Operation | Approval required |
|-----------|-------------------|
| Shell command execution | Each execution |
| File write/edit | Each operation |
| MCP tool calls | Each call |
| Stop background task | Each stop |
