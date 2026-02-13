# Agent Hooks

[Agent Hooks](https://github.com/yourorg/agenthooks) is an open format for defining event-driven hooks for AI agents. Hooks allow you to intercept, modify, or react to agent lifecycle events.

Hooks are folders containing executable scripts and configuration that agents can discover and execute at specific points in their lifecycle. Write once, use everywhere.

## Getting Started

- [Specification](./docs/en/SPECIFICATION.md) - Complete format specification
- [Guide](./docs/en/GUIDE.md) - Hook discovery and usage guide
- [Examples](./examples/) - Example hooks for common use cases
- [Hooks Reference](./hooks-ref/) - Reference implementation library (CLI & Python API)

## Overview

Agent Hooks enable you to:

- **Intercept tool calls** - Block or modify tool execution (e.g., prevent dangerous commands)
- **React to lifecycle events** - Run code when sessions start/end or agents activate
- **Enforce policies** - Ensure compliance with team standards
- **Automate workflows** - Trigger actions after specific events

## Quick Example

```
block-dangerous-commands/
├── HOOK.md           # Hook metadata and configuration
└── scripts/
    └── check.sh      # Executable script
```

**HOOK.md:**

```markdown
---
name: block-dangerous-commands
description: Blocks dangerous shell commands like rm -rf /
trigger: before_tool
matcher:
  tool: Shell
  pattern: "rm -rf /|mkfs|dd if=/dev/zero"
---

# Block Dangerous Commands

This hook prevents execution of dangerous system commands.

## Behavior

When triggered, this hook will:
1. Check if the command matches dangerous patterns
2. Block execution with exit code 2 if matched
3. Log the attempt for audit purposes
```

## Installation

Add as a git submodule to your project:

```bash
git submodule add https://github.com/yourorg/agenthooks.git .agents/hooks
```

Or create your own hooks directory:

```bash
mkdir -p ~/.config/agents/hooks/    # User-level (XDG)
# or
mkdir -p .agents/hooks/             # Project-level
```

## Supported Platforms

Agent Hooks is supported by:

- [Kimi Code CLI](https://github.com/moonshotai/kimi-cli)
- [Claude Code](https://github.com/anthropics/claude-code) (planned)
- [Codex](https://github.com/openai/codex) (planned)

## Documentation

- [English Documentation](./README.md)
- [中文文档](./README.zh.md)

## License

Apache 2.0 - See [LICENSE](./LICENSE)
