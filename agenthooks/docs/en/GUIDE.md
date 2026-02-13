# Agent Hooks Guide

This guide covers hook discovery, installation, and usage.

## Hook Discovery

Agent Hooks supports both user-level and project-level hooks with automatic discovery and merging.

### Discovery Paths

#### User-Level Hooks

Applied to all projects (XDG-compliant):

1. `~/.config/agents/hooks/`

#### Project-Level Hooks

Applied only within the project:

1. `.agents/hooks/`

### Loading Priority

Hooks are loaded in this order (later overrides earlier for same name):

1. User-level hooks
2. Project-level hooks

## Directory Structure

```text
~/.config/agents/             # User-level (XDG)
└── hooks/
    ├── security/
    │   ├── HOOK.md
    │   └── scripts/
    │       └── run.sh
    └── logging/
        ├── HOOK.md
        └── scripts/
            └── run.sh

./my-project/
└── .agents/                  # Project-level
    └── hooks/
        └── project-specific/
            ├── HOOK.md
            └── scripts/
                └── run.sh
```

## Merging Behavior

When hooks have the same name:

- Project-level hook overrides user-level
- Warning is logged

When triggers have multiple hooks:

- Sorted by priority (descending)
- Async hooks run in parallel after sync hooks
- First blocking hook (exit code 2) stops remaining hooks

## Script Entry Point

Each hook must provide an executable script at a standard location:

| Priority | Entry Point | Description |
|----------|-------------|-------------|
| 1 | `scripts/run` | No extension, executable |
| 2 | `scripts/run.sh` | Shell script |
| 3 | `scripts/run.py` | Python script |

The script receives event data via stdin. Use exit codes to signal results: 0 for allow, 2 for block. stderr is shown to user when blocking.

## Configuration File (Optional)

An optional `hooks.toml` can specify additional options:

```toml
[hooks]
enabled = true
debug = false

[hooks.defaults]
timeout = 30000
async = false

# Disable specific hooks
[[hooks.disable]]
name = "verbose-logger"

# Override hook settings
[[hooks.override]]
name = "security-check"
priority = 999
```

## Installation Examples

Copy any example to your hooks directory:

```bash
# User-level (XDG)
cp -r security-hook ~/.config/agents/hooks/

# Project-level
cp -r security-hook .agents/hooks/
```

Then customize the `HOOK.md` and scripts as needed.

## Documentation

- [English Documentation](./GUIDE.md)
- [中文文档](./GUIDE.zh.md)
