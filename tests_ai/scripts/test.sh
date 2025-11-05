#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )

uv run kimi --yolo --agent-file "$SCRIPT_DIR/main.yaml" -c "$@"
