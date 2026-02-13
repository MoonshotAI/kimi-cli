#!/bin/bash
# Session notification hook
# Sends notification when agent session ends

# Read event data from stdin
event_data=$(cat)

# Extract session info
session_id=$(echo "$event_data" | grep -o '"session_id": "[^"]*"' | head -1 | cut -d'"' -f4)
duration=$(echo "$event_data" | grep -o '"duration_seconds": [0-9]*' | head -1 | cut -d' ' -f2)
work_dir=$(echo "$event_data" | grep -o '"work_dir": "[^"]*"' | head -1 | cut -d'"' -f4)

# Log to file
log_file="/tmp/agent-session.log"
timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

cat >> "$log_file" << EOF
[$timestamp] Session ended
  Session ID: $session_id
  Duration: ${duration}s
  Work Dir: $work_dir
---
EOF

# Log to stderr
echo "Session logged: $session_id" >&2

exit 0
