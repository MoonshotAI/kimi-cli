# Print Mode

Print mode lets Kimi CLI run non-interactively, suitable for scripting and automation scenarios.

## Basic usage

Use the `--print` flag to enable print mode:

```sh
# Pass instructions via -c
kimi --print -c "List all Python files in the current directory"

# Pass instructions via stdin
echo "Explain what this code does" | kimi --print
```

Print mode characteristics:

- **Non-interactive**: Exits automatically after executing instructions
- **Auto-approval**: Implicitly enables `--yolo` mode, all operations are auto-approved
- **Text output**: AI responses are output to stdout

<!-- TODO: Enable this example after supporting reading content from stdin and instructions from -c simultaneously
**Pipeline examples**

```sh
# Analyze git diff and generate commit message
git diff --staged | kimi --print -c "Generate a Conventional Commits compliant commit message based on this diff"

# Read file and generate documentation
cat src/api.py | kimi --print -c "Generate API documentation for this Python module"
```
-->

## Final message only

Use the `--final-message-only` option to only output the final assistant message, skipping intermediate tool call processes:

```sh
kimi --print -c "Give me a Git commit message based on the current changes" --final-message-only
```

`--quiet` is a shortcut for `--print --output-format text --final-message-only`, suitable for scenarios where only the final result is needed:

```sh
kimi --quiet -c "Give me a Git commit message based on the current changes"
```

## JSON format

Print mode supports JSON format for input and output, convenient for programmatic processing. Both input and output use the [Message](#message-format) format.

**JSON output**

Use `--output-format=stream-json` to output in JSONL (one JSON per line) format:

```sh
kimi --print -c "Hello" --output-format=stream-json
```

Example output:

```jsonl
{"role":"assistant","content":"Hello! How can I help you?"}
```

If the AI called tools, assistant messages and tool messages are output sequentially:

```jsonl
{"role":"assistant","content":"Let me check the current directory.","tool_calls":[{"type":"function","id":"tc_1","function":{"name":"Shell","arguments":"{\"command\":\"ls\"}"}}]}
{"role":"tool","tool_call_id":"tc_1","content":"file1.py\nfile2.py"}
{"role":"assistant","content":"There are two Python files in the current directory."}
```

**JSON input**

Use `--input-format=stream-json` to receive JSONL format input:

```sh
echo '{"role":"user","content":"Hello"}' | kimi --print --input-format=stream-json --output-format=stream-json
```

In this mode, Kimi CLI continuously reads from stdin, processing and outputting responses for each user message received until stdin is closed.

## Message format

Both input and output use a unified message format.

**User message**

```json
{"role": "user", "content": "Your question or instruction"}
```

Array-form content is also supported:

```json
{"role": "user", "content": [{"type": "text", "text": "Your question"}]}
```

**Assistant message**

```json
{"role": "assistant", "content": "Response content"}
```

Assistant message with tool calls:

```json
{
  "role": "assistant",
  "content": "Let me execute this command.",
  "tool_calls": [
    {
      "type": "function",
      "id": "tc_1",
      "function": {
        "name": "Shell",
        "arguments": "{\"command\":\"ls\"}"
      }
    }
  ]
}
```

**Tool message**

```json
{"role": "tool", "tool_call_id": "tc_1", "content": "Tool execution result"}
```

## Use cases

**CI/CD integration**

Auto-generate code or perform checks in CI workflows:

```sh
kimi --print -c "Check if there are any obvious security issues in the src/ directory, output a JSON format report"
```

**Batch processing**

Combine with shell loops for batch file processing:

```sh
for file in src/*.py; do
  kimi --print -c "Add type annotations to $file"
done
```

**Integration with other tools**

Use as a backend for other tools, communicating via JSON format:

```sh
my-tool | kimi --print --input-format=stream-json --output-format=stream-json | process-output
```
