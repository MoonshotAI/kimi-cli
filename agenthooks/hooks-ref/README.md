# agenthooks-ref

Reference library for Agent Hooks.

> **Note:** This library is intended for demonstration purposes only. It is not meant to be used in production.

## Installation

### macOS / Linux

Using pip:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e .
```

Or using [uv](https://docs.astral.sh/uv/):

```bash
uv sync
source .venv/bin/activate
```

### Windows

Using pip (PowerShell):

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -e .
```

Using pip (Command Prompt):

```cmd
python -m venv .venv
.venv\Scripts\activate.bat
pip install -e .
```

Or using [uv](https://docs.astral.sh/uv/):

```powershell
uv sync
.venv\Scripts\Activate.ps1
```

After installation, the `agenthooks-ref` executable will be available on your `PATH` (within the activated virtual environment).

## Usage

### CLI

```bash
# Validate a hook
agenthooks-ref validate path/to/hook

# Read hook properties (outputs JSON)
agenthooks-ref read-properties path/to/hook

# List all discovered hooks
agenthooks-ref list

# Discover hooks in default locations
agenthooks-ref discover

# Generate <available_hooks> XML for agent prompts
agenthooks-ref to-prompt path/to/hook-a path/to/hook-b
```

### Python API

```python
from pathlib import Path
from agenthooks_ref import validate, read_properties, to_prompt

# Validate a hook directory
result = validate(Path("my-hook"))
if result.valid:
    print("Valid hook!")
else:
    print("Errors:", result.errors)

# Read hook properties
props = read_properties(Path("my-hook"))
print(f"Hook: {props.name} - {props.description}")
print(f"Trigger: {props.trigger.value}")

# Generate prompt for available hooks
prompt = to_prompt([Path("hook-a"), Path("hook-b")])
print(prompt)
```

### Discovery

```python
from agenthooks_ref import (
    discover_user_hooks,
    discover_project_hooks,
    load_hooks,
    load_hooks_by_trigger,
)

# Discover user-level hooks (~/.config/agents/hooks/)
user_hooks = discover_user_hooks()

# Discover project-level hooks (./.agents/hooks/)
project_hooks = discover_project_hooks()

# Load all hooks with metadata
all_hooks = load_hooks()

# Load hooks filtered by trigger
before_tool_hooks = load_hooks_by_trigger("before_tool")
```

## Agent Prompt Integration

Use `to-prompt` to generate the suggested `<available_hooks>` XML block for your agent's system prompt:

```xml
<available_hooks>
<hook>
<name>
block-dangerous-commands
</name>
<description>
Blocks dangerous shell commands like rm -rf /
</description>
<trigger>
before_tool
</trigger>
<location>
/path/to/block-dangerous-commands/HOOK.md
</location>
</hook>
</available_hooks>
```

The `<location>` element tells the agent where to find the full hook instructions.

## Documentation

- [English Documentation](./README.md)
- [中文文档](./README.zh.md)

## License

Apache 2.0
