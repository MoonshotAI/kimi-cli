# Hooks Configuration

Hooks allow you to inject custom logic into Kimi Code CLI's lifecycle for security checks, code reviews, automation workflows, and more.

## Overview

Kimi Code CLI supports three types of hooks:

1. **Command** - Execute external commands or scripts
2. **Prompt** - Use LLM for intelligent decision making
3. **Agent** - Spawn subagents for complex validation

## Configuration Location

Hooks are configured in the `[hooks]` section of `~/.kimi/config.toml`:

```toml
[hooks]
# Execute when session starts
session_start = [
    { type = "command", name = "notify-start", command = "notify-send 'Kimi session started'" }
]

# Intercept before tool execution
before_tool = [
    { type = "prompt", name = "security-check", matcher = { tool = "Shell" }, prompt = "..." }
]
```

## Hook Types

### Command Hooks

Execute shell commands with event information as JSON input:

```toml
[[hooks.before_tool]]
name = "custom-validator"
type = "command"
matcher = { tool = "Shell" }
command = "python /path/to/validator.py"
timeout = 30000  # milliseconds
```

Exit codes meaning:
- `0` - Success, parse stdout as result
- `2` - Blocking error (system block)
- Others - Non-blocking error (warning)

Output format (JSON):
```json
{
    "decision": "allow" | "deny" | "ask",
    "reason": "explanation",
    "additional_context": "extra information"
}
```

### Prompt Hooks

Use LLM for intelligent analysis of events:

```toml
[[hooks.before_tool]]
name = "ai-security-check"
type = "prompt"
matcher = { tool = "Shell" }
prompt = """
Determine if the following Shell command is safe:
Command: {{tool_input.command}}

If the command may destroy data or system, return:
{"decision": "deny", "reason": "reason"}

Otherwise return:
{"decision": "allow"}
"""
temperature = 0.1  # Control randomness
```

Configuration options:
- `prompt` - Prompt template with `{{variable}}` syntax support
- `system_prompt` - Optional system prompt override
- `model` - Model to use (defaults to session model)
- `temperature` - Sampling temperature (0.0-2.0, default 0.1)

Available template variables depend on event type:
- `event_type` - Event type
- `session_id` - Session ID
- `work_dir` - Working directory
- `tool_input` - Tool input (tool events)
- `tool_name` - Tool name (tool events)

### Agent Hooks

Spawn subagents for complex validation tasks:

```toml
[[hooks.after_tool]]
name = "test-analyzer"
type = "agent"
matcher = { tool = "Shell", pattern = "pytest" }
task = """
Analyze test results and if there are failed tests:
1. Identify the failure reasons
2. Provide fix suggestions
3. Return a concise summary

Context:
Event type: {{event_type}}
Tool output: {{tool_output}}
"""
timeout = 120000  # 2 minutes
```

Configuration options:
- `task` - Task description for the subagent
- `agent_file` - Optional custom agent configuration file
- `timeout` - Timeout in milliseconds (default 2 minutes)

## Event Types

| Event Type | Trigger Timing | Available Variables |
|-----------|---------------|---------------------|
| `session_start` | When session starts | `model`, `args` |
| `session_end` | When session ends | `duration_seconds`, `total_steps`, `exit_reason` |
| `before_agent` | Before agent execution | - |
| `after_agent` | After agent execution | - |
| `before_tool` | Before tool execution | `tool_name`, `tool_input`, `tool_use_id` |
| `after_tool` | After tool execution | `tool_name`, `tool_input`, `tool_output` |
| `after_tool_failure` | When tool execution fails | `tool_name`, `tool_input`, `error` |
| `subagent_start` | When subagent starts | `subagent_name`, `subagent_type`, `task_description` |
| `subagent_stop` | When subagent stops | `subagent_name`, `exit_reason` |
| `pre_compact` | Before context compaction | `context_tokens` |

## Matcher Configuration

Use matchers to filter hook execution:

```toml
# Match specific tool
matcher = { tool = "Shell" }

# Use regex to match tool name
matcher = { tool = "Read.*" }

# Match argument content
matcher = { pattern = "rm -rf /" }

# Combined matching
matcher = { tool = "Shell", pattern = "dangerous_command" }
```

## Debugging Hooks

Use the `--debug-hooks` flag to enable detailed logging:

```bash
kimi --debug-hooks
```

Log content includes:
- Trigger events for each hook
- Execution duration
- Decision results and reasons
- Error messages

Logs are saved to `~/.kimi/logs/kimi.log`.

## Examples

### Pre-commit Check

```toml
[[hooks.before_tool]]
name = "pre-commit-check"
type = "command"
matcher = { tool = "Shell", pattern = "git commit" }
command = "pre-commit run --files $(git diff --cached --name-only)"
```

### Code Formatting

```toml
[[hooks.after_tool]]
name = "auto-format"
type = "command"
matcher = { tool = "WriteFile", pattern = "\\.py$" }
command = "black {{tool_input.path}}"
async = true  # Execute asynchronously, non-blocking
```

### Dangerous Command Confirmation

```toml
[[hooks.before_tool]]
name = "dangerous-command-check"
type = "prompt"
matcher = { tool = "Shell", pattern = "rm|drop|delete" }
prompt = """
Analyze if the following command poses risks:
{{tool_input.command}}

If it's a dangerous operation (e.g., deleting important files, clearing database), return:
{"decision": "ask", "reason": "description of potential danger"}

Otherwise return:
{"decision": "allow"}
"""
```

### Sensitive Information Detection

```toml
[[hooks.before_tool]]
name = "secret-detection"
type = "prompt"
matcher = { tool = "WriteFile" }
prompt = """
Check if the following content contains sensitive information (API keys, passwords, private keys):

File path: {{tool_input.path}}
Content preview: {{tool_input.content[:500]}}

If sensitive information is detected, return:
{"decision": "deny", "reason": "Detected sensitive information: xxx"}

Otherwise return:
{"decision": "allow"}
"""
```

### Test Auto-analysis

```toml
[[hooks.after_tool]]
name = "test-analysis"
type = "agent"
matcher = { tool = "Shell", pattern = "pytest|unittest" }
task = """
Analyze test results and provide feedback:

Command output:
{{tool_output}}

Please:
1. Count passed/failed tests
2. If failures exist, analyze the reasons
3. Provide fix suggestions

Return format:
{"decision": "allow", "additional_context": "your analysis"}
"""
```

## Best Practices

1. **Set reasonable timeouts**: Avoid hooks blocking the main flow for too long
2. **Use async execution**: For non-critical operations, use `async = true`
3. **Write clear prompts**: Prompt hook effectiveness depends on prompt quality
4. **Enable gradually**: Test hooks in development before applying to production
5. **Record decision reasons**: Helps with auditing and debugging
