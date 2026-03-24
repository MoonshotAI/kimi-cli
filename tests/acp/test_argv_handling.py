"""Test sys.argv handling for login invocation preservation."""

import sys
from unittest.mock import patch


def _simulate_argv_logic(argv: list[str]) -> tuple[str, list[str]]:
    """Simulate the argv handling logic from ACPServer.initialize."""
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
    """Test when kimi is not in argv and no __main__.py."""
    command, terminal_args = _simulate_argv_logic(["some_other_cmd", "acp"])
    assert command == "some_other_cmd"
    assert terminal_args == ["login"]


def test_argv_with_relative_main_module():
    """Test with relative __main__.py path."""
    command, terminal_args = _simulate_argv_logic(["kimi_cli/__main__.py", "acp"])
    assert command == "python"
    assert terminal_args == ["-m", "kimi_cli", "login"]
