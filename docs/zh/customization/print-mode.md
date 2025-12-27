# Print 模式

## 无交互运行

- `--print` + `--command` 或 stdin
- 隐式开启 `--yolo`

::: info 参考代码
`src/kimi_cli/ui/print/__init__.py`, `src/kimi_cli/ui/print/visualize.py`, `src/kimi_cli/cli.py`, `src/kimi_cli/app.py`, `src/kimi_cli/soul/approval.py`
:::

## Stream JSON 格式

- `--input-format=stream-json`
- `--output-format=stream-json`
- JSONL Message

::: info 参考代码
`src/kimi_cli/cli.py`, `src/kimi_cli/ui/print/visualize.py`, `src/kimi_cli/wire/message.py`, `src/kimi_cli/wire/serde.py`, `src/kimi_cli/ui/print/__init__.py`
:::
