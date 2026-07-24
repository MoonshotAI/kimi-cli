# Hooks (Beta)

::: warning Beta feature
The Hooks system is currently in Beta. Implementation details and configuration definitions may change in future versions. Use with caution in production environments and watch for updates.
:::

The Hooks system allows you to execute custom commands at key points in the Agent lifecycle, enabling automated workflows, security checks, notifications, and more.

## What is a Hook

A hook is a mechanism that triggers when specific events occur. You can configure a shell command that receives context information via standard input when the event fires, and the command's exit code determines subsequent behavior.

Example use cases:

- **Code formatting**: Automatically run `prettier` or `black` after file edits
- **Security checks**: Block dangerous shell commands (like `rm -rf /`)
- **Sensitive file protection**: Prevent modification of `.env` and similar files
- **Desktop notifications**: Send alerts when human approval is needed
- **Task verification**: Check for incomplete tasks before session ends

## Supported Hook Events

Kimi Code CLI supports 13 lifecycle events:

| Event | Trigger | Matcher Filter | Available Context |
|-------|---------|----------------|-------------------|
| `PreToolUse` | Before tool call | Tool name | `tool_name`, `tool_input`, `tool_call_id` |
| `PostToolUse` | After successful tool execution | Tool name | `tool_name`, `tool_input`, `tool_output` |
| `PostToolUseFailure` | After tool execution fails | Tool name | `tool_name`, `tool_input`, `error` |
| `UserPromptSubmit` | Before user input is processed | None | `prompt` |
| `Stop` | When Agent turn ends | None | `stop_hook_active` |
| `StopFailure` | When turn ends due to error | Error type | `error_type`, `error_message` |
| `SessionStart` | When session is created/resumed | Source (`startup`/`resume`) | `source` |
| `SessionEnd` | When session closes | Reason | `reason` |
| `SubagentStart` | When subagent starts | Agent name | `agent_name`, `prompt` |
| `SubagentStop` | When subagent ends | Agent name | `agent_name`, `response` |
| `PreCompact` | Before context compaction | Trigger reason | `trigger`, `token_count` |
| `PostCompact` | After context compaction | Trigger reason | `trigger`, `estimated_token_count` |
| `Notification` | When notification is delivered | Sink name | `sink`, `notification_type`, `title`, `body`, `severity` |

## Configuring Hooks

Define hooks in `~/.kimi/config.toml` using the `[[hooks]]` array syntax:

```toml
# Auto-format after file edits
[[hooks]]
event = "PostToolUse"
matcher = "WriteFile|StrReplaceFile"
command = "jq -r '.tool_input.file_path' | xargs prettier --write"

# Block edits to .env files
[[hooks]]
event = "PreToolUse"
matcher = "WriteFile|StrReplaceFile"
command = ".kimi/hooks/protect-env.sh"
timeout = 10

# Desktop notification when approval needed
[[hooks]]
event = "Notification"
matcher = "permission_prompt"
command = "osascript -e 'display notification \"Kimi needs attention\" with title \"Kimi CLI\"'"

# Verify tasks complete before stopping
[[hooks]]
event = "Stop"
command = ".kimi/hooks/check-complete.sh"
```

### Configuration Fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `event` | Yes | — | Event type, must be one of the 13 supported events |
| `command` | Yes | — | Shell command to execute, receives JSON via stdin |
| `matcher` | No | `""` | Regex filter, empty string matches all |
| `timeout` | No | `30` | Timeout in seconds, fail-open on timeout |

## Communication Protocol

### Input (Standard Input)

Hook commands receive JSON context via stdin, containing common fields and event-specific fields:

```json
{
  "session_id": "abc123",
  "cwd": "/path/to/project",
  "hook_event_name": "PreToolUse",
  "tool_name": "Shell",
  "tool_input": {"command": "rm -rf /"}
}
```

### Output (Exit Code)

| Exit Code | Behavior | Feedback |
|-----------|----------|----------|
| `0` | Allow | stdout content (if non-empty) is added to context |
| `2` | Block | stderr content is fed back to LLM as correction |
| Other | Allow | stderr is logged only, not shown to LLM |

### Structured JSON Output

When exiting with code 0, you can output structured JSON for more detailed information:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Please use rg instead of grep"
  }
}
```

When `permissionDecision` is `deny`, the operation is blocked and `permissionDecisionReason` is fed back to the LLM.

## Hook Script Examples

### Protect Sensitive Files

```bash
#!/bin/bash
# .kimi/hooks/protect-env.sh

read JSON
echo "$JSON" | jq -r '.tool_input.file_path' | grep -qE '\.env$|\.env\.local$'

if [ $? -eq 0 ]; then
    echo "Error: Direct modification of .env files is not allowed. Use .env.example instead." >&2
    exit 2
fi

exit 0
```

### Auto-format Code

```bash
#!/bin/bash
# .kimi/hooks/auto-format.sh

FILE=$(python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('file_path',''))")

if [[ "$FILE" == *.js ]] || [[ "$FILE" == *.ts ]]; then
    prettier --write "$FILE" 2>/dev/null
elif [[ "$FILE" == *.py ]]; then
    black "$FILE" 2>/dev/null
fi

exit 0
```

### Check for Incomplete Tasks

```bash
#!/bin/bash
# .kimi/hooks/check-complete.sh

# Check for running background tasks
if kimi task list --active 2>/dev/null | grep -q "running"; then
    echo '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"Background tasks are still running. Please check /task first."}}'
    exit 0
fi

exit 0
```

## Viewing Configured Hooks

Use the `/hooks` command in Shell mode to view currently configured hooks:

```
/hooks
```

Example output:

```
Configured Hooks:

  PostToolUse: 1 hook(s)
  PreToolUse: 1 hook(s)
  Notification: 1 hook(s)
  Stop: 1 hook(s)
```

## Design Principles

### Fail-Open Policy

All hook execution failures (timeouts, crashes, regex errors) are treated as "allow", ensuring the Agent's normal workflow is not blocked. You can check logs for failure reasons.

### Parallel Execution

Multiple hooks for the same event run in parallel for better performance. Identical commands are automatically deduplicated.

### Stop Hook Anti-Loop

Stop hooks can only re-trigger once to prevent infinite loops. On re-trigger, the `stop_hook_active` field is set to `true`, allowing hooks to exit early.

### Context Variables

Session ID is passed via ContextVar, avoiding the need to explicitly pass parameters on every tool call.

## Comparison with Plugins

| Feature | Hooks | Plugins |
|---------|-------|---------|
| Trigger | Lifecycle events | Tool calls |
| Timing | Specific events | AI-initiated |
| Interaction | No interaction, receives stdin | Receives JSON parameters |
| Purpose | Automation, security, notifications | Extend AI capabilities |
| Return | Exit code controls flow | stdout as result |

Hooks are suitable for checks or automation at key points, while plugins provide new tool capabilities for the AI. Both can be used together—for example, using hooks to block certain operations and plugins to provide alternatives.
