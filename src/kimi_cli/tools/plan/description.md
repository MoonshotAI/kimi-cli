Use this tool when you are in plan mode and have finished writing your plan to the plan file and are ready for user approval.

## How This Tool Works
- You should have already written your plan to the plan file specified in the plan mode reminder.
- This tool does NOT take the plan content as a parameter — it reads the plan from the file you wrote.
- The user will see the contents of your plan file when they review it.

## When to Use
Only use this tool for tasks that require planning implementation steps. For research tasks (searching files, reading code, understanding the codebase), do NOT use this tool.

## Before Using
- If you have unresolved questions, use AskUserQuestion first.
- Once your plan is finalized, use THIS tool to request approval.
- Do NOT use AskUserQuestion to ask "Is this plan OK?" or "Should I proceed?" — that is exactly what ExitPlanMode does.
- If rejected, revise based on feedback and call ExitPlanMode again.
