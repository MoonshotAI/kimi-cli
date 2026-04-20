# `kimi info` Subcommand

`kimi info` displays version and protocol information for Kimi Code CLI.

```sh
kimi info [--json]
```

## Options

| Option | Description |
|--------|-------------|
| `--json` | Output in JSON format |

## Output

| Field | Description |
|-------|-------------|
| `kimi_cli_version` | Kimi Code CLI version number |
| `agent_spec_versions` | List of supported agent spec versions |
| `wire_protocol_version` | Wire protocol version |
| `python_version` | Python runtime version |

## Examples

**Text output**

```sh
$ kimi info
kimi-cli version: 1.36.0
agent spec versions: 1
wire protocol: 1.9
python version: 3.14.3
```

**JSON output**

```sh
$ kimi info --json
{"kimi_cli_version": "1.36.0", "agent_spec_versions": ["1"], "wire_protocol_version": "1.9", "python_version": "3.14.3"}
```
