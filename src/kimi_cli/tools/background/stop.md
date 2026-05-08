Stop a running background task.

Use this only when a background task must be cancelled. For normal task completion, prefer waiting for the automatic notification or using `TaskOutput`.

Guidelines:
- This is a generic task stop capability, not a bash-specific kill tool.
- Use it sparingly because stopping a task is destructive and may leave partial side effects.
- If the task is already complete, this tool will simply return its current state.
