#!/bin/bash
# Session logger end hook for Kimi CLI dogfooding

# Read event data from stdin
event_data=$(cat)

# Extract session info (handles both spaced and unspaced JSON)
session_id=$(echo "$event_data" | sed -n 's/.*"session_id":[[:space:]]*"\([^"]*\)".*/\1/p')
duration=$(echo "$event_data" | sed -n 's/.*"duration_seconds":[[:space:]]*\([0-9]*\).*/\1/p')
work_dir=$(echo "$event_data" | sed -n 's/.*"work_dir":[[:space:]]*"\([^"]*\)".*/\1/p')
exit_reason=$(echo "$event_data" | sed -n 's/.*"exit_reason":[[:space:]]*"\([^"]*\)".*/\1/p')

# Create logs directory (use current dir if work_dir not found)
if [[ -z "$work_dir" ]]; then
    work_dir=$(pwd)
fi

log_dir="$work_dir/.agents/hooks/.logs"
mkdir -p "$log_dir"

log_file="$log_dir/session.log"

# Log the event
cat >> "$log_file" << EOF
[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] session_end
  Session ID: ${session_id:-unknown}
  Work Dir: $work_dir
  Duration: ${duration:-unknown}s
  Exit Reason: ${exit_reason:-unknown}
---
EOF

# Log to stderr
echo "Session end logged: ${session_id:-unknown} (duration: ${duration:-unknown}s)" >&2

exit 0
