<!-- markdownlint-disable MD060 -->

# Agent Hooks Specification

This document defines the complete specification for Agent Hooks format, including event types, execution modes, matchers, and recommended practices.

---

## 1. Event Types

Agent Hooks supports 10 event types across 5 categories:

### 1.1 Session Lifecycle

| Event | Trigger | Blocking | Recommended Mode |
|-------|---------|----------|------------------|
| `session_start` | Agent session starts | ✅ Yes | Sync |
| `session_end` | Agent session ends | ✅ Yes | Sync |

### 1.2 Agent Loop

| Event | Trigger | Blocking | Recommended Mode |
|-------|---------|----------|------------------|
| `before_agent` | Before agent processes user input | ✅ Yes | Sync |
| `after_agent` | After agent completes processing | ✅ Yes | Sync |
| `before_stop` | Before agent stops responding | ✅ **Quality Gate** | **Sync** |

### 1.3 Tool Interception (Core)

| Event | Trigger | Blocking | Recommended Mode |
|-------|---------|----------|------------------|
| `before_tool` | Before tool executes | ✅ **Recommended** | **Sync** |
| `after_tool` | After tool succeeds | ✅ Yes | Sync |
| `after_tool_failure` | After tool fails | ✅ Yes | Sync |

### 1.4 Subagent Lifecycle

| Event | Trigger | Blocking | Recommended Mode |
|-------|---------|----------|------------------|
| `subagent_start` | Subagent starts | ✅ Yes | Sync |
| `subagent_stop` | Subagent stops | ✅ Yes | Sync |

### 1.5 Context Management

| Event | Trigger | Blocking | Recommended Mode |
|-------|---------|----------|------------------|
| `pre_compact` | Before context compaction | ✅ Yes | Sync |

---

## 2. Output Protocol

### 2.1 Output Streams

Hook scripts communicate with the Agent through exit codes and output streams:

| Stream | Description |
|--------|-------------|
| **Exit Code** | Signal of execution result |
| **stdout** | Machine-parseable JSON for control and communication |
| **stderr** | Human-readable text for errors and feedback |

### 2.2 Exit Codes

| Exit Code | Meaning |
|-----------|---------|
| `0` | Execution succeeded, operation continues |
| `2` | Execution completed, operation blocked |
| Other | Execution failed, operation continues |

### 2.3 stdout (Control & Communication)

**Trigger condition:** Only effective when Exit Code is `0`.

**Purpose:** Transmit JSON configuration objects to instruct the Agent to allow, deny, modify input, or add context.

**Parsing:** The Agent will attempt to parse stdout as JSON.

Example:
```bash
# Return decision via stdout JSON
echo '{"decision": "allow", "log": "Command validated"}'
exit 0
```

### 2.4 stderr (Error & Feedback)

**Trigger conditions:**
- Exit Code `2` (Block): stderr content is displayed to the user as the block reason
- Other non-zero Exit Codes: stderr is treated as debug/logging text only

**Purpose:** Transmit error messages, rejection reasons, or debug logs.

**Parsing:** The Agent treats stderr as a plain text string.

Example:
```bash
echo "Dangerous command blocked: rm -rf / would destroy the system" >&2
exit 2
```

---

## 3. Execution Modes

### 3.1 Sync Mode (Default)

```yaml
---
name: security-check
trigger: before_tool
async: false # default, optional
---
```

**Characteristics:**

- Waits for hook to complete before continuing
- Can block operations (via exit code 2, with stderr as the reason)
- Can modify input parameters (via stdout JSON when exit code is 0)
- Suitable for security checks, permission validation, input verification

**Applicable Events:** All events (default)

### 3.2 Async Mode

```yaml
---
name: auto-format
trigger: after_tool
async: true
---
```

**Characteristics:**

- Returns immediately without waiting for hook completion
- Cannot block operations (exit code is ignored for blocking purposes)
- Cannot modify input parameters
- stdout and stderr are captured for logging/debugging only
- Suitable for formatting, notifications, logging, analysis

**Applicable Events:** All events (set `async: true` explicitly on any event if async execution is needed)

### 3.3 Mode Selection Decision Tree

