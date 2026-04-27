#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TASK_FILE="${BASE_DIR}/terminal_bench_2_tasks_default.txt"
DEFAULT_BENCH_DIR="${BASE_DIR}/../terminal_bench_2_cache"
BENCH_DIR="${TERMINAL_BENCH_2_DIR:-$DEFAULT_BENCH_DIR}"
MODEL="${HARBOR_MODEL:-kimi/kimi-k2-turbo-preview}"
AGENT="${HARBOR_AGENT:-kimi-cli}"

if ! command -v harbor >/dev/null 2>&1; then
  echo "harbor is not installed. Run install_harbor.sh first." >&2
  exit 1
fi

if [ ! -f "${TASK_FILE}" ]; then
  echo "Task file not found: ${TASK_FILE}" >&2
  exit 1
fi

if [ ! -f "${BENCH_DIR}/README.md" ]; then
  echo "Terminal-Bench-2 not found in ${BENCH_DIR}" >&2
  echo "Run prepare_terminal_bench_repo.sh or set TERMINAL_BENCH_2_DIR." >&2
  exit 1
fi

if [ -z "${KIMI_API_KEY:-}" ] && [ -z "${MOONSHOT_API_KEY:-}" ]; then
  echo "Missing API key. Set KIMI_API_KEY or MOONSHOT_API_KEY first." >&2
  echo 'Example: export KIMI_API_KEY="your_api_key"' >&2
  exit 1
fi

while IFS= read -r task || [ -n "${task}" ]; do
  [ -z "${task}" ] && continue
  task_dir="${BENCH_DIR}/${task}"
  if [ ! -d "${task_dir}" ]; then
    echo "Skipping missing task: ${task_dir}" >&2
    continue
  fi
  echo "=== Running task: ${task} ==="
  harbor run -p "${task_dir}" -a "${AGENT}" -m "${MODEL}" --n-concurrent 1
done < "${TASK_FILE}"
