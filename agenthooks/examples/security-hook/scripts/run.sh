#!/bin/bash
# Block dangerous commands hook

# Read event data from stdin
event_data=$(cat)

# Extract command from event
tool_input=$(echo "$event_data" | grep -o '"command": "[^"]*"' | head -1 | cut -d'"' -f4)

# Check for dangerous patterns
dangerous_patterns=(
    "rm -rf /"
    "rm -rf /*"
    "mkfs"
    "dd if=/dev/zero"
    ">:/dev/sda"
    ">/dev/sda"
)

for pattern in "${dangerous_patterns[@]}"; do
    if echo "$tool_input" | grep -qE "\b${pattern}\b"; then
        echo "Dangerous command blocked: ${pattern} would destroy the system" >&2
        exit 2
    fi
done

exit 0
