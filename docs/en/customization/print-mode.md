# Print Mode

## Non-interactive run

- `--print` + `--command` or stdin
- Implicitly enables `--yolo`

::: info Reference Code
`src/kimi_cli/ui/print/__init__.py`, `src/kimi_cli/ui/print/visualize.py`, `src/kimi_cli/cli.py`, `src/kimi_cli/app.py`, `src/kimi_cli/soul/approval.py`
:::

## Stream JSON format

- `--input-format=stream-json`
- `--output-format=stream-json`
- JSONL Message

::: info Reference Code
`src/kimi_cli/cli.py`, `src/kimi_cli/ui/print/visualize.py`, `src/kimi_cli/wire/message.py`, `src/kimi_cli/wire/serde.py`, `src/kimi_cli/ui/print/__init__.py`
:::
