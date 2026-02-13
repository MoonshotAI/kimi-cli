# Hooks Configuration

Hooks allow you to insert custom commands into Kimi Code CLI's lifecycle for security checks, code review, automation, and more.

## Overview

Kimi Code CLI's hooks use a **command-based** design: implement custom logic by executing external commands or scripts. This approach:

- **Simple and transparent**: No hidden LLM calls
- **Fully controllable**: You decide what language/tools to use
- **Easy to debug**: Standard input/output, easy to test
- **Sync/Async options**: Default synchronous (blocking), optional asynchronous (non-blocking)

## Configuration Location

Hooks are configured in the `[hooks]` section of `~/.kimi/config.toml`:

```toml
[hooks]
# Execute when session starts
[[hooks.session_start]]
name = "notify-start"
type = "command"
command = "notify-send 'Kimi session started'"

# Intercept before tool execution (synchronous, can block)
[[hooks.before_tool]]
name = "block-dangerous"
type = "command"
matcher = { tool = "Shell", pattern = "rm -rf /" }
command = "echo '{\"decision\": \"deny\", \"reason\": \"Dangerous command\"}'"

# Execute after file write (asynchronous, non-blocking)
[[hooks.after_tool]]
name = "auto-format"
type = "command"
matcher = { tool = "WriteFile", pattern = "\\.py$" }
command = "black --quiet ."
async_ = true  # Asynchronous execution
```

## Hook Configuration

### Basic Structure

```toml
[[hooks.EVENT_TYPE]]
name = "hook-name"              # Optional, for identification
type = "command"                # Currently only supports command
command = "shell command"       # Command to execute
timeout = 30000                 # Timeout in milliseconds (default 30s)
matcher = { ... }               # Optional filtering conditions
async_ = false                  # Whether to execute asynchronously (default false)
description = "Description"     # Optional description
```

### Execution Modes: Synchronous vs Asynchronous

#### Synchronous Mode (Default)

```toml
[[hooks.before_tool]]
name = "security-check"
type = "command"
matcher = { tool = "Shell" }
command = "python /path/to/security-check.py"
async_ = false  # Or omit, default is synchronous
```

**Characteristics:**
- Waits for hook to complete before continuing
- **Can block operations** (via `decision = "deny"` or exit code 2)
- Suitable for security checks, permission validation, and critical operations
- Blocks main flow, may affect response speed

#### Asynchronous Mode

```toml
[[hooks.after_tool]]
name = "auto-format"
type = "command"
matcher = { tool = "WriteFile", pattern = "\\.py$" }
command = "black --quiet \"$KIMI_WORK_DIR/{{tool_input.file_path}}\""
async_ = true  # Asynchronous execution
timeout = 30000
```

