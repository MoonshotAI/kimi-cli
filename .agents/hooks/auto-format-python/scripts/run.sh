#!/bin/bash
# Auto-format Python files after write for Kimi CLI dogfooding

# Read event data
event_data=$(cat)

# Extract file path (handles both spaced and unspaced JSON)
tool_input=$(echo "$event_data" | sed -n 's/.*"file_path":[[:space:]]*"\([^"]*\)".*/\1/p')

# Also try alternative extraction if empty
if [[ -z "$tool_input" ]]; then
    tool_input=$(echo "$event_data" | grep -o '"file_path"[^,}]*' | head -1 | sed 's/.*://; s/["{}]//g; s/^[[:space:]]*//')
fi

# Check if it's a Python file
if [[ "$tool_input" == *.py ]]; then
    # Check if black is available
    if command -v black &> /dev/null; then
        # Run black quietly
        if black --quiet "$tool_input" 2>/dev/null; then
            echo "HOOK: Formatted $tool_input with black" >&2
        else
            echo "HOOK: Failed to format $tool_input" >&2
        fi
    else
        echo "HOOK: black not installed, skipping format" >&2
    fi
fi

exit 0
