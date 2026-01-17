# Sessions and Context

Gitrekt CLI automatically saves your conversation history, allowing you to continue previous work at any time.

## Session resuming

Each time you start Gitrekt CLI, a new session is created. If you want to continue a previous conversation, there are several ways:

**Continue the most recent session**

Use the `--continue` flag to continue the most recent session in the current working directory:

```sh
Gitrekt --continue
```

**Switch to a specific session**

Use the `--session` flag to switch to a session with a specific ID:

```sh
Gitrekt --session abc123
```

**Switch sessions during runtime**

Enter `/sessions` (or `/resume`) to view all sessions in the current working directory, and use arrow keys to select the session you want to switch to:

```
/sessions
```

The list shows each session's title and last update time, helping you find the conversation you want to continue.

**Startup replay**

When you continue an existing session, Gitrekt CLI will replay the previous conversation history so you can quickly understand the context. During replay, previous messages and AI responses will be displayed.

## Clear and compact

As the conversation progresses, the context grows longer. Gitrekt CLI will automatically compress the context when needed to ensure the conversation can continue.

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
