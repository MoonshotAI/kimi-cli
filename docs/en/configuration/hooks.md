# Agent Hooks

Agent Hooks is an open, modular standard for inserting custom logic into Kimi Code CLI's lifecycle for security checks, code review, automation, and more.

## Overview

Agent Hooks uses a **modular directory** design: each hook is an independent folder containing configuration and scripts that the agent can automatically discover and execute at specific points in its lifecycle.

**Key Features:**

- **Open Standard**: Write once, use anywhere (cross-agent platform compatible)
- **Modular**: Each hook is independently managed, easy to share and reuse
- **Layered Configuration**: Supports user-level and project-level hooks with automatic merging
- **Simple and Transparent**: No hidden LLM calls
- **Fully Controllable**: You decide what language/tools to use
- **Sync/Async Options**: Default synchronous (blocking), optional asynchronous (non-blocking)

## Quick Start

### Directory Structure

```tree
~/.config/agents/hooks/           # User-level (XDG)
└── security-check/
    ├── HOOK.md                   # Hook metadata and configuration
    └── scripts/
        └── run.sh                # Executable script

./my-project/.agents/hooks/       # Project-level
└── project-specific/
    ├── HOOK.md
    └── scripts/
        └── run.sh
```

### HOOK.md Example

```markdown
---
name: block-dangerous-commands
description: Block dangerous shell commands like rm -rf /
trigger: before_tool
matcher:
  tool: Shell
  pattern: "rm -rf /|mkfs|dd if=/dev/zero"
timeout: 5000
async: false
priority: 999
---

# Block Dangerous Commands

This hook prevents execution of dangerous system commands.
```

### Script Example (scripts/run.sh)

```bash
#!/bin/bash
# Read event data from stdin
event_data=$(cat)

# Check for dangerous commands
tool_input=$(echo "$event_data" | grep -o '"command": "[^"]*"' | head -1 | cut -d'"' -f4)

if echo "$tool_input" | grep -qE "rm -rf /|mkfs|dd if=/dev/zero"; then
    echo "Dangerous command blocked: $tool_input" >&2
    exit 2  # Exit code 2 means block
fi

exit 0  # Exit code 0 means allow
```

## Configuration Locations

Agent Hooks supports **user-level** and **project-level** layered configuration:

### User-level Hooks

Applied to all projects (XDG compliant):

```
~/.config/agents/hooks/
```

### Project-level Hooks

Only applied within the current project:

```
./.agents/hooks/
```

### Loading Order

Hooks are loaded in the following order (later loaded hooks override earlier ones with the same name):

1. User-level hooks (`~/.config/agents/hooks/`)
2. Project-level hooks (`./.agents/hooks/`)

## Hook Configuration (HOOK.md)

### Frontmatter Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | string | Yes | - | Hook identifier (1-64 characters) |
| `description` | string | Yes | - | Hook description (1-1024 characters) |
| `trigger` | string | Yes | - | Trigger event type |
| `matcher` | object | No | - | Matching conditions |
| `timeout` | integer | No | 30000 | Timeout in milliseconds |
| `async` | boolean | No | false | Whether to execute asynchronously |
| `priority` | integer | No | 100 | Execution priority (0-1000) |

### Matcher

Used to filter hook trigger conditions, only applicable to tool-related events:

```yaml
---
name: block-dangerous-commands
trigger: before_tool
matcher:
  tool: "Shell"                          # Tool name regex match
  pattern: "rm -rf /|mkfs|>:/dev/sda"   # Parameter content regex match
---
```

| Field | Type | Description |
|-------|------|-------------|
| `tool` | string | Tool name regex (e.g., `Shell`, `WriteFile`) |
| `pattern` | string | Regex match for tool input parameters |

### Execution Modes

#### Synchronous Mode (Default)

```yaml
---
name: security-check
trigger: before_tool
async: false  # Default, can be omitted
---
```

**Characteristics:**
- Waits for hook to complete before continuing
- **Can block operations** (via exit code 2)
- Can modify input parameters
- Suitable for security checks, permission validation, and critical operations

