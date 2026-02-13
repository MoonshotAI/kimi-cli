# Kimi CLI Agent Hooks

This directory contains [Agent Hooks](https://github.com/yourorg/agenthooks) for dogfooding the hooks system in Kimi CLI.

## Hooks Overview

| Hook                       | Trigger         | Purpose                                            | Priority | Async |
| -------------------------- | --------------- | -------------------------------------------------- | -------- | ----- |
| `block-dangerous-commands` | `before_tool`   | Security hook that blocks dangerous shell commands | 999      | No    |
| `enforce-tests`            | `before_stop`   | Quality gate ensuring tests pass before completion | 999      | No    |
| `auto-format-python`       | `after_tool`    | Auto-formats Python files with black after write   | 100      | Yes   |
| `session-logger`           | `session_start` | Logs session start events                          | 50       | Yes   |
| `session-logger-end`       | `session_end`   | Logs session end events                            | 50       | Yes   |

## Quick Test

### Test Security Hook

```bash
# This should be blocked by the security hook (exit code 2)
echo '{"event_type":"before_tool","tool_name":"Shell","tool_input":{"command":"rm -rf /"}}' | .agents/hooks/block-dangerous-commands/scripts/run.sh
echo "Exit code: $?"  # Should be 2

# This should be allowed (exit code 0)
echo '{"event_type":"before_tool","tool_name":"Shell","tool_input":{"command":"ls -la"}}' | .agents/hooks/block-dangerous-commands/scripts/run.sh
echo "Exit code: $?"  # Should be 0
```

### Test Auto-Format Hook

```bash
# Create a poorly formatted Python file
cat > /tmp/test_format.py << 'EOF'
x=1+2
def foo( ):
    return x
EOF

# Run the hook
echo '{"event_type":"after_tool","tool_name":"WriteFile","tool_input":{"file_path":"/tmp/test_format.py"}}' | .agents/hooks/auto-format-python/scripts/run.sh

# Check the formatted file
cat /tmp/test_format.py
rm /tmp/test_format.py
```

### Test Session Logger

```bash
# Log a session start
echo '{"event_type":"session_start","session_id":"test-123","timestamp":"2024-01-15T10:30:00Z","work_dir":"'$(pwd)'"}' | .agents/hooks/session-logger/scripts/run.sh

# Log a session end
echo '{"event_type":"session_end","session_id":"test-123","duration_seconds":3600,"work_dir":"'$(pwd)'","exit_reason":"user_exit"}' | .agents/hooks/session-logger-end/scripts/run.sh

# Check the log
cat .agents/hooks/.logs/session.log
```

## Python API Test

```python
import asyncio
from kimi_cli.hooks import HookDiscovery, HookExecutor
from pathlib import Path

async def test():
    # Discover hooks
    discovery = HookDiscovery(Path('.').absolute())
    hooks = discovery.discover()
    print(f"Discovered {len(hooks)} hook(s)")

    # Get security hook
    security_hook = discovery.get_hook_by_name('block-dangerous-commands')

    # Test event
    event_data = {
        'event_type': 'before_tool',
        'timestamp': '2024-01-15T10:30:00Z',
        'session_id': 'test-123',
        'work_dir': str(Path('.').absolute()),
        'tool_name': 'Shell',
        'tool_input': {'command': 'rm -rf /'},
        'tool_use_id': 'tool_123'
    }

    # Execute hook
    executor = HookExecutor()
    result = await executor.execute(security_hook, event_data)
    print(f"Should block: {result.should_block}")
    print(f"Reason: {result.reason}")

asyncio.run(test())
```

## Dogfooding Goals

1. **Security**: Prevent accidental data loss from dangerous commands
2. **Code Quality**: Ensure consistent formatting and passing tests
3. **Audit**: Track session activity for analysis

## Configuration

Hooks are discovered from:

- Project-level: `./.agents/hooks/` (this directory)
- User-level: `~/.config/agents/hooks/`

See [AgentHooks Specification](../../agenthooks/docs/en/SPECIFICATION.md) for full details.

## CI Note

The `.logs/` directory is gitignored to prevent session logs from being committed.
