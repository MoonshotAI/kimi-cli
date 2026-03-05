---
name: session-logger-end
description: Log session end events for auditing and analytics
trigger: post-session
async: false
timeout: 10000
priority: 50
---

# Session Logger End Hook

Logs session end events for auditing and analytics purposes.

## Behavior

This hook runs asynchronously at session end:

1. Logs session metadata (id, duration, total_steps, exit_reason)
2. Appends to a local log file
3. Does not block session termination

## Script

Entry point: `scripts/run.sh`

The script:

1. Reads session info from stdin
2. Logs to `.agents/hooks/.logs/session.log`
3. Logs status to stderr

## Note

Since this hook runs asynchronously (`async: false`), it cannot block session termination.
