# Sessions and Context

Kimi Code CLI automatically saves your conversation history, allowing you to continue previous work at any time.

## Session resuming

Each time you start Kimi Code CLI, a new session is created. While running, you can also enter the `/new` command to create and switch to a new session at any time, without exiting the program.

If you want to continue a previous conversation, there are several ways:

**Continue the most recent session**

Use the `--continue` flag to continue the most recent session in the current working directory:

```sh
kimi --continue
```

**Switch to a specific session**

Use the `--session` flag to switch to a session with a specific ID:

```sh
kimi --session abc123
```

**Switch sessions during runtime**

Enter `/sessions` (or `/resume`) to view all sessions in the current working directory, and use arrow keys to select the session you want to switch to:

```
/sessions
```

The list shows each session's title and last update time, helping you find the conversation you want to continue.

**Startup replay**

When you continue an existing session, Kimi Code CLI will replay the previous conversation history so you can quickly understand the context. During replay, previous messages and AI responses will be displayed.

## Session state persistence

In addition to conversation history, Kimi Code CLI also automatically saves and restores the session's runtime state. When you resume a session, the following states are automatically restored:

- **Approval decisions**: YOLO mode on/off status, operation types approved via "allow for this session"
- **Dynamic subagents**: Subagent definitions created via the `CreateSubagent` tool during the session
- **Additional directories**: Workspace directories added via `--add-dir` or `/add-dir`

This means you don't need to reconfigure these settings each time you resume a session. For example, if you approved auto-execution of certain shell commands in your previous session, those approvals remain in effect after resuming.

## Clear and compact

As the conversation progresses, the context grows longer. Kimi Code CLI will automatically compress the context when needed to ensure the conversation can continue.

You can also manually manage the context using slash commands:

**Clear context**

Enter `/clear` to clear all context in the current session and start a fresh conversation:

```
/clear
```

After clearing, the AI will forget all previous conversation content. You usually don't need to use this command; for new tasks, starting a new session is a better choice.

**Compact context**

Enter `/compact` to have the AI summarize the current conversation and replace the original context with the summary:

```
/compact
```

Compacting preserves key information while reducing token consumption. This is useful when the conversation is long but you still want to retain some context.

::: tip
The bottom status bar displays the current context usage (`context: xx%`), helping you understand when you need to clear or compact.
:::

::: tip
`/clear` and `/reset` clear the conversation context but do not reset session state (such as approval decisions, dynamic subagents, and additional directories). To start completely fresh, it's recommended to create a new session.
:::
