# Interaction and Input

Kimi Code CLI provides rich interaction features to help you collaborate efficiently with AI.

## Agent and shell mode

Kimi Code CLI has two input modes:

- **Agent mode**: The default mode, where input is sent to the AI for processing
- **Shell mode**: Execute shell commands directly without leaving Kimi Code CLI

Press `Ctrl-X` to switch between the two modes. The current mode is displayed in the bottom status bar.

In shell mode, you can execute commands just like in a regular terminal:

```sh
$ ls -la
$ git status
$ npm run build
```

Shell mode also supports some slash commands, including `/help`, `/exit`, `/version`, `/editor`, `/changelog`, `/feedback`, `/export`, `/import`, and `/task`.

::: warning Note
In shell mode, each command executes independently. Commands that change the environment like `cd` or `export` won't affect subsequent commands.
:::

## Plan mode

Plan mode is a read-only planning mode that lets the AI design an implementation plan before writing code, preventing wasted effort in the wrong direction.

In plan mode, the AI can only use read-only tools (`Glob`, `Grep`, `ReadFile`) to explore the codebase — it cannot modify any files or execute commands. The AI writes its plan to a dedicated plan file, then submits it to you for approval. You can approve, reject, or provide revision feedback.

### Entering plan mode

There are four ways to enter plan mode:

- **CLI flag**: Use `kimi --plan` to start a new session directly in plan mode
- **Keyboard shortcut**: Press `Shift-Tab` to toggle plan mode
- **Slash command**: Enter `/plan` or `/plan on`
- **AI-initiated**: When facing complex tasks, the AI may request to enter plan mode via the `EnterPlanMode` tool — you can accept or decline

You can also set `default_plan_mode = true` in the config file to start every new session in plan mode by default. See [Configuration files](../configuration/config-files.md).

When plan mode is active, the prompt changes to `📋` and a blue `plan` badge appears in the status bar.

### Reviewing plans

When the AI finishes its plan, it submits it for approval via `ExitPlanMode`. The approval panel shows the full plan content, and you can:

- **Approve / select an approach**: If the plan contains multiple alternative implementation paths, the AI lists 2–3 labeled options (e.g. "Option A", "Option B (Recommended)") for you to choose from — selecting one exits plan mode and tells the AI which path to follow. If the plan has a single path, an **Approve** button is shown instead.
- **Reject**: Decline the plan, stay in plan mode, and provide feedback via conversation
- **Reject and Exit**: Decline the plan and exit plan mode in one step
- **Revise**: Enter revision notes — the AI will update the plan and resubmit

Press `Ctrl-E` to view the full plan content in a fullscreen pager.

### Managing plan mode

Use the `/plan` command to manage plan mode:

- `/plan`: Toggle plan mode
- `/plan on`: Enable plan mode
- `/plan off`: Disable plan mode
- `/plan view`: View the current plan content
- `/plan clear`: Clear the current plan file

## Thinking mode

Thinking mode allows the AI to think more deeply before responding, suitable for handling complex problems.

You can use the `/model` command to switch models and thinking mode. After selecting a model, if the model supports thinking mode, the system will ask whether to enable it. You can also enable it at startup with the `--thinking` flag:

```sh
kimi --thinking
```

::: tip
Thinking mode requires support from the current model. Some models (like `kimi-k2-thinking-turbo`) always use thinking mode and cannot be disabled.
:::

## Sending messages while running

While the AI is executing a task, you can send follow-up messages in two ways without waiting for the current turn to finish:

- **Queue (Enter)**: Press `Enter` to queue your message for delivery after the current turn completes. The queued message count is shown in the input area title (e.g. `── input · 2 queued ──`). Press `↑` in an empty input box to recall the last queued message for editing.
- **Inject immediately (Ctrl+S)**: Press `Ctrl+S` to inject your message directly into the running turn context — the model sees it right away.

Approval requests and question panels are also handled inline with keyboard navigation during agent execution.

::: tip
To interrupt the AI's execution immediately, use `Ctrl-C`.
:::

## Side questions

While the AI is working, you can use the `/btw` command to ask a quick side question without interrupting the main conversation flow.

```
/btw What is the return type of this function?
```

Side questions run in an isolated context: they can see the conversation history but do not modify it, and tools are disabled. The response is displayed in a scrollable modal panel — use `↑`/`↓` to scroll, `Escape` to close.

