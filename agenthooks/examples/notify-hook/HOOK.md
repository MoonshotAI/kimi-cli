---
name: session-notify
description: Send notification when session ends with summary of work completed
trigger: session_end
async: true
timeout: 10000
priority: 50
---

# Session Notification Hook

Sends a notification when an agent session ends.

## Behavior

This hook runs asynchronously after the session ends. It does not block session termination.

## Script

Entry point: `scripts/run.sh`

The script:
1. Reads session info from stdin (session_id, duration_seconds, work_dir)
2. Logs session end to `/tmp/agent-session.log`
3. Logs status to stderr

## Use Cases

- Log session activity for auditing
- Send notifications to Slack/Discord
- Update time tracking systems
- Generate session summaries

## Note

Since this hook runs asynchronously (`async: true`), it cannot block session termination.