#### Asynchronous Mode

```yaml
---
name: auto-format
trigger: after_tool
async: true
---
```

**Characteristics:**
- Returns immediately without waiting for hook completion
- **Cannot block operations**
- Suitable for formatting, notifications, logging, and non-critical operations

## Event Types and Blocking Capability

| Event Type | Trigger Timing | Blockable | Recommended Mode |
|-----------|---------------|-----------|------------------|
| `session_start` | When session starts | ✅ Can block | Sync |
| `session_end` | When session ends | ✅ Can block | Sync |
| `before_agent` | Before Agent execution | ✅ Can block | Sync |
| `after_agent` | After Agent execution | ✅ Can block | Sync |
| `before_tool` | Before tool execution | ✅ **Recommended** | **Sync** |
| `after_tool` | After tool execution | ✅ Can block | Sync |
| `after_tool_failure` | When tool execution fails | ✅ Can block | Sync |
| `subagent_start` | When subagent starts | ✅ Can block | Sync |
| `subagent_stop` | When subagent stops | ✅ Can block | Sync |
| `pre_compact` | Before context compaction | ✅ Can block | Sync |
| `before_stop` | Before Agent stops responding | ✅ **Quality Gate** | **Sync** |

## Command Protocol

### Input

Scripts receive JSON event information via **stdin**:

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

Scripts communicate with the Agent via **exit codes** and **output streams**:

| Output Stream | Description |
|---------------|-------------|
| **Exit Code** | Execution result signal |
| **stdout** | Machine-parseable JSON for control and communication |
| **stderr** | Human-readable text for errors and feedback |

### Exit Codes

| Exit Code | Meaning | Behavior |
|-----------|---------|----------|
| `0` | Success | Parse stdout JSON as result, operation continues |
| `2` | Block | **Block operation**, stderr content shown as feedback |
| Others | Exception | Log warning, allow operation to continue (Fail Open) |

### stdout (Control and Communication)

**Trigger Condition:** Only effective when Exit Code is `0` (success).

**Example:**
```bash
echo '{"decision": "allow", "log": "Command validated"}'
exit 0
```

### stderr (Errors and Feedback)

**Trigger Conditions:**
- Exit Code `2` (Block): stderr content shown to user as block reason
- Other non-zero exit codes: stderr used only for debugging/logging

**Example:**
```bash
echo "Dangerous command blocked: rm -rf / would destroy the system" >&2
exit 2
```

## Script Entry Points

Each hook must provide an executable script at a standard location:

| Priority | Entry Point | Description |
|----------|-------------|-------------|
| 1 | `scripts/run` | Extensionless executable file |
| 2 | `scripts/run.sh` | Shell script |
| 3 | `scripts/run.py` | Python script |

Scripts receive event data via stdin and use exit codes to signal results: 0 for allow, 2 for block.

## Examples

### Dangerous Command Blocking

**HOOK.md:**
```markdown
---
name: block-dangerous-commands
description: Block dangerous system commands like rm -rf /
trigger: before_tool
matcher:
  tool: Shell
  pattern: "rm -rf /|mkfs|dd if=/dev/zero"
timeout: 5000
priority: 999
---
```

**scripts/run.sh:**
```bash
#!/bin/bash
event_data=$(cat)
tool_input=$(echo "$event_data" | grep -o '"command": "[^"]*"' | head -1 | cut -d'"' -f4)

dangerous_patterns=("rm -rf /" "mkfs" "dd if=/dev/zero")
for pattern in "${dangerous_patterns[@]}"; do
    if echo "$tool_input" | grep -qE "\b${pattern}\b"; then
        echo "Dangerous command blocked: ${pattern} would destroy the system" >&2
        exit 2
    fi
done

exit 0
```

### Auto Code Formatting (Async)

**HOOK.md:**
```markdown
---
name: auto-format-python
description: Auto-format Python files after write
trigger: after_tool
matcher:
  tool: WriteFile
  pattern: "\.py$"
timeout: 30000
async: true
---
```

