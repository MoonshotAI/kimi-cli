# `Gitrekt info` Subcommand

`Gitrekt info` displays version and protocol information for Gitrekt CLI.

```sh
Gitrekt info [--json]
```

## Options

| Option | Description |
|--------|-------------|
| `--json` | Output in JSON format |

## Output

| Field | Description |
|-------|-------------|
| `gitrekt_cli_version` | Gitrekt CLI version number |
| `agent_spec_versions` | List of supported agent spec versions |
| `wire_protocol_version` | Wire protocol version |
| `python_version` | Python runtime version |

## Examples

**Text output**

```sh
$ Gitrekt info
Gitrekt-cli version: 0.71
agent spec versions: 1
wire protocol: 1
python version: 3.14.0
```

**JSON output**

```sh
$ Gitrekt info --json
{"gitrekt_cli_version": "0.71", "agent_spec_versions": ["1"], "wire_protocol_version": "1", "python_version": "3.13.1"}
```
