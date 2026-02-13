# Hooks Configuration

Hooks allow you to insert custom commands into Kimi Code CLI's lifecycle for security checks, code reviews, automation workflows, and more.

## Overview

Kimi Code CLI's hooks use a **command-based** design: you implement custom logic by executing external commands or scripts. This approach is:

- **Simple and transparent**: No hidden LLM calls
- **Fully controllable**: You decide what language/tool to use
- **Easy to debug**: Standard input/output, easy to test

## Configuration Location

Hooks are configured in the `[hooks]` section of `~/.kimi/config.toml`:

```toml
[hooks]
# Execute when session starts
[[hooks.session_start]]
name = "notify-start"
type = "command"
command = "notify-send 'Kimi session started'"

# Intercept before tool execution
[[hooks.before_tool]]
name = "block-dangerous"
type = "command"
matcher = { tool = "Shell", pattern = "rm -rf /" }
command = "echo '{\"decision\": \"deny\", \"reason\": \"Dangerous command\"}'"
```

## Hook Configuration

### Basic Structure

```toml
[[hooks.EVENT_TYPE]]
name = "hook-name"              # Optional, for identification
command = "shell command"       # Command to execute
timeout = 30000                 # Timeout in milliseconds (default: 30s)
matcher = { ... }               # Optional, filter conditions
async_ = false                  # Execute asynchronously (default: false)
description = "Description"     # Optional description
```

### Matcher Filtering

Use matchers to execute hooks only under specific conditions:

```toml
# Match specific tool
matcher = { tool = "Shell" }

# Use regex to match tool name
matcher = { tool = "Read.*|Write.*" }

# Match argument content
matcher = { pattern = "rm -rf" }

# Combined matching
matcher = { tool = "Shell", pattern = "rm -rf /" }
```

### Asynchronous Execution

Set `async_ = true` to run the hook in the background without blocking:

```toml
[[hooks.after_tool]]
name = "auto-format"
type = "command"
matcher = { tool = "WriteFile", pattern = "\\.py$" }
command = "black --quiet \"$KIMI_WORK_DIR/{{tool_input.file_path}}\""
async_ = true  # Async execution
timeout = 30000
```

## Command Protocol

### Input

Commands receive JSON event data via **stdin**:

```json
{
  "event_type": "before_tool",
  "timestamp": "2026-01-15T10:30:00+08:00",
  "session_id": "sess_abc123",
  "work_dir": "/home/user/project",
  "tool_name": "Shell",
  "tool_input": {
    "command": "ls -la"
  }
}
```

### Output

Commands return JSON results via **stdout**:

```json
{
  "decision": "allow",        // allow | deny | ask
  "reason": "Description",
  "additional_context": "Extra information"
}
```

### Exit Codes

| Exit Code | Meaning | Behavior |
|-----------|---------|----------|
| `0` | Success | Parse stdout as result |
| `2` | Blocking error | Block action, stderr as feedback |
| Other | Non-blocking error | Log warning, continue execution |

## Environment Variables

Hook commands have access to these environment variables:

- `KIMI_SESSION_ID` - Current session ID
- `KIMI_WORK_DIR` - Current working directory
- `KIMI_PROJECT_DIR` - Same as WORK_DIR
- `KIMI_ENV_FILE` - Path to environment file (for session_start hooks to pass variables)

## Event Types

| Event Type | Trigger | Extra stdin Fields |
|-----------|---------|-------------------|
| `session_start` | When session starts | - |
| `session_end` | When session ends | `duration_seconds`, `total_steps`, `exit_reason` |
| `before_agent` | Before agent executes | - |
| `after_agent` | After agent executes | - |
| `before_tool` | Before tool executes | `tool_name`, `tool_input`, `tool_use_id` |
| `after_tool` | After tool executes | `tool_name`, `tool_input`, `tool_output` |
| `after_tool_failure` | When tool execution fails | `tool_name`, `tool_input`, `error` |
| `subagent_start` | When subagent starts | `subagent_name`, `subagent_type`, `task_description` |
| `subagent_stop` | When subagent stops | `subagent_name`, `exit_reason` |
| `pre_compact` | Before context compaction | `context_tokens` |

## Examples

### Python Hook Script

```python
#!/usr/bin/env python3
# my-security-hook.py
import json
import sys

def main():
    # Read event data
    event = json.load(sys.stdin)
    
    tool_name = event.get("tool_name", "")
    tool_input = event.get("tool_input", {})
    
    # Security check logic
    if tool_name == "Shell":
        command = tool_input.get("command", "")
        dangerous = ["rm -rf /", "mkfs", "dd if=/dev/zero"]
        if any(d in command for d in dangerous):
            result = {
                "decision": "deny",
                "reason": f"Dangerous command detected: {command}"
            }
            print(json.dumps(result))
            sys.exit(2)  # Block
    
    # Default allow
    result = {"decision": "allow"}
    print(json.dumps(result))

if __name__ == "__main__":
    main()
```

Configuration:

```toml
[[hooks.before_tool]]
name = "security-check"
type = "command"
matcher = { tool = "Shell" }
command = "python /path/to/my-security-hook.py"
```

### Shell Hook Example

```toml
# Block dangerous commands
[[hooks.before_tool]]
name = "block-dangerous"
type = "command"
matcher = { tool = "Shell", pattern = "rm -rf /|mkfs" }
command = """
echo '{"decision": "deny", "reason": "Dangerous command blocked"}'
exit 2
"""

# Inject git info
[[hooks.session_start]]
name = "inject-git-info"
type = "command"
command = """
branch=$(git branch --show-current 2>/dev/null || echo "unknown")
echo "{\"additional_context\": \"Current branch: $branch\"}"
"""

# Auto-format code (async)
[[hooks.after_tool]]
name = "auto-format"
type = "command"
matcher = { tool = "WriteFile", pattern = "\\.py$" }
command = "black --quiet \"$KIMI_WORK_DIR/{{tool_input.file_path}}\" 2>/dev/null || true"
async_ = true
```

## Debugging

Use the `--debug-hooks` flag to see detailed hook execution logs:

```bash
kimi --debug-hooks
```

Logs include:
- Hook trigger events
- Input context
- Execution results and timing
- Error messages

## Best Practices

1. **Keep it simple**: One hook should do one thing
2. **Execute quickly**: Set reasonable timeout values
3. **Fail open**: Don't block on errors (unless really necessary)
4. **Use async**: Use `async_ = true` for non-critical operations (formatting, notifications)
5. **Log internally**: Hook scripts should log for easier debugging
