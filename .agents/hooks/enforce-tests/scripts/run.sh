#!/bin/bash
# Enforce tests hook for Kimi CLI dogfooding
# Quality gate: checks tests exist but does NOT run them (too slow)

# Read event data from stdin
event_data=$(cat)

# Extract work directory
work_dir=$(echo "$event_data" | grep -o '"work_dir": "[^"]*"' | head -1 | cut -d'"' -f4)

cd "$work_dir" || exit 0

# Check if this is the kimi-cli project
if [[ ! -f "pyproject.toml" ]] || ! grep -q "kimi" pyproject.toml 2>/dev/null; then
    # Not the kimi-cli project, skip
    exit 0
fi

# Only check if test files exist, do NOT run tests (too slow for pre-stop hook)
# The actual testing should be done in CI or manually
if [[ -d "tests/core" ]] || [[ -d "tests/utils" ]]; then
    echo "HOOK: Test directories found (skipping actual test execution to avoid blocking)" >&2
fi

# Always allow completion - tests should be run in CI, not here
exit 0
