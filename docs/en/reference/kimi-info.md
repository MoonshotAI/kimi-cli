# `kimi info` Subcommand

`kimi info` displays version and protocol information for Kimi CLI.

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
| `kimi_cli_version` | Kimi CLI version number |
| `agent_spec_versions` | List of supported agent spec versions |
| `wire_protocol_version` | Wire protocol version |
| `python_version` | Python runtime version |

## Examples

**Text output**

```sh
$ kimi info
kimi-cli version: 0.71
agent spec versions: 1
wire protocol: 1
python version: 3.14.0
```

**JSON output**

```sh
$ kimi info --json
{"kimi_cli_version": "0.71", "agent_spec_versions": ["1"], "wire_protocol_version": "1", "python_version": "3.13.1"}
```
