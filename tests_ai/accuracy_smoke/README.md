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

- `scripts/install_harbor.sh`: install Harbor CLI locally (pinned).
- `scripts/prepare_terminal_bench_repo.sh`: clone/update Terminal-Bench-2 via mirror prefix (pinned).
- `scripts/run_smoke.sh`: run selected tasks one-by-one with Harbor.

## Quick start

```bash
bash tests_ai/accuracy_smoke/scripts/install_harbor.sh
bash tests_ai/accuracy_smoke/scripts/prepare_terminal_bench_repo.sh
bash tests_ai/accuracy_smoke/scripts/run_smoke.sh
```

## Version pinning

Both Harbor and Terminal-Bench-2 are pinned by default for stable regression signals:

- Harbor: `0.5.0` (in `scripts/install_harbor.sh`)
- Terminal-Bench-2 ref: `53ff2b87d621bdb97b455671f2bd9728b7d86c11` (in `scripts/prepare_terminal_bench_repo.sh`)

Override when needed:

```bash
HARBOR_VERSION=0.5.0 bash tests_ai/accuracy_smoke/scripts/install_harbor.sh
TERMINAL_BENCH_2_REF=53ff2b87d621bdb97b455671f2bd9728b7d86c11 \
  bash tests_ai/accuracy_smoke/scripts/prepare_terminal_bench_repo.sh
```

## API key configuration

Harbor's `kimi-cli` agent reads credentials from environment variables.
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

## Notes

- Default list is intentionally larger for better discrimination.
