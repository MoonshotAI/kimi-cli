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
