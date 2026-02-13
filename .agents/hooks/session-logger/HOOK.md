---
name: session-logger
description: Log session start and end events for auditing and analytics
trigger: session_start
async: true
timeout: 10000
priority: 50
---

# Session Logger Hook

Logs session lifecycle events for auditing and analytics purposes.

## Behavior

This hook runs asynchronously at session start and end:
1. Logs session metadata (id, timestamp, work_dir)
2. Appends to a local log file
3. Does not block session operations

## Script

Entry point: `scripts/run.sh`

The script:
1. Reads session info from stdin (session_id, timestamp, work_dir, etc.)
2. Logs to `.agents/hooks/.logs/session.log`
3. Logs status to stderr

## Note

Since this hook runs asynchronously (`async: true`), it cannot block session operations. The log file is stored within the project directory for easy access.
