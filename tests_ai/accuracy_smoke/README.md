# Accuracy Smoke (Harbor + Terminal-Bench-2)

This directory hosts a benchmark-backed accuracy smoke layer for `kimi-cli`.

It is intentionally separate from `tests_ai/` root so we can:

- keep existing fast policy checks unchanged;
- evolve benchmark-based checks independently;
- run smoke/nightly tracks with different budgets.

## Selected tasks (local CPU-focused)

Task list:

- `terminal_bench_2_tasks_default.txt`: default discriminative set (15 tasks)

Selection rules:

- no external API keys required by task logic;
- no GPU requirement in `task.toml`;
- moderate runtime suitable for development-tool CI smoke checks.

## Scripts

- `scripts/prepare_env.sh`: install pinned Harbor and clone/update pinned Terminal-Bench-2.
- `scripts/run_smoke.sh`: run selected tasks one-by-one with Harbor.

## Quick start

```bash
bash tests_ai/accuracy_smoke/scripts/prepare_env.sh
bash tests_ai/accuracy_smoke/scripts/run_smoke.sh
```

## Version pinning

Both Harbor and Terminal-Bench-2 are pinned by default for stable regression signals:

- Harbor: `0.5.0` (in `scripts/prepare_env.sh`)
- Terminal-Bench-2 ref: `53ff2b87d621bdb97b455671f2bd9728b7d86c11` (in `scripts/prepare_env.sh`)

Override when needed:

```bash
HARBOR_VERSION=0.5.0 \
TERMINAL_BENCH_2_REF=53ff2b87d621bdb97b455671f2bd9728b7d86c11 \
  bash tests_ai/accuracy_smoke/scripts/prepare_env.sh
```

Network-restricted environments can optionally set a GitHub mirror prefix:

```bash
GH_MIRROR_PREFIX=http://ghfast.top/ \
  bash tests_ai/accuracy_smoke/scripts/prepare_env.sh
```

## API key configuration

Harbor's custom local `kimi-cli` agent reads credentials from environment variables.
Set one of the following before running smoke tasks:

- `KIMI_API_KEY`
- `MOONSHOT_API_KEY`

Example:

```bash
export KIMI_API_KEY="your_api_key"
bash tests_ai/accuracy_smoke/scripts/run_smoke.sh
```

For CI, store the key in secret variables and inject it as an environment
variable at runtime. Do not commit API keys into this repository.

## Use current kimi-cli source (not release build)

`run_smoke.sh` defaults to evaluating the current repository commit by using a
custom Harbor agent import path:

- `tests_ai.accuracy_smoke.local_kimi_cli_agent:LocalKimiCli`

By default, it builds a local wheel from your current workspace and installs
that wheel inside the benchmark container. This means local unpushed changes
are included automatically.

Wheel controls:

- `KIMI_CLI_WHEEL_DIR` (default: `dist/accuracy_smoke`)
- `UV_PYTHON` (default: local `python3`)
- `UV_PYTHON_INSTALL_MIRROR` (optional mirror for uv Python downloads)

Git settings are kept as fallback:

- `KIMI_CLI_GIT_URL` (default: current repo `origin` URL)
- `KIMI_CLI_GIT_REF` (default: current `HEAD` commit)
- `GH_MIRROR_PREFIX` (optional: prefixes `origin` URL when `KIMI_CLI_GIT_URL` is unset)

Example override:

```bash
KIMI_CLI_WHEEL_DIR=/tmp/kimi-wheel-cache \
  bash tests_ai/accuracy_smoke/scripts/run_smoke.sh
```

If `GH_MIRROR_PREFIX` is set and `UV_PYTHON_INSTALL_MIRROR` is unset,
`run_smoke.sh` automatically prefixes uv Python-download URLs with
`GH_MIRROR_PREFIX`.

## Notes

- Default list is intentionally larger for better discrimination.
