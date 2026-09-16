#!/usr/bin/env python3
"""Fail-closed HOL Guard gate for Kimi Code CLI Shell calls."""

import json
import shutil
import subprocess
import sys
from typing import Any

_GUARD_TIMEOUT_SECONDS = 8
_ALLOWED_DECISIONS = {"allow", "benign"}


def _block(reason: str) -> int:
    print(f"Blocked by HOL Guard: {reason}", file=sys.stderr)
    return 2


def evaluate(event: dict[str, Any]) -> int:
    if event.get("hook_event_name") != "PreToolUse" or event.get("tool_name") != "Shell":
        return 0

    tool_input = event.get("tool_input")
    if not isinstance(tool_input, dict):
        return _block("missing Shell tool input")
    command = tool_input.get("command")
    if not isinstance(command, str) or not command.strip():
        return _block("missing Shell command")

    executable = shutil.which("hol-guard")
    if not executable:
        return _block("hol-guard is not installed")

    try:
        completed = subprocess.run(
            [executable, "command", "test", command, "--json"],
            capture_output=True,
            text=True,
            timeout=_GUARD_TIMEOUT_SECONDS,
            check=False,
        )
        if completed.returncode != 0:
            return _block("Guard evaluation failed")
        verdict = json.loads(completed.stdout)
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError, ValueError):
        return _block("Guard evaluation failed")

    if not isinstance(verdict, dict):
        return _block("Guard returned malformed output")
    decision = str(verdict.get("decision", "")).lower()
    if decision in _ALLOWED_DECISIONS:
        return 0
    return _block(f"decision was {decision or 'unknown'}")


def main() -> int:
    try:
        event = json.load(sys.stdin)
        if not isinstance(event, dict):
            return _block("hook payload was not an object")
        return evaluate(event)
    except (json.JSONDecodeError, ValueError, TypeError):
        return _block("hook payload was invalid")
    except Exception:
        return _block("unexpected hook failure")


if __name__ == "__main__":
    raise SystemExit(main())
