Update the status of the active goal.

This tool is used to mark a goal as complete when the objective has been fully achieved. The model should only call this tool after verifying that all requirements of the goal have been satisfied.

**Usage:**
- Call with `status: "complete"` to mark the active goal as finished.
- Do not call this tool unless the goal is actually complete.
- Do not mark a goal complete merely because the budget is nearly exhausted or because you are stopping work.

If no goal is active, this tool will return an error.
