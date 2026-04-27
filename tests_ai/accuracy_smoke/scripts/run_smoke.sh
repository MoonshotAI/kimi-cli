#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TASK_FILE="${BASE_DIR}/terminal_bench_2_tasks_default.txt"
DEFAULT_BENCH_DIR="${BASE_DIR}/../terminal_bench_2_cache"
BENCH_DIR="${TERMINAL_BENCH_2_DIR:-$DEFAULT_BENCH_DIR}"
REPO_ROOT="$(cd "${BASE_DIR}/../.." && pwd)"
WHEEL_DIR="${KIMI_CLI_WHEEL_DIR:-${REPO_ROOT}/dist/accuracy_smoke}"
MODEL="${HARBOR_MODEL:-kimi/kimi-k2-turbo-preview}"
AGENT_IMPORT_PATH="${HARBOR_AGENT_IMPORT_PATH:-tests_ai.accuracy_smoke.local_kimi_cli_agent:LocalKimiCli}"
ORIGIN_GIT_URL="$(git -C "${REPO_ROOT}" remote get-url origin)"
GH_MIRROR_PREFIX="${GH_MIRROR_PREFIX:-}"
UV_PYTHON="${UV_PYTHON:-$(command -v python3)}"
UV_PYTHON_INSTALL_MIRROR="${UV_PYTHON_INSTALL_MIRROR:-}"
if [ -n "${KIMI_CLI_GIT_URL:-}" ]; then
  KIMI_CLI_GIT_URL="${KIMI_CLI_GIT_URL}"
elif [ -n "${GH_MIRROR_PREFIX}" ]; then
  case "${ORIGIN_GIT_URL}" in
    "${GH_MIRROR_PREFIX}"*)
      KIMI_CLI_GIT_URL="${ORIGIN_GIT_URL}"
      ;;
    *)
      KIMI_CLI_GIT_URL="${GH_MIRROR_PREFIX}${ORIGIN_GIT_URL}"
      ;;
  esac
else
  KIMI_CLI_GIT_URL="${ORIGIN_GIT_URL}"
fi
if [ -z "${KIMI_CLI_GIT_REF:-}" ]; then
  KIMI_CLI_GIT_REF="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
fi

if ! command -v harbor >/dev/null 2>&1; then
  echo "harbor is not installed. Run prepare_env.sh first." >&2
  exit 1
fi

if [ ! -f "${TASK_FILE}" ]; then
  echo "Task file not found: ${TASK_FILE}" >&2
  exit 1
fi

if [ ! -f "${BENCH_DIR}/README.md" ]; then
  echo "Terminal-Bench-2 not found in ${BENCH_DIR}" >&2
  echo "Run prepare_env.sh or set TERMINAL_BENCH_2_DIR." >&2
  exit 1
fi

if [ -z "${KIMI_API_KEY:-}" ] && [ -z "${MOONSHOT_API_KEY:-}" ]; then
  echo "Missing API key. Set KIMI_API_KEY or MOONSHOT_API_KEY first." >&2
  echo 'Example: export KIMI_API_KEY="your_api_key"' >&2
  exit 1
fi

mkdir -p "${WHEEL_DIR}"
echo "Building local kimi-cli wheel into ${WHEEL_DIR}"
if [ -n "${GH_MIRROR_PREFIX}" ] && [ -z "${UV_PYTHON_INSTALL_MIRROR}" ]; then
  UV_PYTHON_INSTALL_MIRROR="${GH_MIRROR_PREFIX}https://github.com/astral-sh/python-build-standalone/releases/download"
fi
echo "Using UV_PYTHON=${UV_PYTHON}"
if [ -n "${UV_PYTHON_INSTALL_MIRROR}" ]; then
  echo "Using UV_PYTHON_INSTALL_MIRROR=${UV_PYTHON_INSTALL_MIRROR}"
fi
UV_PYTHON="${UV_PYTHON}" UV_PYTHON_INSTALL_MIRROR="${UV_PYTHON_INSTALL_MIRROR}" \
  uv build --package kimi-cli --out-dir "${WHEEL_DIR}" >/dev/null
KIMI_CLI_WHEEL_PATH="$(ls -t "${WHEEL_DIR}"/*.whl | head -n 1)"

echo "Using local kimi-cli wheel: ${KIMI_CLI_WHEEL_PATH}"
echo "Git fallback source: ${KIMI_CLI_GIT_URL} @ ${KIMI_CLI_GIT_REF}"

while IFS= read -r task || [ -n "${task}" ]; do
  [ -z "${task}" ] && continue
  task_dir="${BENCH_DIR}/${task}"
  if [ ! -d "${task_dir}" ]; then
    echo "Skipping missing task: ${task_dir}" >&2
    continue
  fi
  echo "=== Running task: ${task} ==="
  KIMI_CLI_WHEEL_PATH="${KIMI_CLI_WHEEL_PATH}" \
    KIMI_CLI_GIT_URL="${KIMI_CLI_GIT_URL}" \
    KIMI_CLI_GIT_REF="${KIMI_CLI_GIT_REF}" \
    harbor run -p "${task_dir}" \
      --agent-import-path "${AGENT_IMPORT_PATH}" \
      -m "${MODEL}" \
      --n-concurrent 1
done < "${TASK_FILE}"
