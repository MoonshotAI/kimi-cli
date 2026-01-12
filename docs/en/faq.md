# FAQ

## Installation and Authentication

### Empty model list during `/setup`

If you see "No models available for the selected platform" error when running the `/setup` command, it may be due to:

- **Invalid or expired API key**: Check if your API key is correct and still valid.
- **Network connection issues**: Confirm you can access the API service addresses (such as `api.kimi.com` or `api.moonshot.cn`).

### Invalid API key

Possible reasons for an invalid API key:

- **Key input error**: Check for extra spaces or missing characters.
- **Key expired or revoked**: Confirm the key status in the platform console.
- **Environment variable override**: Check if `KIMI_API_KEY` or `OPENAI_API_KEY` environment variables are overriding the key in the config file. You can run `echo $KIMI_API_KEY` to check.

### Membership expired or quota exhausted

If you're using the Kimi Code platform, you can check your current quota and membership status with the `/usage` command. If the quota is exhausted or membership expired, you need to renew or upgrade at [Kimi Code](https://kimi.com/coding).

## Interaction Issues

### `cd` command doesn't work in shell mode

Executing the `cd` command in shell mode won't change Kimi CLI's working directory. This is because each shell command executes in an independent subprocess, and directory changes only take effect within that process.

If you need to change working directory:

- **Exit and restart**: Run the `kimi` command again in the target directory.
- **Use `--work-dir` flag**: Specify working directory at startup, like `kimi --work-dir /path/to/project`.
- **Use absolute paths in commands**: Execute commands with absolute paths directly, like `ls /path/to/dir`.

### Image paste fails

When using `Ctrl-V` to paste an image, if you see "Current model does not support image input", it means the current model doesn't support image input.

Solutions:

- **Switch to an image-capable model**: Use a model that supports the `image_in` capability.
- **Check clipboard content**: Make sure the clipboard contains actual image data, not just a file path to an image.

## ACP Issues

### IDE cannot connect to Kimi CLI

If your IDE (like Zed or JetBrains IDEs) cannot connect to Kimi CLI, check the following:

- **Confirm Kimi CLI is installed**: Run `kimi --version` to confirm successful installation.
- **Check configuration path**: Ensure the Kimi CLI path in IDE configuration is correct. You can typically use `kimi acp` as the command.
- **Check uv path**: If installed via uv, ensure `~/.local/bin` is in PATH. You can use an absolute path like `/Users/yourname/.local/bin/kimi acp`.
- **Check logs**: Examine error messages in `~/.kimi/logs/kimi.log`.

## MCP Issues

### MCP server startup fails

After adding an MCP server, if tools aren't loaded or there are errors, it may be due to:

- **Command doesn't exist**: For stdio type servers, ensure the command (like `npx`) is in PATH. You can configure with an absolute path.
- **Configuration format error**: Check if `~/.kimi/mcp.json` is valid JSON. Run `kimi mcp list` to view current configuration.

Debugging steps:

```sh
# View configured servers
kimi mcp list

# Test if server is working
kimi mcp test <server-name>
```

### OAuth authorization fails

For MCP servers that require OAuth authorization (like Linear), if authorization fails:

- **Check network connection**: Ensure you can access the authorization server.
- **Re-authorize**: Run `kimi mcp auth <server-name>` to authorize again.
- **Reset authorization**: If authorization info is corrupted, run `kimi mcp reset-auth <server-name>` to clear it and retry.

### Header format error

When adding HTTP type MCP servers, header format should be `KEY: VALUE` (with a space after the colon). For example:

```sh
# Correct
kimi mcp add --transport http context7 https://mcp.context7.com/mcp --header "CONTEXT7_API_KEY: your-key"

# Wrong (missing space or using equals sign)
kimi mcp add --transport http context7 https://mcp.context7.com/mcp --header "CONTEXT7_API_KEY=your-key"
```

## Print/Wire Mode Issues

### Invalid JSONL input format

When using `--input-format stream-json`, input must be valid JSONL (one JSON object per line). Common issues:

- **JSON format error**: Ensure each line is a complete JSON object without syntax errors.
- **Encoding issues**: Ensure input uses UTF-8 encoding.
- **Line ending issues**: Windows users should check if line endings are `\n` rather than `\r\n`.

Correct input format example:

```json
{"role": "user", "content": "Hello"}
```

### No output in print mode

If there's no output in `--print` mode, it may be:

- **No input provided**: You need to provide input via `--command` or stdin. For example: `kimi --print --command "Hello"`.
- **Output is buffered**: Try using `--output-format stream-json` for streaming output.
- **Configuration incomplete**: Ensure API key and model are configured via `/setup`.

## Updates and Upgrades

### macOS slow first run

macOS's Gatekeeper security mechanism checks new programs on first run, causing slow startup. Solutions:

- **Wait for check to complete**: Be patient on first run; subsequent launches will return to normal.
- **Add to Developer Tools**: Add your terminal application in "System Settings → Privacy & Security → Developer Tools".

### How to upgrade Kimi CLI

Use uv to upgrade to the latest version:

```sh
uv tool upgrade kimi-cli --no-cache
```

Adding `--no-cache` ensures you get the latest version.

### How to disable auto-update check

If you don't want Kimi CLI to check for updates in the background, set the environment variable:

```sh
export KIMI_CLI_NO_AUTO_UPDATE=1
```

You can add this line to your shell configuration file (like `~/.zshrc` or `~/.bashrc`).
