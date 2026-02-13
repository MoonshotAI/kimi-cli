#!/bin/bash
# Block dangerous commands hook for Kimi CLI dogfooding

# Read event data from stdin
event_data=$(cat)

# Extract command from event (handles both spaced and unspaced JSON)
tool_input=$(echo "$event_data" | sed -n 's/.*"command":[[:space:]]*"\([^"]*\)".*/\1/p')

# Also try alternative extraction if empty
if [[ -z "$tool_input" ]]; then
    tool_input=$(echo "$event_data" | grep -o '"command"[^,}]*' | head -1 | sed 's/.*://; s/["{}]//g; s/^[[:space:]]*//')
fi

# Check for dangerous patterns
dangerous_patterns=(
    "rm -rf /[^a-zA-Z]"
    "rm -rf /$"
    "rm -rf /\*"
    "mkfs"
    "dd if=/dev/zero"
    ">:/dev/sda"
    ">/dev/sda"
)

for pattern in "${dangerous_patterns[@]}"; do
    if echo "$tool_input" | grep -qE "$pattern"; then
        echo "Dangerous command blocked: '$tool_input' matches dangerous pattern" >&2
        exit 2
    fi
done

exit 0
