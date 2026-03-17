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

  # The uv installer adds itself to ~/.local/bin (or $CARGO_HOME/bin)
  # but doesn't update the current shell's PATH. Source all available
  # env scripts and ensure the default location is on PATH.
  if [ -f "$HOME/.local/bin/env" ]; then
    . "$HOME/.local/bin/env"
  fi
  if [ -f "${CARGO_HOME:-$HOME/.cargo}/env" ]; then
    . "${CARGO_HOME:-$HOME/.cargo}/env"
  fi
  # Always add ~/.local/bin as fallback in case env scripts don't cover it
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) export PATH="$HOME/.local/bin:$PATH" ;;
  esac

  UV_BIN="uv"
fi

if ! command -v "$UV_BIN" >/dev/null 2>&1; then
  echo "Error: uv not found after installation." >&2
  exit 1
fi

"$UV_BIN" tool install --python 3.13 kimi-cli
