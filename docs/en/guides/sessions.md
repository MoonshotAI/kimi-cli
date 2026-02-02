# Sessions and context

Kimi Code CLI automatically saves your conversation history, making it easy to resume your work at any time.

## Session resumption

Each time you start Kimi Code CLI, a new session is created. If you want to continue a previous conversation, there are several ways:

**Continue the most recent session**

Use the `--continue` parameter to resume the most recent session in the current working directory:

```sh
kimi --continue
```

**Switch to a specific session**

Use the `--session` parameter to switch to a session with a specific ID:

```sh
kimi --session abc123
```

**Switch sessions during runtime**

Type `/sessions` (or `/resume`) to view a list of all sessions in the current working directory. Use the arrow keys to select the session you want to switch to:

```
/sessions
```

The list displays the title and last update time of each session to help you find the conversation you want to continue.

**Startup replay**

When you resume an existing session, Kimi Code CLI will replay the previous conversation history to help you quickly understand the context. During replay, previous messages and AI responses are displayed.

## Clearing and compaction

As the conversation progresses, the context becomes longer. Kimi Code CLI automatically compacts the context when needed to ensure the conversation can continue.

You can also use slash commands to manually manage the context:

**Clear context**

Type `/clear` to clear all context in the current session and start a new conversation:

```
/clear
```

After clearing, the AI will forget all previous conversation content. Usually you don't need this command; starting a new session is a better choice for new tasks.

**Compact context**

Type `/compact` to have the AI summarize the current conversation and replace the original context with the summary:

```
/compact
```

Compaction preserves key information while reducing token consumption. This is useful when the conversation is long but you want to retain some context.

::: tip Tip
The bottom status bar displays the current context usage (`context: xx%`) to help you understand when you need to clear or compact.
:::
