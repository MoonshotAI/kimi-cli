#!/usr/bin/env bash
set -euo pipefail

install_uv() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL https://astral.sh/uv/install.sh | sh
    return
  fi

  if command -v wget >/dev/null 2>&1; then
    wget -qO- https://astral.sh/uv/install.sh | sh
    return
  fi

  echo "Error: curl or wget is required to install uv." >&2
  exit 1
}

if command -v uv >/dev/null 2>&1; then
  UV_BIN="uv"
else
  install_uv
  UV_BIN="uv"
fi

if ! command -v "$UV_BIN" >/dev/null 2>&1; then
  echo "Error: uv not found after installation." >&2
  exit 1
fi

"$UV_BIN" tool install --python 3.14 gitrekt-cli