```text
Need to block operation?
├── Yes → Sync mode
│       └── Output to stderr and exit with code 2
└── No → Async mode
        └── Need to wait for result?
            ├── Yes → Sync mode (use sparingly)
            └── No → Async mode (recommended)
```

---

## 4. Matcher

Matchers filter hook trigger conditions, applicable only to tool-related events.

### 4.1 Matcher Configuration

```yaml
---
name: block-dangerous-commands
trigger: before_tool
matcher:
  tool: "Shell" # Tool name regex
  pattern: "rm -rf /|mkfs|>:/dev/sda" # Parameter content regex
---
```

### 4.2 Matcher Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `tool` | string | No | Tool name regex (e.g., `Shell`, `WriteFile`, `ReadFile`) |
| `pattern` | string | No | Tool input parameter regex |

### 4.3 Matching Logic

- If `tool` is specified, only that tool triggers the hook
- If `pattern` is specified, only matching parameter content triggers
- If both are specified, **both must match**
- If neither is specified, hook triggers for all tools

### 4.4 Common Matcher Examples

```yaml
# Only intercept Shell tool
matcher:
  tool: "Shell"

# Intercept specific file type writes
matcher:
  tool: "WriteFile"
  pattern: "\.(py|js|ts)$"

# Intercept commands with sensitive keywords
matcher:
  tool: "Shell"
  pattern: "(rm -rf|mkfs|dd if=/dev/zero)"

# Intercept operations on specific directories
matcher:
  pattern: "/etc/passwd|/var/www"
```

---

## 5. Event Data Structure

Hook scripts receive JSON event data via **stdin**.

### 5.1 Base Event Fields

All events include these fields:

```json
{
  "event_type": "before_tool",
  "timestamp": "2024-01-15T10:30:00Z",
  "session_id": "sess-abc123",
  "work_dir": "/home/user/project",
  "context": {}
}
```

| Field | Type | Description |
|-------|------|-------------|
| `event_type` | string | Event type |
| `timestamp` | string | ISO 8601 timestamp |
| `session_id` | string | Session unique identifier |
| `work_dir` | string | Current working directory |
| `context` | object | Additional context |

### 5.2 Tool Events (before_tool / after_tool / after_tool_failure)

