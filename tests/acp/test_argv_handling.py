"""Test sys.argv handling for login invocation preservation."""

import sys
from unittest.mock import patch


def test_argv_with_kimi_command():
    """Test when command ends with 'kimi'."""
    with patch.object(sys, "argv", ["kimi", "acp"]):
        # Simulate the logic from initialize method
        command = sys.argv[0]
        if command.endswith("kimi"):
            args = []
        else:
            try:
                idx = sys.argv.index("kimi")
                args = sys.argv[1 : idx + 1]
            except ValueError:
                try:
                    idx = sys.argv.index("-m")
                    if idx + 1 < len(sys.argv) and sys.argv[idx + 1] == "kimi_cli":
                        args = sys.argv[1 : idx + 2]
                    else:
                        args = []
                except ValueError:
                    args = []

        terminal_args = args + ["login"]
        assert command == "kimi"
        assert terminal_args == ["login"]


def test_argv_with_module_invocation():
    """Test when ACP is launched as python -m kimi_cli acp."""
    with patch.object(sys, "argv", ["python", "-m", "kimi_cli", "acp"]):
        # Simulate the logic from initialize method
        command = sys.argv[0]
        if command.endswith("kimi"):
            args = []
        else:
            try:
                idx = sys.argv.index("kimi")
                args = sys.argv[1 : idx + 1]
            except ValueError:
                try:
                    idx = sys.argv.index("-m")
                    if idx + 1 < len(sys.argv) and sys.argv[idx + 1] == "kimi_cli":
                        args = sys.argv[1 : idx + 2]
                    else:
                        args = []
                except ValueError:
                    args = []

        terminal_args = args + ["login"]
        assert command == "python"
        assert args == ["-m", "kimi_cli"]
        assert terminal_args == ["-m", "kimi_cli", "login"]


def test_argv_with_python_kimi():
    """Test when launched as python kimi acp."""
    with patch.object(sys, "argv", ["python", "kimi", "acp"]):
        # Simulate the logic from initialize method
        command = sys.argv[0]
        if command.endswith("kimi"):
            args = []
        else:
            try:
                idx = sys.argv.index("kimi")
                args = sys.argv[1 : idx + 1]
            except ValueError:
                try:
                    idx = sys.argv.index("-m")
                    if idx + 1 < len(sys.argv) and sys.argv[idx + 1] == "kimi_cli":
                        args = sys.argv[1 : idx + 2]
                    else:
                        args = []
                except ValueError:
                    args = []

        terminal_args = args + ["login"]
        assert command == "python"
        assert args == ["kimi"]
        assert terminal_args == ["kimi", "login"]


def test_argv_with_unknown_module():
    """Test when -m is used with unknown module."""
    with patch.object(sys, "argv", ["python", "-m", "unknown_module", "acp"]):
        # Simulate the logic from initialize method
        command = sys.argv[0]
        if command.endswith("kimi"):
            args = []
        else:
            try:
                idx = sys.argv.index("kimi")
                args = sys.argv[1 : idx + 1]
            except ValueError:
                try:
                    idx = sys.argv.index("-m")
                    if idx + 1 < len(sys.argv) and sys.argv[idx + 1] == "kimi_cli":
                        args = sys.argv[1 : idx + 2]
                    else:
                        args = []
                except ValueError:
                    args = []

        terminal_args = args + ["login"]
        assert command == "python"
        assert args == []
        assert terminal_args == ["login"]


def test_argv_with_other_args():
    """Test with additional arguments before module invocation."""
    with patch.object(sys, "argv", ["python", "-u", "-m", "kimi_cli", "acp"]):
        # Simulate the logic from initialize method
        command = sys.argv[0]
        if command.endswith("kimi"):
            args = []
        else:
            try:
                idx = sys.argv.index("kimi")
                args = sys.argv[1 : idx + 1]
            except ValueError:
                try:
                    idx = sys.argv.index("-m")
                    if idx + 1 < len(sys.argv) and sys.argv[idx + 1] == "kimi_cli":
                        args = sys.argv[1 : idx + 2]
                    else:
                        args = []
                except ValueError:
                    args = []

        terminal_args = args + ["login"]
        assert command == "python"
        assert args == ["-u", "-m", "kimi_cli"]
        assert terminal_args == ["-u", "-m", "kimi_cli", "login"]