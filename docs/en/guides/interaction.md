# Interaction and input

Kimi Code CLI provides rich interactive features to help you collaborate efficiently with AI.

## Agent and shell mode

Kimi Code CLI has two input modes:

- **Agent mode**: Default mode, input is sent to AI for processing
- **Shell mode**: Execute shell commands directly without leaving Kimi Code CLI

Press `Ctrl-X` to switch between the two modes. The current mode is displayed in the bottom status bar.

In shell mode, you can execute commands just like in a regular terminal:

```sh
$ ls -la
$ git status
$ npm run build
```

Shell mode also supports some slash commands, including `/help`, `/exit`, `/version`, `/changelog`, and `/feedback`.

::: warning Warning
In shell mode, each command runs independently. Commands like `cd` and `export` that change the environment will not affect subsequent commands.
:::

## Thinking mode

Thinking mode allows AI to think more deeply before responding, suitable for handling complex problems.

You can switch models and thinking mode using the `/model` command. After selecting a model, if the model supports thinking mode, the system will ask whether to enable it. You can also enable it at startup with the `--thinking` parameter:

```sh
kimi --thinking
```

::: tip Tip
Thinking mode requires the current model to support it. Some models (e.g., `kimi-k2-thinking-turbo`) always use thinking mode and cannot be turned off.
:::

## Multiline input

Sometimes you need to input multiple lines, such as pasting a code snippet or error log. Press `Ctrl-J` or `Alt-Enter` to insert a line break instead of sending the message immediately.

After completing your input, press `Enter` to send the entire message.

## Clipboard and image paste

Press `Ctrl-V` to paste text or images from the clipboard.

If the clipboard contains an image, Kimi Code CLI will automatically add the image as an attachment to the message. After sending the message, the AI can view and analyze the image.

::: tip Tip
Image input requires the current model to support the `image_in` capability, and video input requires the `video_in` capability.
:::

## Slash commands

Slash commands are special instructions starting with `/` that are used to execute built-in functions of Kimi Code CLI, such as `/help`, `/login`, `/sessions`, etc. Available commands are automatically displayed after typing `/`. For the complete list of slash commands, please refer to the [slash command reference](../reference/slash-commands.md).

## @ path completion

When you type `@` in a message, Kimi Code CLI will automatically complete file and directory paths in the working directory. This allows you to conveniently reference files in your project:

```
Please check if there are any issues with the file @src/components/Button.tsx
```

After typing `@`, start typing the filename to see matching completion items. Press `Tab` or `Enter` to select a completion item.

## Approval and confirmation

When the AI needs to perform potentially impactful operations (such as modifying files or running commands), Kimi Code CLI will request your confirmation.

The confirmation prompt displays the details of the operation, including shell commands and file diff previews. If the content is long and truncated, you can press `Ctrl-E` to expand and view the full content. You can choose:

- **Allow**: Execute this operation
- **Allow this session**: Automatically approve similar operations in the current session
- **Deny**: Do not execute this operation

If you trust the AI's operations, or if you are running Kimi Code CLI in a safe isolated environment, you can enable "YOLO mode" to automatically approve all requests:

```sh
# Enable at startup
kimi --yolo

# Or toggle during runtime
/yolo
```

After enabling YOLO mode, the bottom status bar will display a yellow YOLO indicator. Type `/yolo` again to turn it off.

::: warning Warning
YOLO mode will skip all confirmations. Please make sure you understand the potential risks. It is recommended to use only in controlled environments.
:::