```json
{
  "event_type": "before_tool",
  "timestamp": "2024-01-15T10:30:00Z",
  "session_id": "sess-abc123",
  "work_dir": "/home/user/project",
  "tool_name": "Shell",
  "tool_input": {
    "command": "rm -rf /tmp/old-files"
  },
  "tool_use_id": "tool_123"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `tool_name` | string | Tool name (e.g., Shell, WriteFile) |
| `tool_input` | object | Tool input parameters |
| `tool_use_id` | string | Tool call unique identifier |

### 5.3 Subagent Events

```json
{
  "event_type": "subagent_start",
  "timestamp": "2024-01-15T10:30:00Z",
  "session_id": "sess-abc123",
  "work_dir": "/home/user/project",
  "subagent_name": "code-reviewer",
  "subagent_type": "coder",
  "task_description": "Review the authentication module"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `subagent_name` | string | Subagent name |
| `subagent_type` | string | Subagent type |
| `task_description` | string | Task description |

### 5.4 Session Events

**session_start:**

```json
{
  "event_type": "session_start",
  "timestamp": "2024-01-15T10:30:00Z",
  "session_id": "sess-abc123",
  "work_dir": "/home/user/project",
  "model": "kimi-latest",
  "args": {
    "ui": "shell",
    "agent": "default"
  }
}
```

**session_end:**

```json
{
  "event_type": "session_end",
  "timestamp": "2024-01-15T11:30:00Z",
  "session_id": "sess-abc123",
  "work_dir": "/home/user/project",
  "duration_seconds": 3600,
  "total_steps": 25,
  "exit_reason": "user_exit"
}
```

### 5.5 Stop Event (Quality Gate)

**before_stop:**

```json
{
  "event_type": "before_stop",
  "timestamp": "2024-01-15T10:35:00Z",
  "session_id": "sess-abc123",
  "work_dir": "/home/user/project",
  "stop_reason": "no_tool_calls",
  "step_count": 5,
  "final_message": {
    "role": "assistant",
    "content": "Task completed successfully"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `stop_reason` | string | Reason for stopping: `no_tool_calls`, `tool_rejected`, `max_steps` |
| `step_count` | integer | Number of steps taken in this turn |
| `final_message` | object | Assistant's final message (may be null) |

**Use Case: Quality Gates**

The `before_stop` event is designed for enforcing quality standards before allowing the agent to complete:

```yaml
---
name: enforce-tests
description: Ensure all tests pass before completing
trigger: before_stop
timeout: 60000
async: false
priority: 999
---
```

When a `before_stop` hook blocks (exit 2 or `decision: deny`), the agent receives the feedback and continues working instead of stopping. This creates a powerful quality gate mechanism.

---

## 6. Recommended Practices Summary

### 6.1 Recommended Usage by Event Type

| Event Type | Sync/Async | Recommended Use | Example Scenario |
|------------|------------|-----------------|------------------|
| `session_start` | Sync | Initialization, logging | Send session start notification, initialize environment |
| `session_end` | Sync | Cleanup, statistics, notifications | Generate session summary, send Slack notification |
| `before_agent` | Sync | Input validation, security checks | Filter sensitive words, input review |
| `after_agent` | Sync | Logging, analysis | Record response time, analyze output quality |
| `before_tool` | Sync | Security checks, interception | Block dangerous commands, permission validation |
| `after_tool` | Sync | Formatting, notifications | Auto-format code, send operation notifications |
| `after_tool_failure` | Sync | Error handling, retry | Log failure, send alerts |
| `subagent_start` | Sync | Resource limits, approval | Check concurrency limits, task approval |
| `subagent_stop` | Sync | Result validation, cleanup | Validate output quality, resource reclamation |
| `pre_compact` | Sync | Backup, analysis | Backup context, analyze compaction |
| `before_stop` | **Sync** | **Quality gates, completion criteria** | **Enforce tests pass, verify all tasks done** |

### 6.2 Common Hook Patterns

#### Pattern 1: Dangerous Operation Interception (Sync + Block)

```yaml
---
name: block-dangerous-commands
description: Blocks dangerous system commands
trigger: before_tool
matcher:
  tool: Shell
  pattern: "rm -rf /|mkfs|dd if=/dev/zero"
timeout: 5000
async: false
priority: 999
---
```

**Script Logic:**

```bash
# Check command content
echo "Dangerous command blocked: rm -rf / would destroy the system" >&2
exit 2
```

#### Pattern 2: Auto-formatting (Async)

```yaml
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

#### Pattern 3: Sensitive Operation Block (Sync)

```yaml
---
name: block-prod-deploy
description: Block production deployment operations
trigger: before_tool
matcher:
  tool: Shell
  pattern: "deploy.*prod|kubectl.*production"
timeout: 60000
async: false
---
```

**Script Logic:**

```bash
echo "This operation affects production environment and is not allowed" >&2
exit 2
```

#### Pattern 4: Session Audit Log (Async)

```yaml
---
name: audit-log
description: Log all session activities
trigger: session_end
async: true
---
```

#### Pattern 5: Quality Gate (Sync + before_stop)

```yaml
---
name: enforce-test-coverage
description: Ensure tests pass before allowing completion
trigger: before_stop
timeout: 120000
async: false
priority: 999
---
```

**Script Logic:**

```bash
#!/bin/bash
# enforce-quality.sh

# Read event data from stdin
event_data=$(cat)

# Check if tests pass
if ! npm test 2>&1; then
    echo "Tests must pass before completing" >&2
    exit 2
fi

# Check code formatting
if ! black --check . 2>&1; then
    echo "Code is not formatted. Run 'black .' first" >&2
    exit 2
fi

# All checks passed
exit 0
```

**Behavior:**

When this hook exits with code 2, the agent receives the stderr message as feedback and continues working instead of stopping. This creates a powerful enforcement mechanism for quality standards.

---

## 7. Configuration Priority and Execution Order

### 7.1 Priority

- Range: 0 - 1000
- Default: 100
- Rule: **Higher values execute first**

```yaml
# Security checks execute first
priority: 999

# Normal notifications execute later
priority: 10
```

### 7.2 Multi-Hook Execution Order

1. Sort by priority descending
2. Same priority executes in config order
3. First blocking hook stops remaining hooks

### 7.3 Async Hook Handling

- Async hooks run in parallel
- Does not wait for completion, does not collect results
- Failure does not affect main flow

---

## 8. Timeout and Error Handling

### 8.1 Timeout Configuration

- Default: 30000ms (30 seconds)
- Range: 100ms - 600000ms (10 minutes)

### 8.2 Timeout Behavior

- Timeout treated as hook failure
- **Fail Open** policy: operation continues
- Log warning

### 8.3 Error Handling Principles

| Scenario | Handling |
|----------|----------|
| Hook execution fails | Log warning, allow operation (Fail Open) |
| Hook returns invalid JSON (exit 0) | Log error, allow operation |
| Hook timeout | Log warning, allow operation |
| Exit code 2 | **Block operation**, stderr displayed to user |
| Other non-zero exit codes | Log as warning/debug only, allow operation |

---

## 9. Progressive Disclosure Design

Agent Hooks uses progressive disclosure design to optimize context usage:

| Level | Content | Size | Loading Time |
|-------|---------|------|--------------|
| **Metadata** | name, description, trigger | ~100 tokens | Load all hooks at startup |
| **Configuration** | Full HOOK.md content | < 1000 tokens | Load when event triggers |
| **Scripts** | Executable scripts | On demand | Execute after matching |

---

## 10. Complete Example

### 10.1 Directory Structure Example

```
~/.config/agents/             # User-level (XDG)
└── hooks/
    ├── security-check/
    │   ├── HOOK.md
    │   └── scripts/
    │       └── run.sh
    └── notify-slack/
        └── HOOK.md

./my-project/                 # Project-level
└── .agents/
    └── hooks/
        └── project-specific/
            └── HOOK.md
```

### 10.2 HOOK.md Example

````markdown
---
name: block-dangerous-commands
description: Blocks dangerous shell commands that could destroy data
trigger: before_tool
matcher:
  tool: Shell
  pattern: "rm -rf /|mkfs|dd if=/dev/zero|>:/dev/sda"
timeout: 5000
async: false
priority: 999
---

# Block Dangerous Commands

This hook prevents execution of dangerous system commands.

## Blocked Patterns

- `rm -rf /` - Recursive deletion of root
- `mkfs` - Filesystem formatting
- `dd if=/dev/zero` - Zeroing drives
- `>:/dev/sda` - Direct write to disk

## Exit Codes

- `0` - Command is safe, operation continues
- `2` - Command matches dangerous pattern, operation blocked

## Output

When blocking (exit code 2), outputs reason to stderr:

```
Dangerous command blocked: rm -rf / would destroy the system
```
````

### 10.3 Script Example (scripts/run.sh)

```bash
#!/bin/bash
# Block dangerous commands hook

# Read event data from stdin
event_data=$(cat)

# Extract command from event
tool_input=$(echo "$event_data" | grep -o '"command": "[^"]*"' | head -1 | cut -d'"' -f4)

# Dangerous patterns
dangerous_patterns=("rm -rf /" "mkfs" "dd if=/dev/zero")

for pattern in "${dangerous_patterns[@]}"; do
    if echo "$tool_input" | grep -qE "\b${pattern}\b"; then
        echo "Dangerous command blocked: ${pattern} would destroy the system" >&2
        exit 2
    fi
done

# Command is safe
exit 0
```

---

## Appendix: Field Reference

### HOOK.md Frontmatter Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | string | Yes | - | Hook identifier (1-64 chars) |
| `description` | string | Yes | - | Hook description (1-1024 chars) |
| `trigger` | string | Yes | - | Trigger event type |
| `matcher` | object | No | - | Matching conditions |
| `timeout` | integer | No | 30000 | Timeout in milliseconds |
| `async` | boolean | No | false | Execute asynchronously |
| `priority` | integer | No | 100 | Execution priority (0-1000) |
| `metadata` | object | No | - | Additional metadata |

### Matcher Fields

| Field | Type | Description |
|-------|------|-------------|
| `tool` | string | Tool name regex |
| `pattern` | string | Parameter content regex |
