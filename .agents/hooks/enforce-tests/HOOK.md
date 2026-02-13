---
name: enforce-tests
description: Check tests exist but does NOT run them (avoid blocking agent)
trigger: before_stop
timeout: 15000
async: false
priority: 999
---

# Enforce Tests Hook

Quality gate that ensures core unit tests pass before the agent is allowed to complete its work.

## Behavior

When the agent attempts to stop, this hook:
1. Runs only core unit tests (`tests/core/` and `tests/utils/`)
2. Explicitly excludes e2e, tools, UI, AI, and integration tests
3. If tests fail, blocks completion with feedback
4. If tests pass, allows completion to proceed

## Script

Entry point: `scripts/run.sh`

The script:

1. Detects the project type (Python with pytest)
2. Runs ONLY `tests/core/` and `tests/utils/` with `--ignore` for other directories
3. Excludes: `tests/e2e/`, `tests/tools/`, `tests/ui_and_conv/`, `tests_e2e/`, `tests_ai/`
4. Exits with code 0 (allow) or 2 (block with feedback)
5. Timeout: 15 seconds

## Quality Gate Pattern

This hook uses the `before_stop` event to implement a quality gate:
- If tests fail, the agent receives the error message and continues working
- This ensures code quality standards are met before completion

## Exit Codes

- `0` - All tests pass, completion allowed
- `2` - Tests failed, completion blocked with feedback

## Output

When blocking (exit code 2), outputs test failures to stderr:

```
Tests must pass before completing:
FAILED tests/test_example.py::test_function - assertion error
```
