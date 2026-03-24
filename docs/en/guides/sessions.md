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
- **Plan mode**: Plan mode on/off status
- **Subagent instances**: Subagent instance state and context history created via the `Agent` tool during the session
- **Additional directories**: Workspace directories added via `--add-dir` or `/add-dir`

This means you don't need to reconfigure these settings each time you resume a session. For example, if you approved auto-execution of certain shell commands in your previous session, those approvals remain in effect after resuming.

## Export and import

Kimi Code CLI supports exporting session context to a file, or importing context from external files and other sessions.

**Export a session**

Enter `/export` to export the current session's complete conversation history as a Markdown file:

```
/export
```

The exported file includes session metadata, a conversation overview, and the complete conversation organized by turns. You can also specify an output path:

```
/export ~/exports/my-session.md
```

**Import context**

Enter `/import` to import context from a file or another session. The imported content is appended as reference information to the current session:

```
/import ./previous-session-export.md
/import abc12345
```

Common text-based file formats are supported (Markdown, source code, configuration files, etc.). You can also pass a session ID to import the complete conversation history from that session.

::: tip
Exported files may contain sensitive information (such as code snippets, file paths, etc.). Please review before sharing.
:::

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

You can also append custom instructions after the command to tell the AI what content to prioritize preserving during compaction:

```
/compact keep the database-related discussion
```

Compacting preserves key information while reducing token consumption. This is useful when the conversation is long but you still want to retain some context.

::: tip
The bottom status bar displays the current context usage with token counts (e.g., `context: 42.0% (4.2k/10.0k)`), helping you understand when you need to clear or compact.
:::

::: tip
`/clear` and `/reset` clear the conversation context but do not reset session state (such as approval decisions, dynamic subagents, and additional directories). To start completely fresh, it's recommended to create a new session.
:::
