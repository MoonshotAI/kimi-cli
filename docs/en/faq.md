# FAQ

## Installation and authentication

### Empty model list during `/login`

If you see the "No models available for the selected platform" error when running the `/login` (or `/setup`) command, it may be due to:

- **Invalid or expired API key**: Check whether the API key you entered is correct and still valid.
- **Network connection issues**: Confirm that you can access the API service address normally (such as `api.kimi.com` or `api.moonshot.cn`).

### Invalid API key

Possible reasons for an invalid API key:

- **Key entered incorrectly**: Check for extra spaces or missing characters.
- **Key has expired or been revoked**: Confirm the key status in the platform console.
- **Environment variable override**: Check whether the `KIMI_API_KEY` or `OPENAI_API_KEY` environment variable is overriding the key in the configuration file. You can run `echo $KIMI_API_KEY` to check.

### Membership expired or quota exhausted

If you use the Kimi Code platform, you can view your current quota and membership status via the `/usage` slash command. If the quota is exhausted or the membership has expired, you need to renew or upgrade at [Kimi Code](https://kimi.com/coding).

## Interaction issues

### `cd` command ineffective in shell mode

Executing the `cd` command in shell mode will not change Kimi Code CLI's working directory. This is because each shell command runs in an independent subprocess, and the directory change only takes effect within that process.

If you need to switch working directories:

- **Exit and restart**: Re-run the `kimi` command in the target directory.
- **Use the `--work-dir` parameter**: Specify the working directory at startup, such as `kimi --work-dir /path/to/project`.
- **Use absolute paths in commands**: Execute commands directly using absolute paths, such as `ls /path/to/dir`.

### Paste image failed

When using `Ctrl-V` to paste an image, if it prompts "Current model does not support image input", it means the current model does not support image input.

Solutions:

- **Switch to a model that supports images**: Use a model that supports the `image_in` capability.
- **Check clipboard content**: Ensure the clipboard actually contains image data, not the path to an image file.

## ACP issues

### IDE cannot connect to Kimi Code CLI

If the IDE (such as Zed or JetBrains IDE) cannot connect to Kimi Code CLI, please check the following:

- **Confirm Kimi Code CLI is installed**: Run `kimi --version` to confirm successful installation.
- **Check configuration path**: Ensure the Kimi Code CLI path in the IDE configuration is correct. Usually, you can use `kimi acp` as the command.
- **Check uv path**: If installed via uv, ensure `~/.local/bin` is in PATH. You can use the absolute path, such as `/Users/yourname/.local/bin/kimi acp`.
- **View logs**: Check the error information in `~/.kimi/logs/kimi.log`.

## MCP issues

### MCP service startup failed

After adding an MCP server, if tools fail to load or error occurs, possible reasons include:

- **Command does not exist**: For stdio-type servers, ensure the command (such as `npx`) is in PATH. You can use the absolute path for configuration.
- **Configuration format error**: Check whether `~/.kimi/mcp.json` is in valid JSON format. Run `kimi mcp list` to view the current configuration.

Debugging steps:

```sh
# View configured servers
kimi mcp list

# Test if server is working properly
kimi mcp test <server-name>
```

### OAuth authorization failed

For MCP servers requiring OAuth authorization (such as Linear), if authorization fails:

- **Check network connection**: Ensure you can access the authorization server.
- **Re-authorize**: Run `kimi mcp auth <server-name>` to re-authorize.
- **Reset authorization**: If authorization information is corrupted, you can run `kimi mcp reset-auth <server-name>` to clear and retry.

### Header format error

When adding HTTP-type MCP servers, the header format should be `KEY: VALUE` (with a space after the colon). For example:

```sh
# Correct
kimi mcp add --transport http context7 https://mcp.context7.com/mcp --header "CONTEXT7_API_KEY: your-key"

# Incorrect (missing space or using equals sign)
kimi mcp add --transport http context7 https://mcp.context7.com/mcp --header "CONTEXT7_API_KEY=your-key"
```

## Print/wire mode issues

### Invalid JSONL input format

When using `--input-format stream-json`, the input must be valid JSONL (one JSON object per line). Common issues:

- **JSON format error**: Ensure each line is a complete JSON object without syntax errors.
- **Encoding issues**: Ensure the input uses UTF-8 encoding.
- **Newline issues**: Windows users should check that newlines are `
` rather than `\n`.

Correct input format example:

```json
{"role": "user", "content": "Hello"}
```

### No output in print mode

If there is no output in `--print` mode, possible causes are:

- **No input provided**: Input needs to be provided via `--prompt` (or `--command`) or stdin. For example: `kimi --print --prompt "Hello"`.
- **Output buffered**: Try using `--output-format stream-json` to get streaming output.
- **Configuration incomplete**: Ensure API key and model have been configured via `/login`.

## Update and upgrade

### First run slow on macOS

macOS's Gatekeeper security mechanism checks new programs on first run, causing slower startup. Solutions:

- **Wait for the check to complete**: Be patient during first run; subsequent startups will return to normal.
- **Add to developer tools**: Add your terminal application in "System Settings → Privacy & Security → Developer Tools".

### How to upgrade Kimi Code CLI

Upgrade to the latest version using uv:

```sh
uv tool upgrade kimi-cli --no-cache
```

Adding the `--no-cache` parameter ensures you get the latest version.

### How to disable automatic update checks

If you do not want Kimi Code CLI to check for updates in the background, set the environment variable:

```sh
export KIMI_CLI_NO_AUTO_UPDATE=1
```

You can add this line to your shell configuration file (such as `~/.zshrc` or `~/.bashrc`).
