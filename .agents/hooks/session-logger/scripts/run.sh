#!/bin/bash
# Session logger hook for Kimi CLI dogfooding

# Read event data from stdin
event_data=$(cat)

# Extract session info (handles both spaced and unspaced JSON)
session_id=$(echo "$event_data" | sed -n 's/.*"session_id":[[:space:]]*"\([^"]*\)".*/\1/p')
event_type=$(echo "$event_data" | sed -n 's/.*"event_type":[[:space:]]*"\([^"]*\)".*/\1/p')
work_dir=$(echo "$event_data" | sed -n 's/.*"work_dir":[[:space:]]*"\([^"]*\)".*/\1/p')
timestamp=$(echo "$event_data" | sed -n 's/.*"timestamp":[[:space:]]*"\([^"]*\)".*/\1/p')

# Create logs directory (use current dir if work_dir not found)
if [[ -z "$work_dir" ]]; then
    work_dir=$(pwd)
fi

log_dir="$work_dir/.agents/hooks/.logs"
mkdir -p "$log_dir"

log_file="$log_dir/session.log"

# Log the event
cat >> "$log_file" << EOF
[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] $event_type
  Session ID: ${session_id:-unknown}
  Work Dir: $work_dir
  Event Time: ${timestamp:-unknown}
---
EOF

# Log to stderr
echo "Session logged: ${session_id:-unknown} ($event_type)" >&2

exit 0
