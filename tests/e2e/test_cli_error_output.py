"""E2E tests for CLI startup/argument error output."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from inline_snapshot import snapshot


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _run_kimi(args: list[str], *, share_dir: Path) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["KIMI_SHARE_DIR"] = str(share_dir)
    # Stabilize rich/Click formatting across environments for snapshot tests.
    env["COLUMNS"] = "120"
    env["LINES"] = "40"
    # Run via `python -m` to avoid `uv run kimi` build/progress output interfering with snapshots.
    cmd = [sys.executable, "-m", "kimi_cli.cli", *args]
    return subprocess.run(
        cmd,
        cwd=_repo_root(),
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
    )


def test_config_option_requires_argument_is_reported(tmp_path: Path) -> None:
    share_dir = tmp_path / "share"
    result = _run_kimi(["--config"], share_dir=share_dir)
    assert result.returncode == snapshot(2)
    assert result.stdout == snapshot("")
    assert result.stderr == snapshot(
        """\
╭─ Error ──────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
│ Option '--config' requires an argument.                                                                              │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
"""
    )


def test_config_option_help_value_is_reported(tmp_path: Path) -> None:
    share_dir = tmp_path / "share"
    result = _run_kimi(["--config", "--help"], share_dir=share_dir)
    assert result.returncode == snapshot(2)
    assert result.stdout == snapshot("")
    assert result.stderr == snapshot(
        """\
Usage: python -m kimi_cli.cli [OPTIONS] COMMAND [ARGS]...
Try 'python -m kimi_cli.cli -h' for help.
╭─ Error ──────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
│ Invalid value for --config: Invalid configuration text: Expecting value: line 1 column 1 (char 0); Unexpected        │
│ character: '\\x00' at line 1 col 6                                                                                    │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
"""
    )


def test_invalid_config_toml_is_reported(tmp_path: Path) -> None:
    share_dir = tmp_path / "share"
    config_path = tmp_path / "bad-config.toml"
    config_path.write_text("this is not toml =\n", encoding="utf-8")

    result = _run_kimi(
        ["--print", "--yolo", "--prompt", "hello", "--config-file", str(config_path)],
        share_dir=share_dir,
    )

    assert result.returncode == snapshot(1)
    assert result.stdout == snapshot("")
    assert result.stderr == snapshot(
        f"""\
Invalid TOML in configuration file {config_path}: Invalid key "this is not toml" at line 1 col 17
See logs: {share_dir}/logs/kimi.log
"""
    )


def test_continue_without_previous_session_is_reported(tmp_path: Path) -> None:
    share_dir = tmp_path / "share"
    work_dir = tmp_path / "work"
    work_dir.mkdir(parents=True, exist_ok=True)
    config_path = tmp_path / "config.json"
    config_path.write_text(
        '{"default_model":"","models":{},"providers":{}}',
        encoding="utf-8",
    )

    result = _run_kimi(
        [
            "--continue",
            "--print",
            "--yolo",
            "--prompt",
            "hello",
            "--config-file",
            str(config_path),
            "--work-dir",
            str(work_dir),
        ],
        share_dir=share_dir,
    )
    assert result.returncode == snapshot(2)
    assert result.stdout == snapshot("")
    assert result.stderr == snapshot(
        """\
Usage: python -m kimi_cli.cli [OPTIONS] COMMAND [ARGS]...
Try 'python -m kimi_cli.cli -h' for help.
╭─ Error ──────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
│ Invalid value for --continue: No previous session found for the working directory                                    │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
"""
    )
