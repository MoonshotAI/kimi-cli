from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "src"


def _run_python(code: str) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    existing = env.get("PYTHONPATH")
    env["PYTHONPATH"] = str(SRC) if not existing else f"{SRC}{os.pathsep}{existing}"
    return subprocess.run(
        [sys.executable, "-c", code],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )


def test_import_kimi_cli_does_not_import_loguru() -> None:
    proc = _run_python(
        """
import sys
sys.modules.pop("loguru", None)
import kimi_cli
assert "loguru" not in sys.modules
print("ok")
"""
    )
    assert proc.stdout.strip() == "ok"


def test_logger_proxy_imports_loguru_on_first_use() -> None:
    proc = _run_python(
        """
import sys
sys.modules.pop("loguru", None)
from kimi_cli import logger
assert "loguru" not in sys.modules
logger.disable("unit.test")
assert "loguru" in sys.modules
print("ok")
"""
    )
    assert proc.stdout.strip() == "ok"


def test_import_kimi_cli_constant_defers_package_metadata() -> None:
    proc = _run_python(
        """
import sys
sys.modules.pop("importlib.metadata", None)
import kimi_cli.constant as constant
assert "importlib.metadata" not in sys.modules
assert constant.get_version()
assert "importlib.metadata" in sys.modules
print("ok")
"""
    )
    assert proc.stdout.strip() == "ok"


def test_root_help_lists_lazy_subcommands_without_importing_them() -> None:
    proc = _run_python(
        """
import sys
from typer.testing import CliRunner

lazy_modules = [
    "kimi_cli.cli.info",
    "kimi_cli.cli.export",
    "kimi_cli.cli.mcp",
    "kimi_cli.cli.vis",
    "kimi_cli.cli.web",
]
for name in lazy_modules:
    sys.modules.pop(name, None)

from kimi_cli.cli import cli

assert all(name not in sys.modules for name in lazy_modules)

result = CliRunner().invoke(cli, ["--help"])
assert result.exit_code == 0, result.output
for name in ("info", "export", "mcp", "vis", "web"):
    assert name in result.output
assert all(name not in sys.modules for name in lazy_modules)
print("ok")
"""
    )
    assert proc.stdout.strip() == "ok"


def test_info_subcommand_loads_on_demand() -> None:
    proc = _run_python(
        """
import sys
from typer.testing import CliRunner

lazy_modules = [
    "kimi_cli.cli.info",
    "kimi_cli.cli.export",
    "kimi_cli.cli.mcp",
    "kimi_cli.cli.vis",
    "kimi_cli.cli.web",
]
for name in lazy_modules:
    sys.modules.pop(name, None)

from kimi_cli.cli import cli

result = CliRunner().invoke(cli, ["info", "--json"])
assert result.exit_code == 0, result.output
assert '"kimi_cli_version"' in result.output
assert "kimi_cli.cli.info" in sys.modules
assert "kimi_cli.cli.export" not in sys.modules
assert "kimi_cli.cli.mcp" not in sys.modules
assert "kimi_cli.cli.vis" not in sys.modules
assert "kimi_cli.cli.web" not in sys.modules
print("ok")
"""
    )
    assert proc.stdout.strip() == "ok"


def test_package_entrypoint_fast_path_avoids_cli_import() -> None:
    proc = _run_python(
        """
import io
import sys
from contextlib import redirect_stdout

sys.modules.pop("kimi_cli.cli", None)

from kimi_cli.__main__ import main

stdout = io.StringIO()
with redirect_stdout(stdout):
    exit_code = main(["--version"])

assert exit_code == 0
assert stdout.getvalue().startswith("kimi, version ")
assert "kimi_cli.cli" not in sys.modules
print("ok")
"""
    )
    assert proc.stdout.strip() == "ok"


def test_package_entrypoint_falls_back_to_cli_for_commands() -> None:
    proc = _run_python(
        """
import io
import json
import sys
from contextlib import redirect_stdout

sys.modules.pop("kimi_cli.cli", None)

from kimi_cli.__main__ import main

stdout = io.StringIO()
with redirect_stdout(stdout):
    exit_code = main(["info", "--json"])

assert exit_code in (None, 0)
assert "kimi_cli.cli" in sys.modules
payload = json.loads(stdout.getvalue())
assert payload["kimi_cli_version"]
print("ok")
"""
    )
    assert proc.stdout.strip() == "ok"


def test_cli_module_entrypoint_handles_git_bash_not_found() -> None:
    proc = _run_python(
        """
import io
import sys
from contextlib import redirect_stderr

import kimi_cli.cli.__main__ as cli_main
from kimi_cli.utils.environment import GitBashNotFoundError

def fake_cli(*_args, **_kwargs):
    raise GitBashNotFoundError("install Git for Windows")

cli_main.cli = fake_cli

stderr = io.StringIO()
with redirect_stderr(stderr):
    exit_code = cli_main.main(["--print", "hello"])

assert exit_code == 1
assert stderr.getvalue() == "Error: install Git for Windows\\n"
print("ok")
"""
    )
    assert proc.stdout.strip() == "ok"
