# Print mode

Print mode allows Kimi Code CLI to run in a non-interactive manner, suitable for scripting and automation scenarios.

## Basic usage

Use the `--print` parameter to enable print mode:

```sh
# Pass instruction via -p (or -c)
kimi --print -p "List all Python files in the current directory"

# Pass instruction via stdin
echo "Explain what this code does" | kimi --print
```

Characteristics of print mode:

- **Non-interactive**: Automatically exits after executing the instruction
- **Auto-approval**: Implicitly enables `--yolo` mode, all operations are automatically approved
- **Text output**: AI responses are output to stdout

<!-- TODO: Support reading content from stdin and instructions from -p simultaneously, then enable this example
**Pipeline composition example**

```sh
# Analyze git diff and generate commit message
git diff --staged | kimi --print -p "Generate a commit message following Conventional Commits based on this diff"

# Read file and generate documentation
cat src/api.py | kimi --print -p "Generate API documentation for this Python module"
```
-->

## Output final message only

Use the `--final-message-only` option to output only the final assistant message, skipping intermediate tool call processes:

```sh
kimi --print -p "Give me a Git commit message based on current changes" --final-message-only
```

`--quiet` is a shorthand for `--print --output-format text --final-message-only`, suitable for scenarios where only the final result is needed:

```sh
kimi --quiet -p "Give me a Git commit message based on current changes"
```

## JSON format

Print mode supports JSON format input and output for easier programmatic processing. Both input and output use the [Message](#message-format) format.

**JSON output**

Use `--output-format=stream-json` to output in JSONL (one JSON per line) format:

```sh
kimi --print -p "Hello" --output-format=stream-json
```

Output example:

```jsonl
{"role":"assistant","content":"Hello! How can I help you?"}
```

If the AI calls tools, it will output assistant messages and tool messages sequentially:

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

In this mode, Kimi Code CLI continuously reads from stdin, processing and outputting responses for each user message received until stdin is closed.

## Message format

Input and output both use a unified message format.

**User message**

```json
{"role": "user", "content": "Your question or instruction"}
```

You can also use array form for content:

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

## Usage scenarios

**CI/CD integration**

Automatically generate code or perform checks in CI workflows:

```sh
kimi --print -p "Check for obvious security issues in the src/ directory and output a JSON format report"
```

**Batch processing**

Combine with shell loops for batch file processing:

```sh
for file in src/*.py; do
  kimi --print -p "Add type annotations to $file"
done
```

**Integration with other tools**

Use as a backend for other tools, communicating via JSON format:

```sh
my-tool | kimi --print --input-format=stream-json --output-format=stream-json | process-output
```
