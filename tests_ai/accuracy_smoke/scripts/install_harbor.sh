#!/usr/bin/env bash
set -euo pipefail

# Installs Harbor CLI in user space via uv.
# Keep this script under tests_ai/accuracy_smoke/scripts so benchmark tooling
# is co-located with benchmark cases.

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required but not found. Install uv first." >&2
  exit 1
fi

HARBOR_VERSION="${HARBOR_VERSION:-0.5.0}"

echo "Installing Harbor pinned version: ${HARBOR_VERSION}"
uv tool install --force "harbor==${HARBOR_VERSION}"
harbor --version
