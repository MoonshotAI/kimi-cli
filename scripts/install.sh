#!/usr/bin/env bash
set -euo pipefail

install_uv() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL https://astral.sh/uv/install.sh | sh
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- https://astral.sh/uv/install.sh | sh
  else
    echo "Error: curl or wget is required to install uv." >&2
    exit 1
  fi

  # The upstream uv installer writes ${XDG_BIN_HOME:-$HOME/.local/bin}/env and
  # prints "Run 'source ...' to add uv to your PATH" — but it does not source
  # the file itself. Source it here so the rest of THIS script (and the user's
  # immediate `kimi` invocation) can find uv on PATH.
  uv_env="${XDG_BIN_HOME:-$HOME/.local/bin}/env"
  if [ -f "$uv_env" ]; then
    # shellcheck disable=SC1090
    . "$uv_env"
  else
    # Fallback for older uv installers that may not write an env script.
    export PATH="${XDG_BIN_HOME:-$HOME/.local/bin}:$PATH"
  fi
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

"$UV_BIN" tool install --python 3.13 kimi-cli
