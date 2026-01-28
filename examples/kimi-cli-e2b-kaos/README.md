# Kimi CLI + E2B KAOS (external sandbox lifecycle)

This example runs **KimiCLI** on an **E2B** sandbox as the KAOS backend. The sandbox lifecycle is managed **outside** of KimiCLI/KAOS.

## Requirements

- `E2B_API_KEY` in the environment.

## Run

```bash
cd examples/kimi-cli-e2b-kaos

# Required
export E2B_API_KEY=...

# Optional
export E2B_SANDBOX_ID=...
export KIMI_WORK_DIR=/home/user/kimi-workdir

uv run python main.py
```

## Notes

- On startup, the script asks whether to **create** a new sandbox or **connect** to an existing one.
- This example **never kills** sandboxes; lifecycle remains external.
- `KIMI_WORK_DIR` is created inside the sandbox if missing.
- Defaults: template `base`, timeout `300s` (create mode).
- Uses a custom agent file (`agent.yaml`) to disable the `Grep` tool, which only supports local KAOS.