See [Slash commands reference](../reference/slash-commands.md#btw) for details.

## Background tasks

When the AI needs to run long-running commands (such as building a project, running a test suite, or starting a development server), it can launch them as background tasks. Background tasks run in a separate process, allowing the AI to continue handling other requests without waiting for the command to finish.

How background tasks work:

1. The AI uses the `Shell` tool with `run_in_background=true` to launch the command
2. The tool immediately returns a task ID, and the AI continues with other work
3. When the task completes, if the AI is idle (waiting for user input), the system automatically triggers a new agent turn to process the results — no manual input needed

You can use the `/task` slash command to open the interactive task browser, where you can view the status and output of all background tasks in real time (including tasks that are still running). See [Slash commands reference](../reference/slash-commands.md#task) for details.

::: tip
By default, up to 4 background tasks can run simultaneously. This can be adjusted in the `[background]` section of the config file. All background tasks are terminated when the CLI exits by default. Before exiting, the CLI lists each task (id + description) on stderr, waits out the configured `kill_grace_period_ms` grace period (default 2 seconds), then reports any tasks that have not reached terminal state. If `keep_alive_on_exit = true` is set, background tasks are kept running on exit. See [Configuration files](../configuration/config-files.md#background).
:::

## Multi-line input

Sometimes you need to enter multiple lines, such as pasting a code snippet or error log. Press `Ctrl-J` or `Alt-Enter` to insert a newline instead of sending the message immediately.

After finishing your input, press `Enter` to send the complete message.

## Clipboard and media paste

Press `Ctrl-V` to paste text, images, or video files from the clipboard.

In agent mode, longer pasted text (over 1000 characters or 15 lines) is automatically collapsed into a `[Pasted text #n]` placeholder in the input box to keep the interface clean. The full content is still expanded and sent to the model when submitting. When using an external editor (`Ctrl-O`), placeholders are automatically expanded to the original text; unmodified portions are re-collapsed after saving.

If the clipboard contains an image, Kimi Code CLI caches the image to disk and displays it as an `[image:…]` placeholder in the input box. After sending the message, the AI can see and analyze the image. If the clipboard contains a video file, its file path is inserted as text into the input box.

::: tip
Image input requires the model to support the `image_in` capability. Video input requires the `video_in` capability.
:::

## Slash commands

Slash commands are special instructions starting with `/`, used to execute Kimi Code CLI's built-in features, such as `/help`, `/login`, `/sessions`, etc. After typing `/`, a list of available commands will automatically appear. For the complete list of slash commands, see the [slash commands reference](../reference/slash-commands.md).

## @ path completion

When you type `@` in a message, Kimi Code CLI will auto-complete file and directory paths in the working directory. This allows you to conveniently reference files in your project:

```
Check if there are any issues with @src/components/Button.tsx
```

After typing `@`, start entering the filename and matching completions will appear. Press `Tab` or `Enter` to select a completion. In Git repositories, file discovery uses `git ls-files` first, enabling fast lookups even in large repos with tens of thousands of files; non-Git projects fall back to directory scanning.

## Structured questions

During execution, the AI may need you to make choices to determine the next direction. In such cases, the AI will use the `AskUserQuestion` tool to present structured questions and options.

The question panel displays the question description and available options. You can select using the keyboard:

- Use arrow keys (up / down) to navigate options
- Press `Enter` to confirm selection
- Press `Space` to toggle selection in multi-select mode
- Select "Other" to enter custom text
- Press `Esc` to skip the question

Each question supports 2–4 predefined options, and the AI will set appropriate options and descriptions based on the current task context. If there are multiple questions to answer, the panel displays them as tabs — use Left/Right arrow keys or `Tab` to switch between questions. Answered questions are marked as completed, and switching back to an answered question restores the previous selection.

::: tip
The AI only uses this tool when your choice genuinely affects subsequent actions. For decisions that can be inferred from context, the AI will decide on its own and continue execution.
:::

## Approvals and confirmations

When the AI needs to perform operations that may have an impact (such as modifying files or running commands), Kimi Code CLI will request your confirmation.

The confirmation prompt will show operation details, including shell command and file diff previews. If the content is long and truncated, you can press `Ctrl-E` to expand and view the full content. You can choose:

- **Allow**: Execute this operation
- **Allow for this session**: Automatically approve similar operations in the current session (this decision is persisted with the session and automatically restored when resuming)
- **Reject**: Do not execute this operation
- **Reject with feedback**: Decline the operation and provide written feedback telling the agent how to adjust

If you trust the AI's operations, or you're running Kimi Code CLI in a safe isolated environment, you can enable "YOLO mode" to automatically approve all requests:

```sh
# Enable at startup
kimi --yolo

# Or toggle during runtime
/yolo
```

You can also set `default_yolo = true` in the config file to enable YOLO mode by default on every startup. See [Configuration files](../configuration/config-files.md).

When YOLO mode is enabled, a yellow YOLO badge appears in the status bar at the bottom. Enter `/yolo` again to disable it.

::: warning Note
YOLO mode skips all confirmations. Make sure you understand the potential risks. It's recommended to only use this in controlled environments.
:::
