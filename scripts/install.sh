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

  # The upstream uv installer writes an env script at
  # ${XDG_BIN_HOME:-$HOME/.local/bin}/env and edits shell rc files for
  # future sessions, but does not modify PATH in the running shell.
  # Without sourcing it, the `command -v uv` check below fails on systems
  # where ~/.local/bin is not already on PATH (fresh containers, fresh
  # user accounts), and the script aborts with "uv not found after
  # installation". Source it so the rest of THIS script can find uv.
  local uv_env="${XDG_BIN_HOME:-$HOME/.local/bin}/env"
  if [ -f "$uv_env" ]; then
    # shellcheck disable=SC1090
    . "$uv_env"
  else
    # Fallback for older uv installers that don't write an env script.
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

# uv installs `kimi` into ${XDG_BIN_HOME:-$HOME/.local/bin}. If that directory
# is not on the user's interactive-shell PATH yet, `kimi` will appear missing
# until they restart their shell or source the env script. Print the hint so
# they don't conclude the install silently failed.
kimi_bin_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"
echo
echo "Installed kimi to $kimi_bin_dir/kimi."
echo "If 'kimi' is not found, restart your shell, or run:"
echo "    . \"$kimi_bin_dir/env\""