**scripts/run.sh:**
```bash
#!/bin/bash
black --quiet .
```

### Python Hook Script

**scripts/run.py:**
```python
#!/usr/bin/env python3
import json
import sys

def main():
    event = json.load(sys.stdin)
    tool_name = event.get("tool_name", "")
    tool_input = event.get("tool_input", {})
    
    if tool_name == "Shell":
        command = tool_input.get("command", "")
        
        dangerous = ["rm -rf /", "mkfs", "dd if=/dev/zero"]
        for pattern in dangerous:
            if pattern in command:
                print(f"Dangerous command detected: {pattern}", file=sys.stderr)
                sys.exit(2)
    
    print(json.dumps({"decision": "allow"}))
    sys.exit(0)

if __name__ == "__main__":
    main()
```

### Quality Gate Hook (before_stop)

**HOOK.md:**
```markdown
---
name: enforce-tests
description: Ensure tests pass before allowing task completion
trigger: before_stop
timeout: 60000
priority: 999
---
```

**scripts/run.sh:**
```bash
#!/bin/bash
# Run tests before allowing the agent to complete
if ! npm test 2>&1; then
    echo "Tests must pass before completing" >&2
    exit 2
fi
exit 0
```

When a `before_stop` hook blocks (exit 2), the Agent will continue working with the hook's feedback added to the context:

```
[Hook blocked stop: Tests must pass before completing]
```

## Configuration Priority and Execution Order

### Priority

- Range: 0 - 1000
- Default: 100
- Rule: **Higher numbers execute first**

```yaml
# Security checks execute first
priority: 999

# Regular notifications execute later
priority: 10
```

### Multiple Hook Execution Order

1. Sort by priority in descending order
2. Same priority: execute in configuration order
3. If any hook blocks, stop executing subsequent hooks

## Debugging

Use the `--debug` flag for detailed hook execution logs:

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
[HOOK DEBUG] [SYNC] Starting hook 'block-dangerous' for event 'before_tool'
[HOOK DEBUG] [SYNC] Completed hook 'block-dangerous' in 45ms: blocked=True
[HOOK DEBUG] Reason: Dangerous command blocked
```

## Best Practices

### 1. Choose Mode Based on Scenario

| Scenario | Recommended Mode | Reason |
|----------|-----------------|--------|
| Security check, permission validation | Sync | Need blocking capability |
| Code formatting | Async | No need to wait |
| Logging | Async | Doesn't affect performance |
| Notification | Async | Instant feedback |

### 2. Set Reasonable Timeouts

```yaml
# Quick check: 5 seconds
timeout: 5000

# Complex analysis: 60 seconds
timeout: 60000
```

### 3. Use Exit Code 2 for Force Block

When you need to ensure operation is blocked, use exit 2:

```bash
#!/bin/bash
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
try:
    if is_dangerous():
        sys.exit(2)
except Exception as e:
    print(f"Hook error: {e}", file=sys.stderr)
    print('{"decision": "allow"}')
    sys.exit(0)
```

### 5. Asynchronous Hook Notes

- Async hooks cannot modify input parameters
- Async hooks' `decision: deny` will be ignored
- Async hooks' stdout/stderr are used only for logging

## Installing Hooks

Copy hooks to user or project-level hooks directories:

```bash
# User-level (XDG)
cp -r /path/to/security-hook ~/.config/agents/hooks/

# Project-level
cp -r /path/to/security-hook .agents/hooks/
```

Add as git submodule to your project:

```bash
git submodule add https://github.com/yourorg/agenthooks.git .agents/hooks
```

## References

- [Agent Hooks Specification](../../../agenthooks/docs/en/SPECIFICATION.md) - Complete technical specification
- [Agent Hooks Guide](../../../agenthooks/docs/en/GUIDE.md) - Detailed usage guide
- [Agent Hooks Examples](../../../agenthooks/examples/) - Example hooks for common use cases
