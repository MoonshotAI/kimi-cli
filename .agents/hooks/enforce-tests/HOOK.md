---
name: enforce-tests
description: Ensure tests pass before allowing agent to complete (quality gate)
trigger: before_stop
timeout: 30000
async: false
priority: 999
---

# Enforce Tests Hook

Quality gate that ensures all tests pass before the agent is allowed to complete its work.

## Behavior

When the agent attempts to stop, this hook:
1. Runs the test suite using `make test`
2. If tests fail, blocks completion with feedback
3. If tests pass, allows completion to proceed

## Script

Entry point: `scripts/run.sh`

The script:
1. Detects the project type (Python with pytest)
2. Runs tests using `make test` or `pytest`
3. Exits with code 0 (allow) or 2 (block with feedback)

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
