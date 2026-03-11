Use this tool proactively when you're about to start a non-trivial implementation task.
Getting user sign-off on your approach before writing code prevents wasted effort.

**Prefer using EnterPlanMode** for implementation tasks unless they're simple.
Use it when ANY of these conditions apply:

1. New Feature Implementation — e.g. "Add a caching layer to the API"
2. Multiple Valid Approaches — e.g. "Optimize database queries" (indexing vs rewrite vs caching)
3. Code Modifications — e.g. "Refactor auth module to support OAuth"
4. Architectural Decisions — e.g. "Add WebSocket support"
5. Multi-File Changes — involves more than 2-3 files
6. Unclear Requirements — need exploration to understand scope
7. User Preferences Matter — if you'd use AskUserQuestion to clarify approach, use EnterPlanMode instead

When NOT to use:
- Single-line or few-line fixes (typos, obvious bugs, small tweaks)
- User gave very specific, detailed instructions
- Pure research/exploration tasks

## What Happens in Plan Mode
In plan mode, you will:
1. Explore the codebase using Glob, Grep, ReadFile (read-only)
2. Design an implementation approach
3. Write your plan to a plan file
4. Present your plan to the user via ExitPlanMode for approval
