from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "src"


def _run_python(code: str, *, cwd: Path) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    existing = env.get("PYTHONPATH")
    env["PYTHONPATH"] = str(SRC) if not existing else f"{SRC}{os.pathsep}{existing}"
    return subprocess.run(
        [sys.executable, "-c", code],
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


def test_web_app_import_ignores_local_typing_extensions(tmp_path: Path) -> None:
    (tmp_path / "typing_extensions.py").write_text("", encoding="utf-8")

    proc = _run_python(
        """
from kimi_cli.web.app import create_app
assert callable(create_app)
print("ok")
""",
        cwd=tmp_path,
    )

    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip() == "ok"
