from __future__ import annotations

from kaos.path import KaosPath

from kimi_cli.soul.approval import Approval
from kimi_cli.tools.shell import Shell
from kimi_cli.utils.environment import Environment


def test_shell_args_for_bash() -> None:
    shell = Shell(
        Approval(yolo=True),
        Environment(
            os_kind="Unix",
            os_arch="aarch64",
            os_version="1.0",
            shell_name="bash",
            shell_path=KaosPath("/bin/bash"),
        ),
    )

    assert shell.shell_args("echo test") == ("/bin/bash", "-c", "echo test")


def test_shell_args_for_powershell() -> None:
    shell = Shell(
        Approval(yolo=True),
        Environment(
            os_kind="Windows",
            os_arch="x86_64",
            os_version="1.0",
            shell_name="Windows PowerShell",
            shell_path=KaosPath("powershell.exe"),
        ),
    )

    assert shell.shell_args("echo test") == ("powershell.exe", "-command", "echo test")
