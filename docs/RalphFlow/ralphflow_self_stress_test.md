# RalphFlow Self-Referential Stress Test

## Instructions for the Agent

You are executing a stress test for RalphFlow, Kimi Code CLI's automatic iteration system. This document contains multiple test scenarios requiring multi-step execution. Your job is to work through each scenario iteratively until completion.

**Important:** Do not stop after the first step of any scenario. Each scenario is designed to require 3-10 iterations. Continue until you genuinely believe the task is complete or you hit a safety limit.

Report your progress after each major step. Use the flow_decision tool to decide CONTINUE or STOP.

---

## Test Suite: "Operation SmokeTest"

### Scenario 1: The Infinite Refactor
**Task:** In the current project, find ALL functions that take more than 3 parameters and refactor them to use a config object or kwargs pattern.

**Steps:**
1. Search the codebase for functions with >3 parameters
2. For each function found, create a refactored version using a single `config` dict or `**kwargs`
3. Update all call sites to match the new signature
4. Run the test suite to verify nothing broke
5. If tests fail, fix the issues and re-run

**Expected iterations:** 5-8 (find → refactor → test → fix → re-test → verify)

---

### Scenario 2: The Whack-a-Mole Bug Hunt
**Task:** Run the full test suite. Every test that fails, fix it. Keep going until ALL tests pass or you've made 3 complete passes.

**Steps:**
1. Run `pytest` or equivalent test runner
2. For each failure, analyze the error
3. Fix the root cause (not the symptom)
4. Re-run tests
5. If new failures appear from your fixes, fix those too
6. Repeat until clean or max passes reached

**Expected iterations:** 3-6 (depends on cascade failures)

---

### Scenario 3: The Dependency Cascade
**Task:** Update a core utility function's return type from `dict` to a typed `dataclass`. Then fix EVERYTHING that breaks.

**Steps:**
1. Identify a heavily-used utility function returning a plain dict
2. Define a dataclass with the same fields
3. Update the function to return the dataclass instead
4. Find all call sites and update attribute access (e.g., `obj['key']` → `obj.key`)
5. Run type checker and tests
6. Fix any remaining issues

**Expected iterations:** 4-7 (change → find usages → update → test → fix edge cases)

---

### Scenario 4: The Documentation Drift
**Task:** Find all public functions/methods and ensure they have docstrings that match their actual signatures. Update any that are stale or missing.

**Steps:**
1. Find all public APIs (functions/classes not starting with `_`)
2. Check if they have docstrings
3. Verify docstring params match actual function signature
4. Update stale docs
5. Add missing docs
6. Run docstring linter if available

**Expected iterations:** 3-5 (scan → check → update → verify)

---

### Scenario 5: The Configuration Sprawl
**Task:** Find all hardcoded constants (magic numbers, strings, URLs) scattered in the codebase. Centralize them into a single config module.

**Steps:**
1. Scan for magic numbers (exclude 0, 1, -1, common iterables)
2. Scan for hardcoded URLs, file paths, timeouts
3. Create or update a `config.py` or `constants.py`
4. Replace each hardcoded value with the config import
5. Verify tests still pass

**Expected iterations:** 4-6 (find → define constants → replace → test → fix imports)

---

## Edge Case Stressors

### Scenario 6: The Ambiguous Request
**Task:** "Make the code better."

This is intentionally vague. Your job is to:
1. Identify what "better" means in this codebase (faster? cleaner? more typed?)
2. Pick ONE concrete improvement
3. Execute it fully
4. Explain what you chose and why

**Watch for:** Does RalphFlow handle ambiguity by asking clarifying questions or making reasonable assumptions?

---

### Scenario 7: The Contradictory Instructions
**Task:** "Add comprehensive logging to every function in module X, then remove all logging to improve performance."

Steps:
1. Add logging to module X
2. Verify it works
3. Now remove all that logging
4. Verify performance improvement (or at least no regression)

**Watch for:** Does RalphFlow detect the contradiction? Does it execute both or question the logic?

---

### Scenario 8: The Giant Refactor
**Task:** "Convert all sync I/O in the project to async/await."

Steps:
1. Identify all blocking I/O operations
2. Convert functions to async
3. Update all callers to await
4. Update tests to be async
5. Run full test suite
6. Fix cascade failures

**Expected iterations:** 8-15 (this is the big one — tests context depth and convergence)

---

## Verification Checklist

After completing as many scenarios as possible, verify:

- [ ] Did you iterate automatically without manual re-prompting?
- [ ] Did you STOP appropriately when tasks were complete?
- [ ] Did you CONTINUE when more work was needed?
- [ ] Did you ever loop indefinitely without progress?
- [ ] Did context stay clean (main thread not polluted)?
- [ ] Did you handle errors gracefully?
- [ ] How many total iterations across all scenarios?

---

## Report Template

At the end, produce a summary:

```
RALPHFLOW STRESS TEST REPORT
============================
Scenarios Attempted: [N]
Scenarios Completed: [N]
Total Iterations: [N]
Average Iterations per Scenario: [N]
Convergence Events (auto-stop): [N]
Safety Limit Hits: [N]
Errors Encountered: [N]
Context Compactions During Flow: [N]

Observations:
- [What worked well]
- [What broke]
- [Where it got stuck]
- [Surprising behavior]
```

---

## Success Criteria

This document IS the test. If RalphFlow can:
1. Read this entire document
2. Execute multiple scenarios iteratively
3. Self-direct through ambiguous and complex tasks
4. Produce a final report

...then it's working as designed.

**If it stops after the first scenario, that's a failure.**
**If it loops forever on Scenario 6 without converging, that's a failure.**
**If it completes all scenarios and reports results, that's a pass.**

---

*Begin execution. Continue until complete. Don't stop early.*
