Start a subagent instance to work on a focused task.

The Agent tool can either create a new subagent instance or resume an existing one by `agent_id`.
Each instance keeps its own context history under the current session, so repeated use of the same
instance can preserve previous findings and work.

**Available Built-in Agent Types**

${BUILTIN_AGENT_TYPES_MD}

**Usage**

- Always provide a short `description` (3-5 words).
- Use `subagent_type` to select a built-in agent type. If omitted, `coder` is used.
- Use `model` when you need to override the built-in type's default model or the parent agent's current model.
- Use `resume` when you want to continue an existing instance instead of starting a new one.
- If an existing subagent already has relevant context or the task is a continuation of its prior work, prefer `resume` over creating a new instance.
- Default to foreground execution. Use `run_in_background=true` only when the task can continue independently, you do not need the result immediately, and there is a clear benefit to returning control before it finishes.
- Be explicit about whether the subagent should write code or only do research.
- The subagent result is only visible to you. If the user should see it, summarize it yourself.

**When Not To Use Agent**

- Reading a known file path
- Searching a small number of known files
- Tasks that can be completed in one or two direct tool calls
