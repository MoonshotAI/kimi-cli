# Interaction and Input

Kimi CLI provides rich interaction features to help you collaborate efficiently with AI.

## Agent and shell mode

Kimi CLI has two input modes:

- **Agent mode**: The default mode, where input is sent to the AI for processing
- **Shell mode**: Execute shell commands directly without leaving Kimi CLI

Press `Ctrl-X` to switch between the two modes. The current mode is displayed in the bottom status bar.

In shell mode, you can execute commands just like in a regular terminal:

```sh
$ ls -la
$ git status
$ npm run build
```

Shell mode also supports some slash commands, including `/help`, `/exit`, `/version`, `/changelog`, and `/feedback`.

::: warning Note
In shell mode, each command executes independently. Commands that change the environment like `cd` or `export` won't affect subsequent commands.
:::

## Thinking mode

Thinking mode allows the AI to think more deeply before responding, suitable for handling complex problems.

You can use the `/model` command to switch models and thinking mode. After selecting a model, if the model supports thinking mode, the system will ask whether to enable it. You can also enable it at startup with the `--thinking` flag:

```sh
kimi --thinking
```

::: tip
Thinking mode requires support from the current model. Some models (like `kimi-k2-thinking-turbo`) always use thinking mode and cannot be disabled.
:::

## Multi-line input

Sometimes you need to enter multiple lines, such as pasting a code snippet or error log. Press `Ctrl-J` or `Alt-Enter` to insert a newline instead of sending the message immediately.

After finishing your input, press `Enter` to send the complete message.

## Clipboard and image paste

Press `Ctrl-V` to paste text or images from the clipboard.

If the clipboard contains an image, Kimi CLI will automatically add the image as an attachment to the message. After sending the message, the AI can see and analyze the image.

::: tip
Image input requires the model to support the `image_in` capability. Video input requires the `video_in` capability.
:::

## Slash commands

Slash commands are special instructions starting with `/`, used to execute Kimi CLI's built-in features, such as `/help`, `/setup`, `/sessions`, etc. After typing `/`, a list of available commands will automatically appear. For the complete list of slash commands, see the [slash commands reference](../reference/slash-commands.md).

## @ path completion

When you type `@` in a message, Kimi CLI will auto-complete file and directory paths in the working directory. This allows you to conveniently reference files in your project:

```
Check if there are any issues with @src/components/Button.tsx
```

After typing `@`, start entering the filename and matching completions will appear. Press `Tab` or `Enter` to select a completion.

## Approvals

When the AI needs to perform operations that may have an impact (such as modifying files or running commands), Kimi CLI will request your confirmation.

The confirmation prompt will show operation details, including shell command and file diff previews. If the content is long and truncated, you can press `Ctrl-E` to expand and view the full content. You can choose:

- **Allow**: Execute this operation
- **Allow for this session**: Automatically approve similar operations in the current session
- **Reject**: Do not execute this operation

If you trust the AI's operations, or you're running Kimi CLI in a safe isolated environment, you can enable "YOLO mode" to automatically approve all requests:

```sh
# Enable at startup
kimi --yolo

# Or toggle during runtime
/yolo
```

When YOLO mode is enabled, a yellow YOLO badge appears in the status bar at the bottom. Enter `/yolo` again to disable it.

::: warning Note
YOLO mode skips all confirmations. Make sure you understand the potential risks. It's recommended to only use this in controlled environments.
:::
