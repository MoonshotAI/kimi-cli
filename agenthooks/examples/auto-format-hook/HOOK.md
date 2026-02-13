---
name: auto-format-python
description: Automatically format Python files after they are written using black
trigger: after_tool
matcher:
  tool: WriteFile
  pattern: "\\.py$"
timeout: 30000
async: true
priority: 100
---

# Auto Format Python Hook

Automatically formats Python files using `black` after they are written.

## Behavior

When a Python file is written (`.py` extension), this hook:
1. Runs `black` on the file
2. Logs the result to stderr
3. Does not block (runs asynchronously)

## Script

Entry point: `scripts/run.sh`

The script:
1. Extracts `file_path` from the tool input
2. Checks if it's a Python file
3. Runs `black --quiet` if available
4. Logs result to stderr

## Requirements

- `black` must be installed: `pip install black`

## Note

This hook runs asynchronously so it doesn't slow down the agent's workflow. Formatting happens in the background.
