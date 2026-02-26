# Example Hooks

This directory contains example Agent Hooks demonstrating various use cases.

## Available Examples

### security-hook

**Purpose:** Block dangerous system commands

**Trigger:** `before_tool`

**Features:**
- Blocks `rm -rf /`, `mkfs`, `dd if=/dev/zero`
- Synchronous execution (blocks if dangerous)
- High priority (999)

### notify-hook

**Purpose:** Send notifications when session ends

**Trigger:** `session_end`

**Features:**
- Asynchronous execution (non-blocking)
- Useful for logging/auditing
- Low priority (50)

### auto-format-hook

**Purpose:** Auto-format Python files after write

**Trigger:** `after_tool`

**Features:**
- Matches Python files (`.py` extension)
- Runs `black` formatter
- Asynchronous execution

## Using These Examples

Copy any example to your hooks directory:

```bash
# User-level (XDG)
cp -r security-hook ~/.config/agents/hooks/

# Project-level
cp -r security-hook .agents/hooks/
```

## Documentation

- [English Documentation](./README.md)
- [中文文档](./README.zh.md)

Then customize the `HOOK.md` and scripts as needed.
