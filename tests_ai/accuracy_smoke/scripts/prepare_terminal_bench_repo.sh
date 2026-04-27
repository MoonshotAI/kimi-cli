#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEFAULT_TARGET_DIR="${ROOT_DIR}/terminal_bench_2_cache"
TARGET_DIR="${TERMINAL_BENCH_2_DIR:-$DEFAULT_TARGET_DIR}"
MIRROR_PREFIX="${GH_MIRROR_PREFIX:-http://ghfast.top/}"
UPSTREAM_REPO="https://github.com/laude-institute/terminal-bench-2"
CLONE_URL="${MIRROR_PREFIX}${UPSTREAM_REPO}"
TERMINAL_BENCH_2_REF="${TERMINAL_BENCH_2_REF:-53ff2b87d621bdb97b455671f2bd9728b7d86c11}"

if [ ! -d "${TARGET_DIR}" ]; then
  echo "Cloning Terminal-Bench-2 to ${TARGET_DIR}"
  git clone --depth 1 "${CLONE_URL}" "${TARGET_DIR}"
fi

echo "Checking out Terminal-Bench-2 pinned ref: ${TERMINAL_BENCH_2_REF}"
git -C "${TARGET_DIR}" fetch --depth 1 origin "${TERMINAL_BENCH_2_REF}"
git -C "${TARGET_DIR}" reset --hard FETCH_HEAD

echo "Terminal-Bench-2 ready: ${TARGET_DIR} @ ${TERMINAL_BENCH_2_REF}"
