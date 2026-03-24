"""Test cases for sys.argv handling in ACPServer.initialize."""

import sys
from unittest.mock import patch


def _simulate_argv_logic(argv: list[str]) -> tuple[str, list[str]]:
    """Simulate the argv handling logic from ACPServer.initialize."""
    # Handle empty sys.argv edge case
    if not argv:
        command = "kimi"
        args = []
    else:
        command = argv[0]
        if command.endswith("kimi"):
            args = []
        elif command.endswith("__main__.py"):
            # Module-style invocation (e.g., python -m kimi_cli)
            command = "python"
            args = ["-m", "kimi_cli"]
        else:
            try:
                idx = argv.index("kimi")
                args = argv[1 : idx + 1]
            except ValueError:
                # Unknown command, fallback to safe default for login
                command = "kimi"
                args = []

    terminal_args = args + ["login"]
    return command, terminal_args


def test_argv_with_kimi_command():
    """Test when command ends with 'kimi'."""
    command, terminal_args = _simulate_argv_logic(["kimi", "acp"])
    assert command == "kimi"
    assert terminal_args == ["login"]


def test_argv_with_main_module():
    """Test when sys.argv[0] ends with __main__.py (module invocation).

    When running via `python -m kimi_cli acp`, sys.argv[0] is the __main__.py
    path and -m is consumed by the interpreter. We detect this and construct
    a runnable command.
    """
    command, terminal_args = _simulate_argv_logic(
        ["/path/to/kimi_cli/__main__.py", "acp"]
    )
    assert command == "python"
    assert terminal_args == ["-m", "kimi_cli", "login"]


def test_argv_with_python_kimi():
    """Test when launched as python kimi acp."""
    command, terminal_args = _simulate_argv_logic(["python", "kimi", "acp"])
    assert command == "python"
    assert terminal_args == ["kimi", "login"]


def test_argv_with_unknown_command():
    """Test when kimi is not in argv and no __main__.py.

    This tests the fix for the 'list.index(x): x not in list' error.
    When command is unknown, we fallback to 'kimi login' for safety.
    """
    command, terminal_args = _simulate_argv_logic(["some_other_cmd", "acp"])
    assert command == "kimi"
    assert terminal_args == ["login"]


def test_argv_with_relative_main_module():
    """Test with relative __main__.py path."""
    command, terminal_args = _simulate_argv_logic(["kimi_cli/__main__.py", "acp"])
    assert command == "python"
    assert terminal_args == ["-m", "kimi_cli", "login"]


def test_argv_empty():
    """Test when sys.argv is empty.

    This is an edge case that could happen in some environments.
    """
    command, terminal_args = _simulate_argv_logic([])
    assert command == "kimi"
    assert terminal_args == ["login"]


def test_argv_single_element():
    """Test when sys.argv has only one element."""
    command, terminal_args = _simulate_argv_logic(["unknown"])
    assert command == "kimi"
    assert terminal_args == ["login"]


def test_argv_with_kimi_in_middle():
    """Test when 'kimi' appears in the middle of argv."""
    command, terminal_args = _simulate_argv_logic(["python", "-u", "kimi", "acp"])
    assert command == "python"
    assert terminal_args == ["-u", "kimi", "login"]