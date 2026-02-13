---
name: block-dangerous-commands
description: Blocks dangerous shell commands like rm -rf /, mkfs, and dd operations that could destroy data
trigger: before_tool
matcher:
  tool: Shell
  pattern: "rm -rf /|mkfs|dd if=/dev/zero|>:/dev/sda"
timeout: 5000
async: false
priority: 999
---

# Block Dangerous Commands

This hook prevents execution of dangerous system commands that could cause irreversible data loss or system damage.

## Behavior

When triggered, this hook will:
1. Check if the command matches dangerous patterns
2. Block execution with exit code 2 if matched
3. Log the attempt for audit purposes

## Script

Entry point: `scripts/run.sh`

The script:
1. Reads event data from stdin
2. Extracts the command from `tool_input.command`
3. Checks against dangerous patterns
4. Exits with code 0 (allow) or 2 (block)

## Blocked Patterns

- `rm -rf /` - Recursive deletion of root
- `mkfs` - Filesystem formatting
- `dd if=/dev/zero` - Zeroing drives
- `>:/dev/sda` - Direct write to disk

## Exit Codes

- `0` - Command is safe, operation continues
- `2` - Command matches dangerous pattern, operation **blocked**

## Output

When blocking (exit code 2), outputs reason to stderr:

```
Dangerous command blocked: rm -rf / would destroy the system
```
