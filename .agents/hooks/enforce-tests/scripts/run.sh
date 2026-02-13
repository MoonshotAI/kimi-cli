#!/bin/bash
# Enforce tests hook for Kimi CLI dogfooding
# Quality gate: ensures tests pass before allowing completion

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

echo "HOOK: Running quality gate checks..." >&2

# Check if there are test files
if [[ ! -d "tests" ]] && [[ ! -d "tests_e2e" ]] && [[ ! -d "tests_ai" ]]; then
    echo "HOOK: No tests directory found, skipping" >&2
    exit 0
fi

# Run only core unit tests (quick check)
# Exclude: e2e tests (slow, spawn subprocess), tools tests (shell, network), ai tests
echo "HOOK: Running quick unit tests only..." >&2
test_output=$(uv run pytest tests/core/ tests/utils/ -x -q --tb=short 2>&1)
test_exit=$?

if [[ $test_exit -ne 0 ]]; then
    echo "" >&2
    echo "╔══════════════════════════════════════════════════════════════════╗" >&2
    echo "║  QUALITY GATE BLOCKED: Tests must pass before completing         ║" >&2
    echo "╠══════════════════════════════════════════════════════════════════╣" >&2
    echo "$test_output" | tail -20 | sed 's/^/║  /' >&2
    echo "╚══════════════════════════════════════════════════════════════════╝" >&2
    echo "" >&2
    echo "Please fix the failing tests and try again." >&2
    exit 2
fi

echo "HOOK: All tests passed! Completion allowed." >&2
exit 0
