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

If the clipboard contains an image, Kimi Code CLI will automatically add the image as an attachment to the message. After sending the message, the AI can see and analyze the image.

::: tip
Image input requires the model to support the `image_in` capability. Video input requires the `video_in` capability.
:::

## Slash commands

Slash commands are special instructions starting with `/`, used to execute Kimi Code CLI's built-in features, such as `/help`, `/setup`, `/sessions`, etc. After typing `/`, a list of available commands will automatically appear. For the complete list of slash commands, see the [slash commands reference](../reference/slash-commands.md).

## @ path completion

When you type `@` in a message, Kimi Code CLI will auto-complete file and directory paths in the working directory. This allows you to conveniently reference files in your project:

```
Check if there are any issues with @src/components/Button.tsx
```

After typing `@`, start entering the filename and matching completions will appear. Press `Tab` or `Enter` to select a completion.

## $ skill selection

Kimi Code CLI supports quickly selecting and using skills via the `$` symbol. This is a Codex-style shortcut that lets you enable specific skills without leaving the input box.

**List and select skills**

Type `$` and press Enter to list all available standard skills:

```
Select skills:
1. kimi-cli-help - Kimi Code CLI help
2. code-style - Code style guidelines
3. git-commits - Git commit conventions

Skills (comma/space separated, empty to cancel):
```

Enter the number or skill name (multiple skills separated by commas or spaces) to select. After selection, the next input will automatically include the selected skills.

**Directly pre-select skills**

You can also pre-select skills directly using the `$<skill-name>` syntax while typing:

```
$code-style Help me refactor this code
```

The system will recognize `$code-style` as a skill tag and automatically load the corresponding `SKILL.md` content.

**Use multiple skills**

You can use multiple skills at the same time:

```
$code-style $git-commits Review this code and generate a commit message
```

Kimi Code CLI supports autocomplete for the `$` symbol. After typing `$`, available skills will be displayed, and you can continue typing to filter the options.

## Approvals

When the AI needs to perform operations that may have an impact (such as modifying files or running commands), Kimi Code CLI will request your confirmation.

The confirmation prompt will show operation details, including shell command and file diff previews. If the content is long and truncated, you can press `Ctrl-E` to expand and view the full content. You can choose:

- **Allow**: Execute this operation
- **Allow for this session**: Automatically approve similar operations in the current session
- **Reject**: Do not execute this operation

If you trust the AI's operations, or you're running Kimi Code CLI in a safe isolated environment, you can enable "YOLO mode" to automatically approve all requests:

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
