# `Gitrekt info` 子命令

`Gitrekt info` 显示 Gitrekt CLI 的版本和协议信息。

```sh
Gitrekt info [--json]
```

## 选项

| 选项 | 说明 |
|------|------|
| `--json` | 以 JSON 格式输出 |

## 输出内容

| 字段 | 说明 |
|------|------|
| `gitrekt_cli_version` | Gitrekt CLI 版本号 |
| `agent_spec_versions` | 支持的 Agent 规格版本列表 |
| `wire_protocol_version` | Wire 协议版本 |
| `python_version` | Python 运行时版本 |

## 示例

**文本输出**

```sh
$ Gitrekt info
Gitrekt-cli version: 0.71
agent spec versions: 1
wire protocol: 1
python version: 3.14.0
```

**JSON 输出**

```sh
$ Gitrekt info --json
{"gitrekt_cli_version": "0.71", "agent_spec_versions": ["1"], "wire_protocol_version": "1", "python_version": "3.13.1"}
```