**Characteristics:**
- Returns immediately without waiting for hook completion
- **Cannot block operations** (even if returning deny, it's ignored)
- Suitable for formatting, notifications, logging, and non-critical operations
- Non-blocking, better performance

### Matcher Filtering

Use matchers to execute hooks only under specific conditions:

```toml
# Match specific tool
matcher = { tool = "Shell" }

# Use regex to match tool names
matcher = { tool = "Read.*|Write.*" }

# Match parameter content
matcher = { pattern = "rm -rf" }

# Combined matching
matcher = { tool = "Shell", pattern = "rm -rf /" }
```

## Command Protocol

### Input

Commands receive JSON event information via **stdin**:

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

**`before_stop` Event Input:**

```json
{
  "event_type": "before_stop",
  "timestamp": "2026-01-15T10:30:00+08:00",
  "session_id": "sess_abc123",
  "work_dir": "/home/user/project",
  "stop_reason": "no_tool_calls",
  "step_count": 5,
  "final_message": {
    "role": "assistant",
    "content": "I've completed the task..."
  }
}
```

| Field | Description |
|-------|-------------|
| `stop_reason` | Why the agent is stopping: `no_tool_calls` (normal completion) or `tool_rejected` |
| `step_count` | Number of steps taken in this turn |
| `final_message` | The assistant's final message (if available) |

### Output

Commands return JSON results via **stdout**:

```json
{
  "decision": "allow",        // allow | deny | ask
  "reason": "Explanation",
  "modified_input": {},       // Modified input (optional)
  "additional_context": "Extra info"  // Additional context (optional)
}
```

### Exit Code Control

| Exit Code | Meaning | Behavior | Applicable Mode |
|-----------|---------|----------|-----------------|
| `0` | Success | Parse stdout JSON as result | Sync/Async |
| `2` | Blocking error | Block operation, stderr as feedback | **Sync only** |
| Others | Non-blocking error | Log warning, continue | Sync/Async |

**Important Distinction:**

- **Synchronous Mode** (`async_ = false`):
  - Exit 0 + `{"decision": "deny"}` → **Blocks operation**
  - Exit 2 → **Blocks operation**, stderr as reason
  
- **Asynchronous Mode** (`async_ = true`):
  - Whatever is returned, won't block operation
  - Only used for logging and side effects

## Environment Variables

Hook commands have access to these environment variables:

- `KIMI_SESSION_ID` - Current session ID
- `KIMI_WORK_DIR` - Current working directory
- `KIMI_PROJECT_DIR` - Same as WORK_DIR
- `KIMI_ENV_FILE` - Environment file path (for session_start hooks to pass variables)

## Event Types and Blocking Capability

| Event Type | Trigger Timing | Blockable | Recommended Mode |
|-----------|---------------|-----------|------------------|
| `session_start` | When session starts | ⚠️ Not recommended | Sync/Async |
| `session_end` | When session ends | ⚠️ Not recommended | Sync/Async |
| `before_agent` | Before Agent execution | ✅ Can block | Sync |
| `after_agent` | After Agent execution | ⚠️ Not recommended | Async |
| `before_tool` | Before tool execution | ✅ **Recommended** | **Sync** |
| `after_tool` | After tool execution | ❌ Cannot block | **Async** |
| `after_tool_failure` | When tool execution fails | ❌ Cannot block | Async |
| `subagent_start` | When subagent starts | ✅ Can block | Sync |
| `subagent_stop` | When subagent stops | ✅ Can block | Sync |
| `pre_compact` | Before context compaction | ⚠️ Not recommended | Async |
| `before_stop` | Before Agent stops responding | ✅ **Quality Gate** | **Sync** |

## Examples

### Synchronous Hook: Dangerous Command Blocking

```toml
[[hooks.before_tool]]
name = "block-dangerous"
type = "command"
matcher = { tool = "Shell", pattern = "rm -rf /|mkfs|dd if=/dev/zero" }
command = """
echo '{"decision": "deny", "reason": "Dangerous command blocked"}'
exit 2  # Use exit 2 to force block
"""
```

### Asynchronous Hook: Auto Code Formatting

```toml
[[hooks.after_tool]]
name = "auto-format-python"
type = "command"
matcher = { tool = "WriteFile", pattern = "\\.py$" }
command = "black --quiet ."
async_ = true  # Asynchronous execution, doesn't block editing
timeout = 30000
```

### Python Hook Script

```python
#!/usr/bin/env python3
# security-hook.py
import json
import sys

def main():
    # Read event data from stdin
    event = json.load(sys.stdin)
    
    tool_name = event.get("tool_name", "")
    tool_input = event.get("tool_input", {})
    
    # Security check logic
    if tool_name == "Shell":
        command = tool_input.get("command", "")
        
        # Dangerous command list
        dangerous = ["rm -rf /", "mkfs", "dd if=/dev/zero", "> /dev/sda"]
        for pattern in dangerous:
            if pattern in command:
                # Method 1: Use exit 2 to block
                print(f"Dangerous command detected: {pattern}", file=sys.stderr)
                sys.exit(2)
                
        # Sensitive operations requiring confirmation
        if "prod" in command and ("drop" in command or "delete" in command):
            result = {
                "decision": "ask",
                "reason": "This affects production. Continue?"
            }
            print(json.dumps(result))
            sys.exit(0)
    
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
command = "python /path/to/security-hook.py"
timeout = 5000
```

### Quality Gate Hook: Enforce Standards Before Stop

The `before_stop` hook is triggered when the Agent is about to stop responding. Use it to enforce quality gates:

```toml
[[hooks.before_stop]]
name = "verify-tests"
type = "command"
command = """
# Run tests before allowing the agent to complete
if ! npm test 2>&1; then
    echo "Tests must pass before completing" >&2
    exit 2
fi
echo '{"decision": "allow"}'
"""
timeout = 60000
```

When a `before_stop` hook blocks (exit 2 or `decision = "deny"`), the agent will continue working with the hook's feedback added to the context:

```
[Hook blocked stop: Tests must pass before completing]
```

More complex example - checking multiple conditions:

```python
#!/usr/bin/env python3
# quality-gate.py
import json
import subprocess
import sys

def main():
    event = json.load(sys.stdin)
    
    # Check if tests pass
    test_result = subprocess.run(["npm", "test"], capture_output=True, text=True)
    if test_result.returncode != 0:
        print(json.dumps({
            "decision": "deny",
            "reason": "Tests failed. Fix them before completing."
        }))
        sys.exit(0)
    
    # Check code formatting
    fmt_result = subprocess.run(["black", "--check", "."], capture_output=True)
    if fmt_result.returncode != 0:
        print(json.dumps({
            "decision": "deny", 
            "reason": "Code is not formatted. Run 'black .' to fix."
        }))
        sys.exit(0)
    
    print(json.dumps({"decision": "allow"}))

if __name__ == "__main__":
    main()
```

### Combined Usage: Sync Check + Async Processing

```toml
# 1. Synchronous dangerous command blocking
[[hooks.before_tool]]
name = "block-dangerous"
type = "command"
matcher = { tool = "Shell" }
command = """
input=$(cat)
if echo "$input" | grep -q "rm -rf /"; then
    echo '{"decision": "deny", "reason": "Dangerous command blocked"}'
    exit 2
fi
echo '{"decision": "allow"}'
"""

# 2. Asynchronous code formatting
[[hooks.after_tool]]
name = "auto-format"
type = "command"
matcher = { tool = "WriteFile", pattern = "\\.py$" }
command = "black --quiet ."
async_ = true
timeout = 30000

# 3. Asynchronous notification
[[hooks.after_tool]]
name = "notify-changes"
type = "command"
matcher = { tool = "WriteFile" }
command = """
input=$(cat)
file=$(echo "$input" | grep -o '"file_path": "[^"]*"' | cut -d'"' -f4)
notify-send "File modified: $file"
"""
async_ = true
timeout = 5000
```

## Debugging

Use `--debug` flag for detailed hook execution logs (includes hooks debugging):

```bash
kimi --debug
```

Log output includes:
- Hook trigger events
- Sync/Async mode indicators
- Input context
- Execution results and timing
- Error information

Example output:
```
[HOOK DEBUG] [SYNC] Starting command hook 'block-dangerous' for event 'before_tool'
[HOOK DEBUG] [SYNC] Completed hook 'block-dangerous' in 45ms: success=True, decision=deny
[HOOK DEBUG] Reason: Dangerous command blocked

[HOOK DEBUG] [ASYNC] Starting command hook 'auto-format' for event 'after_tool'
[HOOK DEBUG] [ASYNC] Hook 'auto-format' fired (running in background)
```

## Best Practices

### 1. Choose Mode Based on Scenario

| Scenario | Recommended Mode | Reason |
|----------|-----------------|--------|
| Security check, permission validation | Sync | Need blocking capability |
| Code formatting | Async | No need to wait |
| Logging | Async | Doesn't affect performance |
| Notification | Async | Instant feedback |
| Data backup | Sync | Ensure completion |

### 2. Set Reasonable Timeouts

```toml
# Quick check: 1 second
[[hooks.before_tool]]
name = "quick-check"
timeout = 1000
command = "..."

# Complex analysis: 10 seconds
[[hooks.before_tool]]
name = "deep-analysis"
timeout = 10000
command = "..."

# Long-running task: use async
[[hooks.after_tool]]
name = "long-task"
async_ = true
timeout = 60000
command = "..."
```

### 3. Use Exit Code 2 for Force Block

When you need to ensure operation is blocked, use exit 2:

```bash
#!/bin/bash
# This method is most reliable, doesn't rely on JSON parsing

if [ "dangerous condition" ]; then
    echo "Block reason" >&2
    exit 2
fi

echo '{"decision": "allow"}'
exit 0
```

### 4. Fail Open Principle

When hooks fail (timeout, exception, non-0/2 exit code), operations continue by default:

```python
# Your hook code should handle exceptions to avoid accidental blocking
try:
    # Check logic
    if is_dangerous():
        sys.exit(2)  # Explicit block
except Exception as e:
    # Log error but allow continuation
    print(f"Hook error: {e}", file=sys.stderr)
    print('{"decision": "allow"}')
    sys.exit(0)
```

### 5. Asynchronous Hook Notes

- Async hooks cannot modify input parameters
- Async hooks' `decision: deny` will be ignored
- Async hooks' stdout is logged but won't block operations
- Use async hooks for side effects (formatting, notifications, logging)

## Advanced Usage

### Conditional Execution

```toml
# Only execute in production environment
[[hooks.before_tool]]
name = "prod-check"
type = "command"
matcher = { tool = "Shell" }
command = """
if [ "$ENV" = "production" ]; then
    python /path/to/prod-check.py
else
    echo '{"decision": "allow"}'
fi
"""
```

### Chained Hooks

Multiple hooks execute in configuration order:

```toml
# Hook 1: Quick check (may block)
[[hooks.before_tool]]
name = "quick-check"
command = "..."

# Hook 2: Deep check (only if previous didn't block)
[[hooks.before_tool]]
name = "deep-check"
command = "..."

# Hook 3: Async processing (always runs)
[[hooks.after_tool]]
name = "async-process"
async_ = true
command = "..."
```

### Using Environment Variables to Pass State

```toml
[[hooks.session_start]]
name = "setup-env"
command = """
mkdir -p .kimi
echo "PROJECT_TYPE=python" >> .kimi/env
echo '{"decision": "allow"}'
"""

[[hooks.before_tool]]
name = "type-check"
command = """
if [ "$PROJECT_TYPE" = "python" ]; then
    # Execute Python-specific checks
fi
"""
```
